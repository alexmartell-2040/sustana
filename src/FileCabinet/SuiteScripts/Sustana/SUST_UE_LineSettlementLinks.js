/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */

/**
 * SUST_UE_LineSettlementLinks.js
 *
 * v2.3 (June 2026): Line-level settlement/processing links + on-demand creation button
 * on Purchase Orders and Item Receipts (Sustana Recovery subsidiary).
 *
 * beforeLoad:
 *   - VIEW + EDIT: populate the per-line columns custcol_sust_settlement_id and
 *     custcol_sust_processing_id for display, from the settlement/processing records anchored
 *     to each scrap line of this document (one search each, mapped by source line key).
 *   - VIEW: add a "Create / Manage Line Settlements" button (INLINEHTML link to
 *     SUST_SL_CreateLineSettlement). Uses INLINEHTML rather than form.addButton so it does
 *     not collide with the existing IR button client script (SUST_CS_ItemReceiptButtons).
 *
 * Param: custscript_sust_line_links_sub_id (Sustana Recovery subsidiary internal id).
 *
 * Known limitation (v2.3): column display is per-document. A settlement created from a PO
 * line shows on the PO; once received, the IR line uses the IR's own line key, so the PO-
 * created settlement is not mirrored onto the IR column. The settlement record itself
 * always carries both the PO and (once received) IR links. Cross-document line mirroring
 * is a follow-up pending runtime validation of PO->IR line-key behavior.
 */

