/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */

/**
 * SUST_UE_Processing_DerivedFields.js
 *
 * v2 (June 2026): Sustana Recovery WIP/processing derived field calculator
 * and true-net-weight bridge.
 *
 * On save, computes:
 *   - True Net = Gross Input − Tare Actual (PROC-004)
 *   - Total Output = sum of output_line weights
 *   - Yield % = Total Output ÷ True Net × 100 (PROC-005); loss = residual + moisture
 *   - Per-output-line weight_pct = line_weight ÷ total_output × 100
 *   - Per-output-line allocated_cost = total_input_cost × weight_pct (PROC-007)
 *   - Per-output-line cost_per_lb = allocated_cost ÷ output_weight
 *
 * On afterSubmit, if True Net is set, optionally propagates back to the
 * source receiver lot's notes for audit. (Full quantity true-up via
 * Inventory Adjustment is handled by SUST_UE_Processing_CreateInvAdj —
 * Chunk Q refactor.)
 *
 * Author: Sustana Dev Team
 * Date: June 2026 (v2)
 */

define(['N/record', 'N/search', 'N/runtime', 'N/log', 'N/ui/serverWidget', './SUST_Lib_Units'],
    function(record, search, runtime, log, serverWidget, units) {

        const YIELD_LOSS_WARN_PCT = 2.0; // soft warn outside 100% ± 2%
        const YIELD_LOSS_RED_PCT = 5.0;  // red banner threshold

        /**
         * beforeLoad — render a colored yield / loss status banner.
         * Stored weights are POUNDS; the banner displays TONS.
         */
        function beforeLoad(context) {
            try {
                if (context.type !== context.UserEventType.VIEW &&
                    context.type !== context.UserEventType.EDIT) {
                    return;
                }

                const rec = context.newRecord;
                const yieldPct = toNum(rec.getValue({ fieldId: 'custrecord_sust_proc_mass_balance_pct' }));
                const trueNet = toNum(rec.getValue({ fieldId: 'custrecord_sust_proc_true_net_lbs' }));
                const totalOutput = toNum(rec.getValue({ fieldId: 'custrecord_sust_proc_total_output_lbs' }));

                let title, body, bgColor, borderColor, textColor;

                if (yieldPct === null || trueNet === null || totalOutput === null) {
                    title = '— Yield / Loss Not Yet Computed';
                    body = 'Set Gross Input + Tare Actual to compute True Net, then add output lines for weight totals. Yield / loss auto-calculates on save.';
                    bgColor = '#f3f4f6'; borderColor = '#9ca3af'; textColor = '#1f2937';
                } else {
                    const lossLine = 'Moisture / shrink loss: ' + units.formatTons(trueNet - totalOutput) + ' (weight not in any output line).';
                    const deltaFromPerfect = Math.abs(yieldPct - 100);
                    if (deltaFromPerfect <= YIELD_LOSS_WARN_PCT) {
                        title = '✓ Yield: ' + yieldPct + '% (within ±' + YIELD_LOSS_WARN_PCT + '%)';
                        body = 'Output (' + units.formatTons(totalOutput) + ') close to True Net (' + units.formatTons(trueNet) + '). ' + lossLine + ' Yield acceptable.';
                        bgColor = '#d1fae5'; borderColor = '#059669'; textColor = '#064e3b';
                    } else if (deltaFromPerfect <= YIELD_LOSS_RED_PCT) {
                        title = '⚠ Yield: ' + yieldPct + '% (variance ' + round2(deltaFromPerfect) + '%)';
                        body = 'Output (' + units.formatTons(totalOutput) + ') vs True Net (' + units.formatTons(trueNet) + '). ' + lossLine + ' Variance acceptable per current threshold but worth a look — possibly minor measurement or process loss.';
                        bgColor = '#fef3c7'; borderColor = '#d97706'; textColor = '#78350f';
                    } else {
                        title = '✗ Yield: ' + yieldPct + '% (variance ' + round2(deltaFromPerfect) + '%)';
                        body = 'Output (' + units.formatTons(totalOutput) + ') vs True Net (' + units.formatTons(trueNet) + ') — significant variance. ' + lossLine + ' Check tare measurement, output line weights, and shrinkage allocation. Material may be unaccounted for.';
                        bgColor = '#fee2e2'; borderColor = '#dc2626'; textColor = '#7f1d1d';
                    }
                }

                const html = ''
                    + '<div style="border: 2px solid ' + borderColor + '; background: ' + bgColor + '; color: ' + textColor + ';'
                    + ' padding: 12px 16px; margin: 10px 0; border-radius: 6px; font-family: Arial, sans-serif;">'
                    + '  <div style="font-weight: bold; font-size: 14px; margin-bottom: 4px;">'
                    +      escapeHtml(title)
                    + '  </div>'
                    + '  <div style="font-size: 13px;">'
                    +      escapeHtml(body)
                    + '  </div>'
                    + '</div>';

                const fld = context.form.addField({
                    id: 'custpage_yield_loss_banner',
                    type: serverWidget.FieldType.INLINEHTML,
                    label: 'Yield / Loss Status'
                });
                fld.defaultValue = html;

            } catch (e) {
                log.error('SUST_UE_Processing_DerivedFields.beforeLoad failed', e.message);
            }
        }

        function beforeSubmit(context) {
            try {
                if (context.type !== context.UserEventType.CREATE &&
                    context.type !== context.UserEventType.EDIT) {
                    return;
                }

                const rec = context.newRecord;
                const recId = rec.id;

                // 1. Compute True Net = Gross − Tare Actual
                const gross = toNum(rec.getValue({ fieldId: 'custrecord_sust_proc_gross_input_lbs' }));
                const tareActual = toNum(rec.getValue({ fieldId: 'custrecord_sust_proc_tare_actual_lbs' }));

                let trueNet = null;
                if (gross !== null && tareActual !== null) {
                    trueNet = round4(gross - tareActual);
                    rec.setValue({ fieldId: 'custrecord_sust_proc_true_net_lbs', value: trueNet });
                } else {
                    // Fall back to the keyed Input Weight when the scale-reconciliation
                    // fields (Gross/Tare) aren't used — and PERSIST it, so the yield
                    // banner (which reads the stored True Net) doesn't claim nothing
                    // was computed.
                    const legacyInputLbs = toNum(rec.getValue({ fieldId: 'custrecord_sust_processing_input_lbs' }));
                    if (legacyInputLbs !== null) {
                        trueNet = legacyInputLbs;
                        rec.setValue({ fieldId: 'custrecord_sust_proc_true_net_lbs', value: round4(legacyInputLbs) });
                    }
                }

                // 2. Sum output line weights (only meaningful on EDIT — output lines exist)
                let totalOutput = null;
                let outputLines = [];
                if (recId) {
                    outputLines = loadOutputLines(recId);
                    totalOutput = outputLines.reduce(function(acc, ol) {
                        return acc + (ol.weight || 0);
                    }, 0);
                    rec.setValue({ fieldId: 'custrecord_sust_proc_total_output_lbs', value: round4(totalOutput) });
                }

                // 3. Yield % (loss = residual + moisture)
                if (trueNet !== null && trueNet > 0 && totalOutput !== null && totalOutput > 0) {
                    const yieldPct = round2((totalOutput / trueNet) * 100);
                    rec.setValue({ fieldId: 'custrecord_sust_proc_mass_balance_pct', value: yieldPct });

                    const deltaFromPerfect = Math.abs(yieldPct - 100);
                    if (deltaFromPerfect > YIELD_LOSS_WARN_PCT) {
                        log.audit('Yield / Loss Warning',
                            `Processing ${recId}: yield ${yieldPct}% — variance ${deltaFromPerfect.toFixed(2)}% exceeds threshold ${YIELD_LOSS_WARN_PCT}%`);
                    }
                }

                // 4. Per-output-line weight_pct + allocated_cost + cost_per_lb
                // Only update on EDIT (CREATE flow saves output lines separately)
                if (context.type === context.UserEventType.EDIT &&
                    totalOutput !== null && totalOutput > 0) {

                    const totalInputCost = toNum(rec.getValue({ fieldId: 'custrecord_sust_proc_total_input_cost' })) || 0;

                    outputLines.forEach(function(ol) {
                        if (!ol.weight || ol.weight <= 0) return;
                        const weightPct = round2((ol.weight / totalOutput) * 100);
                        const allocatedCost = round4(totalInputCost * (weightPct / 100));
                        const costPerLb = ol.weight > 0 ? round4(allocatedCost / ol.weight) : 0;

                        try {
                            record.submitFields({
                                type: 'customrecord_sust_processing_output_line',
                                id: ol.id,
                                values: {
                                    custrecord_sust_pol_weight_pct: weightPct,
                                    custrecord_sust_pol_allocated_cost: allocatedCost,
                                    custrecord_sust_pol_cost_per_lb: costPerLb
                                },
                                options: { enableSourcing: false, ignoreMandatoryFields: true }
                            });
                        } catch (e) {
                            log.error('Output Line Update Failed',
                                `Output line ${ol.id}: ${e.message}`);
                        }
                    });
                }

            } catch (e) {
                log.error('SUST_UE_Processing_DerivedFields.beforeSubmit failed',
                    `Error: ${e.message}\nStack: ${e.stack}`);
            }
        }

        function afterSubmit(context) {
            try {
                if (context.type !== context.UserEventType.EDIT) return;

                const newRec = context.newRecord;
                const recId = newRec.id;

                // True-net propagation note: append a brief audit comment to the
                // receiver lot if True Net differs from a previously recorded estimate.
                const trueNet = toNum(newRec.getValue({ fieldId: 'custrecord_sust_proc_true_net_lbs' }));
                const tareEst = toNum(newRec.getValue({ fieldId: 'custrecord_sust_proc_tare_estimate_lbs' }));
                const gross = toNum(newRec.getValue({ fieldId: 'custrecord_sust_proc_gross_input_lbs' }));
                const receiverLot = newRec.getValue({ fieldId: 'custrecord_sust_processing_input_lot' });

                if (!receiverLot || trueNet === null || gross === null || tareEst === null) {
                    return;
                }

                const estimatedNet = round4(gross - tareEst);
                const variance = round4(trueNet - estimatedNet);
                const variancePct = estimatedNet > 0 ? round2((Math.abs(variance) / estimatedNet) * 100) : 0;

                if (Math.abs(variance) < 0.01) {
                    log.debug('No True-Net Variance',
                        `Lot ${receiverLot}: true_net (${trueNet}) matches estimated_net (${estimatedNet})`);
                    return;
                }

                // Append a note to the lot
                try {
                    const existingNotes = (function() {
                        try {
                            const lookup = search.lookupFields({
                                type: 'inventorynumber',
                                id: receiverLot,
                                columns: ['custitemnumber_sust_lot_notes']
                            });
                            return lookup.custitemnumber_sust_lot_notes || '';
                        } catch (e) { return ''; }
                    })();

                    const newNote = '[True-Net True-Up ' + new Date().toISOString().substring(0, 10) + ', WIP ' + recId + '] '
                        + 'Estimated net = ' + estimatedNet + ' lb; True net = ' + trueNet + ' lb; '
                        + 'Variance = ' + (variance > 0 ? '+' : '') + variance + ' lb (' + variancePct + '%).';

                    const merged = existingNotes
                        ? existingNotes + '\n' + newNote
                        : newNote;

                    record.submitFields({
                        type: 'inventorynumber',
                        id: receiverLot,
                        values: { custitemnumber_sust_lot_notes: merged.substring(0, 3999) },
                        options: { enableSourcing: false, ignoreMandatoryFields: true }
                    });

                    log.audit('True-Net Variance Logged to Lot',
                        `Lot ${receiverLot}: ${newNote}`);

                } catch (e) {
                    log.error('Lot Notes Update Failed', `Lot ${receiverLot}: ${e.message}`);
                }

            } catch (e) {
                log.error('SUST_UE_Processing_DerivedFields.afterSubmit failed',
                    `Error: ${e.message}\nStack: ${e.stack}`);
            }
        }

        // ───────────────────────────────────────────────────────────────────────
        // Helpers
        // ───────────────────────────────────────────────────────────────────────

        function loadOutputLines(processingRecId) {
            const lines = [];
            try {
                const ss = search.create({
                    type: 'customrecord_sust_processing_output_line',
                    filters: [['custrecord_sust_output_processing', 'anyof', processingRecId]],
                    columns: ['internalid', 'custrecord_sust_output_weight', 'custrecord_sust_pol_stream']
                });
                ss.run().each(function(row) {
                    lines.push({
                        id: row.id,
                        weight: parseFloat(row.getValue({ name: 'custrecord_sust_output_weight' })) || 0,
                        stream: row.getValue({ name: 'custrecord_sust_pol_stream' }) || ''
                    });
                    return true;
                });
            } catch (e) {
                log.error('loadOutputLines failed', `Processing ${processingRecId}: ${e.message}`);
            }
            return lines;
        }

        function toNum(v) {
            if (v === null || v === undefined || v === '') return null;
            const n = parseFloat(v);
            return isNaN(n) ? null : n;
        }

        function round2(n) { return Math.round(n * 100) / 100; }
        function round4(n) { return Math.round(n * 10000) / 10000; }

        function escapeHtml(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        return {
            beforeLoad: beforeLoad,
            beforeSubmit: beforeSubmit,
            afterSubmit: afterSubmit
        };
    });
