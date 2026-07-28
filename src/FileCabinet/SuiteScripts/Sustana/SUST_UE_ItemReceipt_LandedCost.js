/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */

/**
 * SUST_UE_ItemReceipt_LandedCost.js
 *
 * v2 (June 2026): Landed cost auto-rollup on Item Receipt (CROSS-014).
 *
 * For each IR line where the operator populated the Index Base component
 * (the signal that this line uses landed-cost decomposition), this UE
 * sums all four landed-cost components and sets the IR line rate to
 * that total — making the IR rate (which drives inventory valuation)
 * reflect the full landed cost.
 *
 *   landed cost per lb = index_base + premium + freight + financing_insurance
 *
 * If Index Base is empty on a line, the line is skipped (intentional $0
 * scenarios like Post-Processing pricing-timing mode work correctly).
 *
 * Subsidiary-gated via configurable script parameter.
 *
 * Author: Sustana Dev Team
 * Date: June 2026 (v2)
 */

define(['N/record', 'N/search', 'N/runtime', 'N/log', 'N/ui/serverWidget', './SUST_Lib_Config'],
    function(record, search, runtime, log, serverWidget, configLib) {
        /**
         * Demo-friendly subsidiary gate: the transaction subsidiary must match the
         * script parameter (if set) or either configured demo subsidiary (US/CA).
         * Returns false (skip) when nothing is configured.
         */
        function subsidiaryAllowed(subsidiaryId, paramName) {
            const paramVal = runtime.getCurrentScript().getParameter({ name: paramName });
            const cfg = configLib.getConfig();
            const allowed = [paramVal, cfg.usSubsidiary, cfg.caSubsidiary]
                .filter(Boolean).map(String);
            if (allowed.length === 0) {
                log.audit('Configuration Missing',
                    paramName + ' not set and no Sustana Config subsidiaries — skipping. Run SUST_SL_SeedSustanaDemo.');
                return false;
            }
            return allowed.indexOf(String(subsidiaryId)) !== -1;
        }


        const COMPONENTS = [
            'custcol_sust_index_base',
            'custcol_sust_premium',
            'custcol_sust_freight',
            'custcol_sust_financing_insurance'
        ];

        /**
         * beforeSubmit — compute landed-cost rate per line.
         */
        function beforeSubmit(context) {
            try {
                // No-scale receiving: Net = Gross − Tare when Net wasn't keyed.
                try {
                    const recNW = context.newRecord;
                    const nLines = recNW.getLineCount({ sublistId: 'item' });
                    for (let li = 0; li < nLines; li++) {
                        const g = parseFloat(recNW.getSublistValue({ sublistId: 'item', fieldId: 'custcol_sust_scrap_gross_weight', line: li })) || 0;
                        const t = parseFloat(recNW.getSublistValue({ sublistId: 'item', fieldId: 'custcol_sust_scrap_tare_weight', line: li })) || 0;
                        const n = parseFloat(recNW.getSublistValue({ sublistId: 'item', fieldId: 'custcol_sust_scrap_net_weight', line: li })) || 0;
                        if (g > 0 && t > 0 && !n) {
                            const net = Math.max(g - t, 0);
                            recNW.setSublistValue({ sublistId: 'item', fieldId: 'custcol_sust_scrap_net_weight', line: li, value: net });
                            log.audit('Net from Gross−Tare', 'Line ' + (li + 1) + ': ' + g + ' − ' + t + ' = ' + net + ' lbs');
                        }
                    }
                } catch (eNet) {
                    log.debug('net-from-tare skipped', eNet.message);
                }

                if (context.type !== context.UserEventType.CREATE &&
                    context.type !== context.UserEventType.EDIT) {
                    return;
                }
                if (!isSustanaSubsidiary(context.newRecord)) return;

                const newRec = context.newRecord;
                const lineCount = newRec.getLineCount({ sublistId: 'item' });
                const updated = [];

                for (let i = 0; i < lineCount; i++) {
                    const indexBase = toNumber(newRec.getSublistValue({
                        sublistId: 'item', fieldId: 'custcol_sust_index_base', line: i
                    }));

                    // Signal: if Index Base isn't set, operator isn't using landed-cost
                    // decomposition on this line. Skip — leave the rate alone.
                    if (indexBase === null || indexBase === 0) continue;

                    const premium = toNumber(newRec.getSublistValue({
                        sublistId: 'item', fieldId: 'custcol_sust_premium', line: i
                    })) || 0;
                    const freight = toNumber(newRec.getSublistValue({
                        sublistId: 'item', fieldId: 'custcol_sust_freight', line: i
                    })) || 0;
                    const financing = toNumber(newRec.getSublistValue({
                        sublistId: 'item', fieldId: 'custcol_sust_financing_insurance', line: i
                    })) || 0;

                    const total = round4(indexBase + premium + freight + financing);

                    // Set the IR line rate to the computed total (drives inventory valuation)
                    try {
                        newRec.setSublistValue({
                            sublistId: 'item',
                            fieldId: 'rate',
                            line: i,
                            value: total
                        });
                        updated.push({
                            line: i + 1,
                            base: indexBase, premium: premium, freight: freight, financing: financing,
                            total: total
                        });
                    } catch (e) {
                        log.error('Rate Update Failed',
                            `Line ${i + 1}: could not set rate to ${total} — ${e.message}`);
                    }
                }

                if (updated.length > 0) {
                    log.audit('Landed Cost Auto-Roll',
                        `${updated.length} line(s) updated:\n${JSON.stringify(updated, null, 2)}`);
                }

                // Provisional-value mandate — "nothing on the books at zero".
                // Scrap receives at the PO estimate via NetSuite's native PO->IR rate carry; per the
                // locked decision the provisional value = the PO rate. We do NOT invent a value here
                // (that was the rejected option). Instead, surface any Sustana Recovery scrap line still at $0
                // so a missing PO estimate is auditable rather than silently capitalizing at zero.
                const zeroScrapLines = [];
                for (let i = 0; i < lineCount; i++) {
                    const rate = toNumber(newRec.getSublistValue({ sublistId: 'item', fieldId: 'rate', line: i }));
                    if (rate !== null && rate !== 0) continue; // has a value — fine
                    const itemId = newRec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
                    if (!itemId) continue;
                    if (isScrapItem(itemId)) zeroScrapLines.push(i + 1);
                }
                if (zeroScrapLines.length > 0) {
                    log.audit('Provisional Value Missing',
                        `Recovered material received at $0 on line(s) ${zeroScrapLines.join(', ')}. ` +
                        `Set a provisional estimate (rate) on the originating PO line so inventory carries a value ` +
                        `at receipt (v2.3-E provisional-value policy). The settlement trues it up to the final value.`);
                }

            } catch (e) {
                log.error('SUST_UE_ItemReceipt_LandedCost.beforeSubmit failed', e.message);
            }
        }

        /**
         * beforeLoad — render guidance banner on the IR form.
         */
        function beforeLoad(context) {
            try {
                if (context.type !== context.UserEventType.VIEW &&
                    context.type !== context.UserEventType.EDIT) {
                    return;
                }
                if (!isSustanaSubsidiary(context.newRecord)) return;

                const html = ''
                    + '<div style="border: 2px solid #4f46e5; background: #e0e7ff; color: #312e81;'
                    + ' padding: 10px 14px; margin: 8px 0; border-radius: 6px; font-family: Arial, sans-serif; font-size: 12px;">'
                    + '  <strong>Landed Cost decomposition:</strong> populate Index Base + Premium + Freight + Financing/Insurance per line.'
                    + ' On save, the line rate auto-rolls to Index Base + Premium + Freight + Financing. Leave Index Base blank/zero to skip this on a line.'
                    + '<br><strong>Provisional value:</strong> material is capitalized at the line rate (carried from the PO estimate) at receipt.'
                    + ' For recovery-priced (Determined After Processing) lines, make sure the PO line carries a provisional estimate so inventory is not received at $0 — the settlement trues it up to the final value.'
                    + '</div>';

                const fld = context.form.addField({
                    id: 'custpage_landed_cost_help',
                    type: serverWidget.FieldType.INLINEHTML,
                    label: 'Landed Cost Help'
                });
                fld.defaultValue = html;

            } catch (e) {
                log.error('SUST_UE_ItemReceipt_LandedCost.beforeLoad failed', e.message);
            }
        }

        // ───────────────────────────────────────────────────────────────────────
        // Helpers
        // ───────────────────────────────────────────────────────────────────────

        function isSustanaSubsidiary(rec) {
            return subsidiaryAllowed(rec.getValue({ fieldId: 'subsidiary' }), 'custscript_sust_sub_id_landed');
        }

        function toNumber(v) {
            if (v === null || v === undefined || v === '') return null;
            const n = parseFloat(v);
            return isNaN(n) ? null : n;
        }

        function round4(n) {
            return Math.round(n * 10000) / 10000;
        }

        function isScrapItem(itemId) {
            try {
                const lk = search.lookupFields({
                    type: search.Type.ITEM, id: itemId, columns: ['custitem_sust_is_scrap_material']
                });
                return lk.custitem_sust_is_scrap_material === true || lk.custitem_sust_is_scrap_material === 'T';
            } catch (e) {
                return false;
            }
        }

        return {
            beforeLoad: beforeLoad,
            beforeSubmit: beforeSubmit
        };
    });
