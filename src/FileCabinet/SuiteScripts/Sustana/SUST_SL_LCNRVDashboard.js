/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */

/**
 * SUST_SL_LCNRVDashboard.js
 *
 * v2.1: Controller dashboard for LCNRV (Lower of Cost or NRV) reviews.
 * Lists all customrecord_sust_lcnrv_review entries grouped by status, with
 * per-row actions:
 *   - Mark Reviewed - No Action (records reviewer + notes, no GL impact)
 *   - Post Adjustment (creates pre-filled Inventory Adjustment write-down)
 *   - Open Lot (deep link)
 *
 * Style: mirrors the Settlement Close-Out Dashboard pattern.
 *
 * Author: Sustana Dev Team
 * Date: June 2026 (v2.1)
 */

define(['N/ui/serverWidget', 'N/search', 'N/record', 'N/redirect', 'N/url', 'N/runtime', 'N/log', './SUST_Lib_Units'],
    function(serverWidget, search, record, redirect, url, runtime, log, units) {

        function onRequest(context) {
            try {
                if (context.request.method === 'POST') {
                    return handlePost(context);
                }
                return renderDashboard(context);
            } catch (e) {
                log.error('LCNRV Dashboard error', `${e.message}\n${e.stack}`);
                throw e;
            }
        }

        function renderDashboard(context) {
            const form = serverWidget.createForm({ title: 'Sustana Recovery — LCNRV Review Dashboard' });

            // Filter: status
            const statusFilter = context.request.parameters.status_filter || 'Pending Review';

            // Summary tiles via inline HTML
            const tiles = getSummaryTiles();
            const tilesHtml = buildTilesHtml(tiles);

            const banner = form.addField({
                id: 'custpage_banner',
                type: serverWidget.FieldType.INLINEHTML,
                label: ' '
            });
            banner.defaultValue = tilesHtml;

            // Filter selector
            const statusField = form.addField({
                id: 'custpage_status_filter',
                type: serverWidget.FieldType.SELECT,
                label: 'Status'
            });
            statusField.addSelectOption({ value: 'Pending Review', text: 'Pending Review' });
            statusField.addSelectOption({ value: 'Reviewed - No Action', text: 'Reviewed - No Action' });
            statusField.addSelectOption({ value: 'Reviewed - Adjustment Pending', text: 'Reviewed - Adjustment Pending' });
            statusField.addSelectOption({ value: 'Adjustment Posted', text: 'Adjustment Posted' });
            statusField.addSelectOption({ value: '', text: '(All)' });
            statusField.defaultValue = statusFilter;

            form.addSubmitButton({ label: 'Filter' });

            // Reviews sublist
            const list = form.addSublist({
                id: 'custpage_reviews',
                type: serverWidget.SublistType.LIST,
                label: 'LCNRV Reviews'
            });

            list.addField({ id: 'custpage_run_date',     type: serverWidget.FieldType.DATE,     label: 'Run Date' });
            list.addField({ id: 'custpage_lot',          type: serverWidget.FieldType.TEXT,     label: 'Lot' });
            list.addField({ id: 'custpage_item',         type: serverWidget.FieldType.TEXT,     label: 'Item' });
            // Stored values stay in lbs / $-per-lb; tons and $/ton are display-only
            list.addField({ id: 'custpage_qty',          type: serverWidget.FieldType.TEXT,     label: 'Qty (lbs)' });
            list.addField({ id: 'custpage_cost_lb',     type: serverWidget.FieldType.TEXT,     label: 'Cost/lb' });
            list.addField({ id: 'custpage_nrv_lb',      type: serverWidget.FieldType.TEXT,     label: 'NRV/lb' });
            list.addField({ id: 'custpage_variance',     type: serverWidget.FieldType.CURRENCY, label: 'Variance' });
            list.addField({ id: 'custpage_variance_pct', type: serverWidget.FieldType.PERCENT,  label: 'Variance %' });
            list.addField({ id: 'custpage_nrv_source',  type: serverWidget.FieldType.TEXT,     label: 'NRV Source' });
            list.addField({ id: 'custpage_status',       type: serverWidget.FieldType.TEXT,     label: 'Status' });
            list.addField({ id: 'custpage_actions',      type: serverWidget.FieldType.INLINEHTML, label: 'Actions' });

            // Search reviews
            const filters = [];
            if (statusFilter) {
                filters.push(['custrecord_sust_lcnrv_status', 'is', resolveStatusId(statusFilter)]);
            }

            const reviewSearch = search.create({
                type: 'customrecord_sust_lcnrv_review',
                filters: filters,
                columns: [
                    'internalid',
                    'custrecord_sust_lcnrv_run_date',
                    'custrecord_sust_lcnrv_lot',
                    'custrecord_sust_lcnrv_item',
                    'custrecord_sust_lcnrv_qty_on_hand',
                    'custrecord_sust_lcnrv_cost_per_lb',
                    'custrecord_sust_lcnrv_nrv_per_lb',
                    'custrecord_sust_lcnrv_variance',
                    'custrecord_sust_lcnrv_variance_pct',
                    'custrecord_sust_lcnrv_nrv_source',
                    'custrecord_sust_lcnrv_status',
                    search.createColumn({ name: 'custrecord_sust_lcnrv_run_date', sort: search.Sort.DESC })
                ]
            });

            let lineNum = 0;
            reviewSearch.run().each(function(row) {
                if (lineNum >= 500) return false;  // sanity cap

                const id = row.id;
                const actionsHtml = buildActionsHtml(id, row.getValue('custrecord_sust_lcnrv_status'));

                const qtyLbs = parseFloat(row.getValue('custrecord_sust_lcnrv_qty_on_hand')) || 0;
                const costPerLb = parseFloat(row.getValue('custrecord_sust_lcnrv_cost_per_lb')) || 0;
                const nrvPerLb = parseFloat(row.getValue('custrecord_sust_lcnrv_nrv_per_lb')) || 0;

                list.setSublistValue({ id: 'custpage_run_date', line: lineNum, value: row.getValue('custrecord_sust_lcnrv_run_date') || ' ' });
                list.setSublistValue({ id: 'custpage_lot', line: lineNum, value: row.getText('custrecord_sust_lcnrv_lot') || '' });
                list.setSublistValue({ id: 'custpage_item', line: lineNum, value: row.getText('custrecord_sust_lcnrv_item') || '' });
                list.setSublistValue({ id: 'custpage_qty', line: lineNum, value: qtyLbs + ' (' + units.formatTons(qtyLbs) + ')' });
                list.setSublistValue({ id: 'custpage_cost_lb', line: lineNum, value: '$' + costPerLb.toFixed(4) + ' (' + units.formatPerTon(costPerLb) + ')' });
                list.setSublistValue({ id: 'custpage_nrv_lb', line: lineNum, value: '$' + nrvPerLb.toFixed(4) + ' (' + units.formatPerTon(nrvPerLb) + ')' });
                list.setSublistValue({ id: 'custpage_variance', line: lineNum, value: row.getValue('custrecord_sust_lcnrv_variance') || 0 });
                list.setSublistValue({ id: 'custpage_variance_pct', line: lineNum, value: row.getValue('custrecord_sust_lcnrv_variance_pct') || 0 });
                list.setSublistValue({ id: 'custpage_nrv_source', line: lineNum, value: row.getValue('custrecord_sust_lcnrv_nrv_source') || '' });
                list.setSublistValue({ id: 'custpage_status', line: lineNum, value: row.getText('custrecord_sust_lcnrv_status') || '' });
                list.setSublistValue({ id: 'custpage_actions', line: lineNum, value: actionsHtml });

                lineNum++;
                return true;
            });

            context.response.writePage(form);
        }

        function buildTilesHtml(tiles) {
            const colors = {
                pending: '#b87f00',
                noaction: '#2e8540',
                adjpending: '#1f5fcc',
                posted: '#555'
            };
            return '<div style="display:flex;gap:10px;margin-bottom:10px;font-family:Calibri,Arial,sans-serif">'
                + tile('Pending Review', tiles.pending,   colors.pending,    'Awaiting controller decision')
                + tile('Reviewed - NA',  tiles.noaction,  colors.noaction,   'No write-down required')
                + tile('Adj Pending',    tiles.adjpending,colors.adjpending, 'Write-down approved, IA not yet posted')
                + tile('Total Variance', '$' + tiles.totalVariance.toFixed(2), '#2976F3', 'Sum of all pending variances')
                + '</div>';
        }

        function tile(label, value, color, hint) {
            return '<div style="flex:1;background:#f4f7fb;border:1px solid #d9e2ee;border-left:4px solid '
                + color + ';padding:10px 14px;border-radius:4px">'
                + '<div style="font-size:8pt;letter-spacing:0.05em;text-transform:uppercase;color:#555">' + label + '</div>'
                + '<div style="font-size:20pt;font-weight:700;color:' + color + ';margin:2px 0">' + value + '</div>'
                + '<div style="font-size:8.5pt;color:#555">' + hint + '</div>'
                + '</div>';
        }

        function getSummaryTiles() {
            const tiles = { pending: 0, noaction: 0, adjpending: 0, posted: 0, totalVariance: 0 };
            try {
                const ss = search.create({
                    type: 'customrecord_sust_lcnrv_review',
                    columns: ['custrecord_sust_lcnrv_status', 'custrecord_sust_lcnrv_variance']
                });
                ss.run().each(function(row) {
                    const statusText = row.getText('custrecord_sust_lcnrv_status') || '';
                    const variance = parseFloat(row.getValue('custrecord_sust_lcnrv_variance')) || 0;
                    if (statusText === 'Pending Review') { tiles.pending++; tiles.totalVariance += variance; }
                    else if (statusText === 'Reviewed - No Action') { tiles.noaction++; }
                    else if (statusText === 'Reviewed - Adjustment Pending') { tiles.adjpending++; }
                    else if (statusText === 'Adjustment Posted') { tiles.posted++; }
                    return true;
                });
            } catch (e) {
                log.error('Tiles error', e.message);
            }
            return tiles;
        }

        function buildActionsHtml(reviewId, statusValue) {
            const noActionUrl = url.resolveScript({
                scriptId: 'customscript_sust_sl_lcnrv_dash',
                deploymentId: 'customdeploy_sust_sl_lcnrv_dash',
                params: { action: 'no_action', id: reviewId }
            });
            const postAdjUrl = url.resolveScript({
                scriptId: 'customscript_sust_sl_lcnrv_dash',
                deploymentId: 'customdeploy_sust_sl_lcnrv_dash',
                params: { action: 'post_adj', id: reviewId }
            });
            return '<a href="' + noActionUrl + '" style="margin-right:8px;color:#2e8540">Mark No Action</a>'
                + ' | <a href="' + postAdjUrl + '" style="color:#1f5fcc">Post Adjustment</a>';
        }

        function resolveStatusId(statusText) {
            // SELECT-by-text in search filters needs the text value
            return statusText;
        }

        function handlePost(context) {
            // Filter form submission redirects back to GET
            const statusFilter = context.request.parameters.custpage_status_filter || '';
            redirect.toSuitelet({
                scriptId: 'customscript_sust_sl_lcnrv_dash',
                deploymentId: 'customdeploy_sust_sl_lcnrv_dash',
                parameters: { status_filter: statusFilter }
            });
        }

        // ───────────────────────────────────────────────────────────
        // Action handlers via URL query params (action=no_action / post_adj)
        // ───────────────────────────────────────────────────────────

        function handleAction(context) {
            const action = context.request.parameters.action;
            const reviewId = parseInt(context.request.parameters.id, 10);
            if (!action || !reviewId) return false;

            try {
                if (action === 'no_action') {
                    record.submitFields({
                        type: 'customrecord_sust_lcnrv_review',
                        id: reviewId,
                        values: {
                            custrecord_sust_lcnrv_status: 'Reviewed - No Action',
                            custrecord_sust_lcnrv_reviewer: runtime.getCurrentUser().id
                        }
                    });
                    redirect.toSuitelet({
                        scriptId: 'customscript_sust_sl_lcnrv_dash',
                        deploymentId: 'customdeploy_sust_sl_lcnrv_dash'
                    });
                    return true;
                } else if (action === 'post_adj') {
                    record.submitFields({
                        type: 'customrecord_sust_lcnrv_review',
                        id: reviewId,
                        values: {
                            custrecord_sust_lcnrv_status: 'Reviewed - Adjustment Pending',
                            custrecord_sust_lcnrv_reviewer: runtime.getCurrentUser().id
                        }
                    });
                    redirect.toRecord({
                        type: 'inventoryadjustment',
                        id: 0,
                        isNew: true,
                        defaultValues: {
                            custbody_sust_lcnrv_review: reviewId
                        }
                    });
                    return true;
                }
            } catch (e) {
                log.error('LCNRV action failed', `${action} on ${reviewId}: ${e.message}`);
            }
            return false;
        }

        // Hook handleAction into onRequest GET if action param is set
        function onRequestWithAction(context) {
            if (context.request.method === 'GET' && context.request.parameters.action) {
                if (handleAction(context)) return;
            }
            return onRequest(context);
        }

        return { onRequest: onRequestWithAction };
    });