define(['N/search', 'N/url', 'N/runtime', 'N/log', './SUST_Lib_Config'],
    function(search, url, runtime, log, configLib) {
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


        const SUITELET_SCRIPT = 'customscript_sust_sl_create_settlement';
        const SUITELET_DEPLOY = 'customdeploy_sust_sl_create_settlement';

        function beforeLoad(context) {
            try {
                if (context.type !== context.UserEventType.VIEW &&
                    context.type !== context.UserEventType.EDIT) {
                    return;
                }

                const rec = context.newRecord;
                const recType = rec.type; // 'purchaseorder' or 'itemreceipt'
                const isPO = (recType === 'purchaseorder');
                const isIR = (recType === 'itemreceipt');
                if (!isPO && !isIR) return;

                // Subsidiary gate (script param or configured demo subsidiaries)
                const subId = rec.getValue({ fieldId: 'subsidiary' });
                if (!subsidiaryAllowed(subId, 'custscript_sust_line_links_sub_id')) return;

                const txnId = rec.id;
                const poId = isPO ? txnId : (rec.getValue({ fieldId: 'createdfrom' }) || null);

                // Build line-key -> settlement id map (same-document anchor)
                const settlementMap = buildMap(
                    'customrecord_sust_settlement_record',
                    isIR ? [['custrecord_sust_settlement_item_receipt', 'anyof', txnId]]
                         : [['custrecord_sust_settle_po', 'anyof', txnId]],
                    'custrecord_sust_settle_source_line'
                );

                // Build line-key -> processing id map. Processing records store their source
                // transaction in custrecord_sust_processing_po (this is the IR when created via the
                // Process Scrap flow) and the IR line key in custrecord_sust_proc_source_line, so match
                // on the current document's id. (v2.3-C)
                const processingMap = buildMap(
                    'customrecord_sust_processing_record',
                    [['custrecord_sust_processing_po', 'anyof', txnId]],
                    'custrecord_sust_proc_source_line'
                );

                // Collect per-line links (key = 1-based sublist index, matching the create
                // side) and best-effort-populate the columns. NetSuite drops setSublistValue
                // on the item sublist in VIEW, so the INLINEHTML panel below is authoritative.
                const lineCount = rec.getLineCount({ sublistId: 'item' });
                const linkRows = [];
                for (let i = 0; i < lineCount; i++) {
                    const lineKey = i + 1;
                    const settleId = settlementMap[lineKey] || null;
                    const procId = processingMap[lineKey] || null;
                    if (!settleId && !procId) continue;
                    if (settleId) trySetSublist(rec, 'custcol_sust_settlement_id', i, settleId);
                    if (procId) trySetSublist(rec, 'custcol_sust_processing_id', i, procId);
                    linkRows.push({
                        line: lineKey,
                        item: rec.getSublistText({ sublistId: 'item', fieldId: 'item', line: i }) || ('Line ' + lineKey),
                        settleId: settleId,
                        procId: procId
                    });
                }

                // Add the on-demand creation button (VIEW only)
                if (context.type === context.UserEventType.VIEW && context.form) {
                    const slUrl = url.resolveScript({
                        scriptId: SUITELET_SCRIPT,
                        deploymentId: SUITELET_DEPLOY,
                        params: { txn: txnId, type: isPO ? 'po' : 'ir' }
                    });
                    const field = context.form.addField({
                        id: 'custpage_manage_settlements',
                        type: 'inlinehtml',
                        label: 'Settlements'
                    });
                    field.defaultValue =
                        `<div style="margin:6px 0;">
                           <a href="${slUrl}"
                              style="display:inline-block;padding:7px 14px;background:#2976F3;color:#fff;
                                     text-decoration:none;border-radius:4px;font-weight:600;font-size:12px;">
                             Create / Manage Line Settlements
                           </a>
                         </div>`;

                    // Authoritative display of the per-line links (the item-sublist columns
                    // are best-effort only — NetSuite does not paint them from beforeLoad in VIEW).
                    const panel = context.form.addField({
                        id: 'custpage_line_links_panel',
                        type: 'inlinehtml',
                        label: 'Line Settlements'
                    });
                    panel.defaultValue = buildLinksPanel(linkRows);
                }

            } catch (e) {
                log.error('beforeLoad', e.toString() + '\n' + (e.stack || ''));
            }
        }

        /**
         * Build a { sourceLineKey: recordId } map from a custom-record search.
         */
        function buildMap(recordType, filters, lineFieldId) {
            const map = {};
            try {
                const s = search.create({
                    type: recordType,
                    filters: filters,
                    columns: ['internalid', lineFieldId]
                });
                s.run().each(function(result) {
                    const key = result.getValue(lineFieldId);
                    if (key !== null && key !== '' && key !== undefined) {
                        map[parseInt(key, 10)] = result.getValue('internalid') || result.id;
                    }
                    return true;
                });
            } catch (e) {
                log.error('buildMap', `${recordType}: ${e.toString()}`);
            }
            return map;
        }

        function trySetSublist(rec, fieldId, line, value) {
            try {
                rec.setSublistValue({ sublistId: 'item', fieldId: fieldId, line: line, value: value });
            } catch (e) {
                // Column display set is best-effort; never block the form load.
                log.debug('trySetSublist skipped', `${fieldId} line ${line}: ${e.message}`);
            }
        }

        /**
         * Render the per-line settlement/processing links as an INLINEHTML table.
         * This is the reliable display (the item-sublist columns are not paintable
         * from beforeLoad in VIEW mode).
         */
        function buildLinksPanel(linkRows) {
            const recLink = function(recType, id, label) {
                try {
                    const u = url.resolveRecord({ recordType: recType, recordId: id });
                    return `<a href="${u}" style="color:#2976F3;">${label} #${id}</a>`;
                } catch (e) {
                    return `${label} #${id}`;
                }
            };
            if (!linkRows.length) {
                return `<div style="margin:4px 0 12px;color:#64748b;font-size:12px;font-family:Arial,sans-serif;">
                          No line settlements or processing records yet — use <b>Create / Manage Line Settlements</b> above.
                        </div>`;
            }
            const dash = '<span style="color:#94a3b8;">&mdash;</span>';
            const body = linkRows.map(function(r) {
                const s = r.settleId ? recLink('customrecord_sust_settlement_record', r.settleId, 'Settlement') : dash;
                const p = r.procId ? recLink('customrecord_sust_processing_record', r.procId, 'Processing') : dash;
                return `<tr>
                          <td style="padding:4px 10px;border-bottom:1px solid #e5e7eb;">${r.line}</td>
                          <td style="padding:4px 10px;border-bottom:1px solid #e5e7eb;">${escapeHtml(r.item)}</td>
                          <td style="padding:4px 10px;border-bottom:1px solid #e5e7eb;">${s}</td>
                          <td style="padding:4px 10px;border-bottom:1px solid #e5e7eb;">${p}</td>
                        </tr>`;
            }).join('');
            return `<div style="margin:4px 0 12px;font-family:Arial,sans-serif;font-size:12px;">
                      <div style="font-weight:600;color:#1f5fcc;margin-bottom:4px;">Line Settlements &amp; Processing</div>
                      <table style="border-collapse:collapse;border:1px solid #cbd5e1;min-width:440px;">
                        <thead><tr style="background:#2976F3;color:#fff;">
                          <th style="padding:5px 10px;text-align:left;">Line</th>
                          <th style="padding:5px 10px;text-align:left;">Item</th>
                          <th style="padding:5px 10px;text-align:left;">Settlement</th>
                          <th style="padding:5px 10px;text-align:left;">Processing</th>
                        </tr></thead>
                        <tbody>${body}</tbody>
                      </table>
                    </div>`;
        }

        function escapeHtml(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
        }

        return { beforeLoad: beforeLoad };

    });
