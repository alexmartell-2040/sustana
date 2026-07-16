/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */

/**
 * SUST_UE_Settlement_CostFlowBack.js
 *
 * v2 (June 2026): Cost flow-back from Settlement to Output Lots.
 *
 * Trigger: settlement record status transitions to Completed (per F3
 * decision). For settlements linked to a processing record with output
 * lots at $0 (Post-Processing pricing-timing mode), this UE distributes
 * the settlement value back across the output lines proportional to
 * their weight share.
 *
 * Updates per output line:
 *   custrecord_sust_pol_allocated_cost = net_value × (line_weight / total_output_weight)
 *   custrecord_sust_pol_cost_per_lb    = allocated_cost / line_weight
 *
 * Then appends a cost-flow-back audit summary to the settlement notes
 * and the processing record's notes.
 *
 * Limitations (v2 POC):
 *   - Does NOT automatically create an Inventory Adjustment to re-cost
 *     the actual on-hand inventory. Recommends operator runs an IA
 *     manually OR via a future automated step (SP-5 extension).
 *   - For lots already sold, would need a JE branch to COGS — logs the
 *     condition for now (Chunk AA).
 *
 * Author: Sustana Dev Team
 * Date: June 2026 (v2)
 */

define(['N/record', 'N/search', 'N/runtime', 'N/log', './SUST_Lib_CostAllocation'],
    function(record, search, runtime, log, costAllocation) {

        const TRIGGER_STATUSES = ['Completed', 'Provisional Paid', 'Final Settled'];

        function afterSubmit(context) {
            try {
                if (context.type !== context.UserEventType.CREATE &&
                    context.type !== context.UserEventType.EDIT) {
                    return;
                }

                const newRec = context.newRecord;
                const oldRec = context.oldRecord;
                const settleId = newRec.id;

                const newStatus = (newRec.getText({ fieldId: 'custrecord_sust_settlement_status' }) || '').trim();
                const oldStatus = oldRec ? (oldRec.getText({ fieldId: 'custrecord_sust_settlement_status' }) || '').trim() : '';

                // Only fire on transition INTO a trigger status (not when staying or leaving)
                if (TRIGGER_STATUSES.indexOf(newStatus) === -1) return;
                if (newStatus === oldStatus) return;

                log.audit('Settlement Status Transition',
                    `Settlement ${settleId}: ${oldStatus || '(new)'} → ${newStatus}. Evaluating cost flow-back.`);

                // Load processing-record link
                const processingId = newRec.getValue({ fieldId: 'custrecord_sust_settlement_processing' });
                if (!processingId) {
                    log.debug('No Processing Link',
                        `Settlement ${settleId} has no linked processing record. No cost flow-back (Calculator mode or standalone settlement).`);
                    return;
                }

                // Load settlement net value
                const netValue = parseFloat(newRec.getValue({ fieldId: 'custrecord_sust_settlement_net_value' })) || 0;
                if (netValue <= 0) {
                    log.debug('Zero Net Value',
                        `Settlement ${settleId} net value is 0 — skipping cost flow-back.`);
                    return;
                }

                // Load all output lines on the linked processing record
                const outputLines = loadOutputLines(processingId);
                if (outputLines.length === 0) {
                    log.debug('No Output Lines',
                        `Processing record ${processingId} has no output lines.`);
                    return;
                }

                const totalOutputWeight = outputLines.reduce(function(s, ol) { return s + ol.weight; }, 0);
                if (totalOutputWeight <= 0) {
                    log.debug('Zero Total Output Weight',
                        `Processing ${processingId}: output lines exist but total weight is 0. Skipping.`);
                    return;
                }

                // v2.1: Use shared cost allocation engine. Mode comes from the linked
                // processing record (defaults to Byproduct — GAAP-recommended).
                let allocModeText = '';
                try {
                    const procLookup = search.lookupFields({
                        type: 'customrecord_sust_processing_record',
                        id: processingId,
                        columns: ['custrecord_sust_processing_alloc_mode']
                    });
                    const modeField = procLookup.custrecord_sust_processing_alloc_mode;
                    if (modeField) {
                        allocModeText = (Array.isArray(modeField) && modeField.length)
                            ? (modeField[0].text || '')
                            : (modeField.text || modeField.toString());
                    }
                } catch (e) {
                    log.debug('Mode lookup failed', `Processing ${processingId}: ${e.message} — defaulting to Byproduct`);
                }
                const allocMode = allocModeText || costAllocation.MODE.BYPRODUCT;

                // Build engine input
                const engineLines = outputLines.map(function(ol) {
                    return {
                        itemId: ol.itemId,
                        lbs: ol.weight,
                        _ref: ol
                    };
                });

                const allocResult = costAllocation.allocateInputCost({
                    inputCost: netValue,
                    outputLines: engineLines,
                    mode: allocMode
                });

                log.audit('Cost Flow-Back Allocation', costAllocation.formatAuditString(allocResult));

                // Compute + write per-output-line allocated cost
                const updates = [];
                let zeroCostLinesFound = 0;

                allocResult.outputLines.forEach(function(engineLine) {
                    const ol = engineLine._ref;
                    const allocatedCost = round4(engineLine.allocatedCost || 0);
                    const costPerLb = round4(ol.weight > 0 ? allocatedCost / ol.weight : 0);

                    try {
                        record.submitFields({
                            type: 'customrecord_sust_processing_output_line',
                            id: ol.id,
                            values: {
                                custrecord_sust_pol_allocated_cost: allocatedCost,
                                custrecord_sust_pol_cost_per_lb: costPerLb,
                                custrecord_sust_pol_weight_pct: round2((ol.weight / totalOutputWeight) * 100)
                            },
                            options: { enableSourcing: false, ignoreMandatoryFields: true }
                        });
                        updates.push({
                            outputLineId: ol.id,
                            outputItem: ol.itemText,
                            weight: ol.weight,
                            allocatedCost: allocatedCost,
                            costPerLb: costPerLb,
                            lotId: ol.lotId,
                            classification: engineLine.classification,
                            nrvSource: engineLine.nrvSource
                        });
                        if (ol.priorAllocatedCost === 0) {
                            zeroCostLinesFound++;
                        }
                    } catch (e) {
                        log.error('Output Line Update Failed',
                            `Line ${ol.id}: ${e.message}`);
                    }
                });

                log.audit('Cost Flow-Back Computed',
                    `Settlement ${settleId} → Processing ${processingId} [${allocMode}]: distributed $${netValue} across ${updates.length} output lines (total weight ${totalOutputWeight} lb). ${zeroCostLinesFound} line(s) previously at $0 (Post-Processing deferred-pricing mode).`);

                // Detail-log per-line allocations
                updates.forEach(function(u, i) {
                    log.audit('Line ' + (i + 1) + ' allocation',
                        `${u.outputItem || 'Output ' + (i + 1)} — Lot ${u.lotId} — ${u.weight} lb → $${u.allocatedCost} ($${u.costPerLb}/lb)`);
                });

                // v2.1 fix: also roll up Total Input Cost on the processing record + append audit
                // to processing notes so the processing record reflects the deferred-pricing
                // cost basis that was determined at settlement time.
                // v2.2: also transition the processing record from "Awaiting Cost" back to "Completed"
                // which re-triggers the IA creation now that Total Input Cost is known.
                try {
                    const procLookup = search.lookupFields({
                        type: 'customrecord_sust_processing_record',
                        id: processingId,
                        columns: [
                            'custrecord_sust_proc_total_input_cost',
                            'custrecord_sust_processing_notes',
                            'custrecord_sust_processing_status',
                            'custrecord_sust_proc_ia_pending'
                        ]
                    });
                    const priorInputCost = parseFloat(procLookup.custrecord_sust_proc_total_input_cost) || 0;
                    const priorNotes = procLookup.custrecord_sust_processing_notes || '';
                    const procStatusText = procLookup.custrecord_sust_processing_status
                        ? (Array.isArray(procLookup.custrecord_sust_processing_status) && procLookup.custrecord_sust_processing_status.length
                            ? procLookup.custrecord_sust_processing_status[0].text
                            : procLookup.custrecord_sust_processing_status.toString())
                        : '';
                    const iaPending = procLookup.custrecord_sust_proc_ia_pending === true
                        || procLookup.custrecord_sust_proc_ia_pending === 'T';
                    const stamp = new Date().toISOString().substring(0, 10);

                    const procAuditLines = ['[Cost Flow-Back from Settlement ' + stamp + ']'];
                    procAuditLines.push('Settlement ' + settleId + ' Net Value $' + round2(netValue)
                        + ' applied as Total Input Cost (was $' + round2(priorInputCost) + ').');
                    procAuditLines.push('Allocation mode: ' + allocMode + '. Per-line breakdown:');
                    updates.forEach(function(u, i) {
                        const cls = u.classification ? '[' + u.classification + '] ' : '';
                        const nrv = u.nrvSource ? ' (NRV: ' + u.nrvSource + ')' : '';
                        procAuditLines.push('  ' + (i + 1) + '. ' + cls + (u.outputItem || 'Output')
                            + ' Lot ' + u.lotId + ' — ' + u.weight + ' lb @ $' + round2(u.costPerLb)
                            + '/lb = $' + round2(u.allocatedCost) + nrv);
                    });
                    const mergedNotes = priorNotes
                        ? priorNotes + '\n\n' + procAuditLines.join('\n')
                        : procAuditLines.join('\n');

                    record.submitFields({
                        type: 'customrecord_sust_processing_record',
                        id: processingId,
                        values: {
                            custrecord_sust_proc_total_input_cost: netValue,
                            custrecord_sust_processing_notes: mergedNotes.substring(0, 9999)
                        },
                        options: { enableSourcing: false, ignoreMandatoryFields: true }
                    });
                    log.audit('Processing Record Updated',
                        `Processing ${processingId}: Total Input Cost updated $${priorInputCost} → $${netValue}. Audit appended to notes.`);

                    // v2.2: if the processing record is in "Awaiting Cost" state with IA pending,
                    // transition it back to "Completed" — this re-fires the IA-creation User Event
                    // (SUST_UE_Processing_CreateInvAdj) which will now find Total Input Cost > 0 and
                    // create the IA with engine-allocated costs.
                    if (procStatusText === 'Awaiting Cost' || iaPending) {
                        try {
                            const completedStatusId = getProcessingStatusId('Completed');
                            if (completedStatusId) {
                                record.submitFields({
                                    type: 'customrecord_sust_processing_record',
                                    id: processingId,
                                    values: {
                                        custrecord_sust_processing_status: completedStatusId
                                    },
                                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                                });
                                log.audit('v2.2 IA Trigger',
                                    `Processing ${processingId}: transitioned Awaiting Cost → Completed. ` +
                                    `IA-creation UE will fire now that Total Input Cost = $${netValue}.`);
                            } else {
                                log.error('v2.2 IA Trigger',
                                    `Processing ${processingId}: could not resolve "Completed" status ID — IA will not auto-create. Transition manually.`);
                            }
                        } catch (transErr) {
                            log.error('v2.2 IA Trigger transition failed',
                                `Processing ${processingId}: ${transErr.message}`);
                        }
                    }
                } catch (procErr) {
                    log.error('Processing record update failed',
                        `Processing ${processingId}: ${procErr.message}. Output line records were still updated.`);
                }

                // Append summary to settlement notes
                appendSettlementNote(settleId, newRec, netValue, updates);

                // Check if any output lots have been sold (Chunk AA scaffold)
                checkSoldLots(updates, settleId);

            } catch (e) {
                log.error('SUST_UE_Settlement_CostFlowBack.afterSubmit failed',
                    `Error: ${e.message}\nStack: ${e.stack}`);
            }
        }

        // ───────────────────────────────────────────────────────────────────────
        // Helpers
        // ───────────────────────────────────────────────────────────────────────

        function loadOutputLines(processingId) {
            const lines = [];
            try {
                search.create({
                    type: 'customrecord_sust_processing_output_line',
                    filters: [['custrecord_sust_output_processing', 'anyof', processingId]],
                    columns: [
                        'internalid',
                        'custrecord_sust_output_item',
                        'custrecord_sust_output_lot',
                        'custrecord_sust_output_weight',
                        'custrecord_sust_pol_allocated_cost'
                    ]
                }).run().each(function(row) {
                    lines.push({
                        id: row.id,
                        itemId: row.getValue({ name: 'custrecord_sust_output_item' }),
                        itemText: row.getText({ name: 'custrecord_sust_output_item' }),
                        lotId: row.getValue({ name: 'custrecord_sust_output_lot' }),
                        weight: parseFloat(row.getValue({ name: 'custrecord_sust_output_weight' })) || 0,
                        priorAllocatedCost: parseFloat(row.getValue({ name: 'custrecord_sust_pol_allocated_cost' })) || 0
                    });
                    return true;
                });
            } catch (e) {
                log.error('loadOutputLines failed', `${processingId}: ${e.message}`);
            }
            return lines;
        }

        function appendSettlementNote(settleId, settleRec, netValue, updates) {
            try {
                const priorNotes = settleRec.getValue({ fieldId: 'custrecord_sust_settlement_notes' }) || '';
                const stamp = new Date().toISOString().substring(0, 10);
                const lines = ['[Cost Flow-Back ' + stamp + ']'];
                lines.push('Settlement net value $' + round2(netValue) + ' distributed across ' + updates.length + ' output line(s):');
                updates.forEach(function(u, i) {
                    const cls = u.classification ? '[' + u.classification + '] ' : '';
                    const nrv = u.nrvSource ? ' (NRV: ' + u.nrvSource + ')' : '';
                    lines.push('  ' + (i + 1) + '. ' + cls + (u.outputItem || 'Output') + ' Lot ' + u.lotId + ' — ' + u.weight + ' lb @ $' + round2(u.costPerLb) + '/lb = $' + round2(u.allocatedCost) + nrv);
                });
                const merged = priorNotes ? priorNotes + '\n\n' + lines.join('\n') : lines.join('\n');
                record.submitFields({
                    type: 'customrecord_sust_settlement_record',
                    id: settleId,
                    values: { custrecord_sust_settlement_notes: merged.substring(0, 9999) },
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });
            } catch (e) {
                log.error('Settlement note append failed', e.message);
            }
        }

        /**
         * Chunk AA scaffold: detect when an output lot has already been sold,
         * which would require a JE-to-COGS adjustment rather than an IA write-up.
         * For v2 POC this is detect + log only.
         */
        function checkSoldLots(updates, settleId) {
            const lotsSold = [];
            updates.forEach(function(u) {
                if (!u.lotId) return;
                try {
                    const ss = search.create({
                        type: 'transaction',
                        filters: [
                            ['type', 'anyof', 'ItemShip', 'CustInvc', 'CashSale'],
                            'AND', ['inventorydetail.inventorynumber', 'anyof', u.lotId]
                        ],
                        columns: ['internalid']
                    });
                    let found = false;
                    ss.run().each(function() { found = true; return false; }); // first only
                    if (found) {
                        lotsSold.push(u.lotId);
                    }
                } catch (e) {
                    // Search may not work in all environments — skip silently
                }
            });

            if (lotsSold.length > 0) {
                log.audit('SOLD-BEFORE-SETTLED Detected',
                    `Settlement ${settleId}: ${lotsSold.length} output lot(s) already have shipment/invoice transactions. Cost flow-back via Inventory Adjustment would not affect COGS on those sold units — manual Journal Entry recommended (DR adjusted COGS, CR original COGS). Lots: ${lotsSold.join(', ')}.`);
            }
        }

        function round2(n) { return Math.round(n * 100) / 100; }
        function round4(n) { return Math.round(n * 10000) / 10000; }

        // v2.2: cache + resolve processing status custom list IDs at runtime.
        // Custom list internal IDs vary by account, so look up by name.
        const _procStatusIdCache = {};
        function getProcessingStatusId(statusText) {
            if (_procStatusIdCache[statusText]) return _procStatusIdCache[statusText];
            try {
                const ss = search.create({
                    type: 'customlist_sust_processing_status',
                    filters: [['name', 'is', statusText]],
                    columns: ['internalid']
                });
                const results = ss.run().getRange({ start: 0, end: 1 });
                if (results.length > 0) {
                    _procStatusIdCache[statusText] = results[0].id;
                    return results[0].id;
                }
            } catch (e) {
                log.error('getProcessingStatusId failed', `${statusText}: ${e.message}`);
            }
            return null;
        }

        return {
            afterSubmit: afterSubmit
        };
    });
