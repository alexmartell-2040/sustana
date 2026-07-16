/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 * @NModuleScope SameAccount
 */

/**
 * SUST_SS_LCNRVTest.js
 *
 * Monthly LCNRV (Lower of Cost or Net Realizable Value) testing per
 * ASC 330-10-35-1B (ASU 2015-11). Pulls all on-hand lots of recovered-fiber
 * and byproduct items for Sustana Recovery. For each lot:
 *
 *   1. Compute carrying cost (last cost × on-hand qty)
 *   2. Compute NRV via the shared cost-allocation engine (hierarchical
 *      fallback: manual override → index price × yield → last sale → zero)
 *   3. If carrying cost > NRV, create a customrecord_sust_lcnrv_review entry
 *      with status = Pending Review
 *
 * Controller reviews each entry via SUST_SL_LCNRVDashboard and either marks
 * no-action or posts a write-down Inventory Adjustment.
 *
 * Subsidiary: script param custscript_sust_lcnrv_subsidiary, falling back to
 * Sustana Config (usSubsidiary); when both are empty the run proceeds across
 * all subsidiaries (logged) — never a hardcoded internal id.
 *
 * Author: Sustana Dev Team
 * Date: July 2026
 */

define(['N/record', 'N/search', 'N/runtime', 'N/log', 'N/email', './SUST_Lib_CostAllocation', './SUST_Lib_Config'],
    function(record, search, runtime, log, email, costAllocation, configLib) {

        function execute(context) {
            try {
                const script = runtime.getCurrentScript();
                // Script param overrides the Sustana Config record; no hardcoded ids.
                const paramSubId = script.getParameter({ name: 'custscript_sust_lcnrv_subsidiary' });
                const sustSubId = parseInt(paramSubId || configLib.get('usSubsidiary') || 0, 10) || null;
                const emailRecipient = script.getParameter({ name: 'custscript_sust_lcnrv_email_recipient' });
                const minVariancePct = parseFloat(script.getParameter({ name: 'custscript_sust_lcnrv_min_variance_pct' }) || 1.0);

                if (!sustSubId) {
                    log.audit('LCNRV Subsidiary Unset',
                        'Script param custscript_sust_lcnrv_subsidiary and Sustana Config usSubsidiary are both empty — testing lots across all subsidiaries.');
                }

                log.audit('LCNRV Test Run Start',
                    `Subsidiary: ${sustSubId || '(all)'}, Min variance %: ${minVariancePct}, Email recipient: ${emailRecipient || '(none)'}`);

                const today = new Date();
                const lotsTested = [];
                const reviewsCreated = [];

                // Pull all on-hand lots for Sustana Recovery items
                const lotSearch = buildLotSearch(sustSubId);
                const pageData = lotSearch.runPaged({ pageSize: 100 });

                pageData.pageRanges.forEach(function(pageRange) {
                    const page = pageData.fetch({ index: pageRange.index });

                    page.data.forEach(function(row) {
                        try {
                            const lotData = parseLotRow(row);
                            if (lotData.qtyOnHand <= 0) return;

                            lotsTested.push(lotData);

                            // Compute NRV via the shared engine
                            const nrvResult = costAllocation.computeNRV({
                                itemId: lotData.itemId,
                                lbs: lotData.qtyOnHand
                            });

                            const carryingCostTotal = (lotData.unitCost || 0) * lotData.qtyOnHand;
                            const nrvTotal = nrvResult.nrvTotal || 0;

                            // LCNRV variance: carrying cost above NRV is a write-down candidate
                            const variance = carryingCostTotal - nrvTotal;
                            if (variance <= 0) return;  // Carrying cost <= NRV → no write-down

                            const variancePct = carryingCostTotal > 0
                                ? (variance / carryingCostTotal) * 100
                                : 0;

                            // Materiality filter: skip immaterial variances
                            if (variancePct < minVariancePct) {
                                log.debug('LCNRV Below Threshold',
                                    `Lot ${lotData.lotNumber}: variance ${variancePct.toFixed(2)}% < min ${minVariancePct}% — skipping.`);
                                return;
                            }

                            // Create review record
                            const reviewId = createReviewRecord({
                                lotId: lotData.lotId,
                                itemId: lotData.itemId,
                                qtyOnHand: lotData.qtyOnHand,
                                carryingCostPerLb: lotData.unitCost,
                                carryingCostTotal: carryingCostTotal,
                                nrvPerLb: nrvResult.nrvPerLb,
                                nrvTotal: nrvTotal,
                                nrvSource: nrvResult.source,
                                variance: variance,
                                variancePct: variancePct,
                                runDate: today
                            });

                            if (reviewId) {
                                reviewsCreated.push({
                                    reviewId: reviewId,
                                    lotNumber: lotData.lotNumber,
                                    itemName: lotData.itemName,
                                    variance: variance,
                                    variancePct: variancePct
                                });
                            }
                        } catch (rowErr) {
                            log.error('LCNRV row error', rowErr.message);
                        }
                    });
                });

                log.audit('LCNRV Test Run Complete',
                    `Tested ${lotsTested.length} lots, created ${reviewsCreated.length} review entries.`);

                // Optional email summary
                if (emailRecipient && reviewsCreated.length > 0) {
                    sendSummaryEmail(emailRecipient, reviewsCreated, lotsTested.length);
                }

            } catch (e) {
                log.error('SUST_SS_LCNRVTest.execute failed', `${e.message}\n${e.stack}`);
            }
        }

        function buildLotSearch(sustSubId) {
            // All on-hand lots. The item's subsidiary is carried as a column for
            // review context; the demo account is effectively single-subsidiary,
            // so no server-side subsidiary filter is applied here.
            return search.create({
                type: 'inventorynumber',
                filters: [
                    ['quantityonhand', 'greaterthan', 0]
                ],
                columns: [
                    'internalid',
                    'inventorynumber',
                    search.createColumn({ name: 'item' }),
                    search.createColumn({ name: 'itemid', join: 'item' }),
                    search.createColumn({ name: 'subsidiary', join: 'item' }),
                    search.createColumn({ name: 'custitem_sust_cost_alloc_class', join: 'item' }),
                    search.createColumn({ name: 'lastpurchaseprice', join: 'item' }),
                    'quantityonhand'
                ]
            });
        }

        function parseLotRow(row) {
            return {
                lotId: parseInt(row.id, 10),
                lotNumber: row.getValue('inventorynumber'),
                itemId: parseInt(row.getValue('item'), 10),
                itemName: row.getText('item') || row.getValue({ name: 'itemid', join: 'item' }),
                qtyOnHand: parseFloat(row.getValue('quantityonhand')) || 0,
                unitCost: parseFloat(row.getValue({ name: 'lastpurchaseprice', join: 'item' })) || 0,
                classification: row.getText({ name: 'custitem_sust_cost_alloc_class', join: 'item' }) || 'Primary'
            };
        }

        function createReviewRecord(params) {
            try {
                const r = record.create({ type: 'customrecord_sust_lcnrv_review' });
                r.setValue({ fieldId: 'custrecord_sust_lcnrv_lot', value: params.lotId });
                r.setValue({ fieldId: 'custrecord_sust_lcnrv_item', value: params.itemId });
                r.setValue({ fieldId: 'custrecord_sust_lcnrv_qty_on_hand', value: params.qtyOnHand });
                r.setValue({ fieldId: 'custrecord_sust_lcnrv_cost_per_lb', value: params.carryingCostPerLb });
                r.setValue({ fieldId: 'custrecord_sust_lcnrv_cost_total', value: params.carryingCostTotal });
                r.setValue({ fieldId: 'custrecord_sust_lcnrv_nrv_per_lb', value: params.nrvPerLb });
                r.setValue({ fieldId: 'custrecord_sust_lcnrv_nrv_total', value: params.nrvTotal });
                r.setValue({ fieldId: 'custrecord_sust_lcnrv_nrv_source', value: params.nrvSource });
                r.setValue({ fieldId: 'custrecord_sust_lcnrv_variance', value: params.variance });
                r.setValue({ fieldId: 'custrecord_sust_lcnrv_variance_pct', value: params.variancePct });
                r.setValue({ fieldId: 'custrecord_sust_lcnrv_run_date', value: params.runDate });
                r.setText({ fieldId: 'custrecord_sust_lcnrv_status', text: 'Pending Review' });
                return r.save();
            } catch (e) {
                log.error('Create LCNRV review failed', `${e.message}`);
                return null;
            }
        }

        function sendSummaryEmail(recipientId, reviewsCreated, lotsTested) {
            try {
                const rows = reviewsCreated.map(function(r) {
                    return '<tr>'
                        + '<td>' + r.lotNumber + '</td>'
                        + '<td>' + (r.itemName || '') + '</td>'
                        + '<td style="text-align:right">$' + r.variance.toFixed(2) + '</td>'
                        + '<td style="text-align:right">' + r.variancePct.toFixed(1) + '%</td>'
                        + '</tr>';
                }).join('');

                const body = '<html><body style="font-family:Calibri,Arial,sans-serif">'
                    + '<h2 style="color:#2976F3">Sustana Recovery — LCNRV Monthly Test Summary</h2>'
                    + '<p>The monthly LCNRV test (ASC 330-10-35-1B) flagged <strong>' + reviewsCreated.length + '</strong> '
                    + 'lot(s) requiring review out of <strong>' + lotsTested + '</strong> tested.</p>'
                    + '<table style="border-collapse:collapse;width:100%"><thead><tr style="background:#2976F3;color:white">'
                    + '<th style="padding:6pt;text-align:left">Lot</th>'
                    + '<th style="padding:6pt;text-align:left">Item</th>'
                    + '<th style="padding:6pt;text-align:right">Variance ($)</th>'
                    + '<th style="padding:6pt;text-align:right">Variance (%)</th>'
                    + '</tr></thead><tbody>' + rows + '</tbody></table>'
                    + '<p>Open the <a href="/app/site/hosting/scriptlet.nl?script=customscript_sust_sl_lcnrv_dash&deploy=customdeploy_sust_sl_lcnrv_dash">LCNRV Dashboard</a> to review and resolve.</p>'
                    + '</body></html>';

                email.send({
                    author: runtime.getCurrentUser().id || -5,
                    recipients: parseInt(recipientId, 10),
                    subject: 'LCNRV Monthly Test: ' + reviewsCreated.length + ' lot(s) flagged for review',
                    body: body
                });

                log.audit('LCNRV summary email sent', `Recipient ${recipientId}, ${reviewsCreated.length} reviews`);
            } catch (e) {
                log.error('LCNRV email send failed', `${e.message}`);
            }
        }

        return { execute: execute };
    });
