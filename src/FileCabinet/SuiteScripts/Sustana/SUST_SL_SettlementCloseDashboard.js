/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */

/**
 * SUST_SL_SettlementCloseDashboard.js
 *
 * v2 (June 2026): Sustana Recovery settlement close-out dashboard.
 *
 * Lists all settlements in non-final status (Draft, Completed,
 * Provisional Paid) past a configurable age threshold. Designed to
 * feed the Controller's month-end close checklist.
 *
 * Per Costing Review: 30 days is the standard processing-to-pay window;
 * settlements still open past that warrant review.
 *
 * Filterable by:
 *   - days threshold (URL ?days=N, default 30)
 *   - status (URL ?status=...)
 *
 * Color codes by age:
 *   ≤30 days  : 🟢 on-time (informational)
 *   31-60     : 🟡 watch
 *   >60       : 🔴 stale — escalate
 *
 * Author: Sustana Dev Team
 * Date: June 2026 (v2)
 */

define(['N/search', 'N/ui/serverWidget', 'N/format', 'N/log'],
    function(search, serverWidget, format, log) {

        const MS_PER_DAY = 1000 * 60 * 60 * 24;

        function onRequest(context) {
            try {
                if (context.request.method === 'GET') {
                    render(context);
                } else {
                    context.response.write({ output: 'POST not supported.' });
                }
            } catch (e) {
                log.error('SUST_SL_SettlementCloseDashboard failed',
                    `${e.message}\n${e.stack}`);
                context.response.write({
                    output: '<h2 style="color:#dc2626;">Error</h2><pre>' +
                            String(e.message).replace(/[<>]/g, '') + '</pre>'
                });
            }
        }

        function render(context) {
            const daysThreshold = parseInt(context.request.parameters.days) || 30;

            const form = serverWidget.createForm({
                title: 'Sustana Recovery — Settlement Close-Out Dashboard'
            });

            const banner = form.addField({
                id: 'custpage_banner',
                type: serverWidget.FieldType.INLINEHTML,
                label: ' '
            });
            banner.defaultValue =
                '<div style="border: 2px solid #4f46e5; background: #e0e7ff; color: #312e81;' +
                ' padding: 14px 16px; margin: 8px 0; border-radius: 6px; font-family: Arial, sans-serif;">' +
                '  <div style="font-weight: bold; font-size: 14px; margin-bottom: 6px;">Settlement Close-Out Dashboard</div>' +
                '  <div style="font-size: 13px;">' +
                '    Open settlements (Draft / Completed / Provisional Paid) older than ' + daysThreshold + ' days. ' +
                '    Feeds the Controller\'s month-end close checklist — every row here needs Final Settled or Voided before the period can close cleanly.' +
                '  </div>' +
                '</div>';

            // Days threshold field
            const daysField = form.addField({
                id: 'custpage_days',
                type: serverWidget.FieldType.INTEGER,
                label: 'Days Threshold'
            });
            daysField.defaultValue = daysThreshold;
            daysField.setHelpText({
                help: 'Show settlements older than this many days. Default 30 (= standard processing-to-pay window).'
            });

            form.addSubmitButton({ label: 'Refresh' });

            // Build + render the result table
            const results = querySettlements(daysThreshold);

            const tableField = form.addField({
                id: 'custpage_table',
                type: serverWidget.FieldType.INLINEHTML,
                label: 'Open Settlements'
            });
            tableField.defaultValue = renderTable(results, daysThreshold);

            // Summary tile
            const summaryField = form.addField({
                id: 'custpage_summary',
                type: serverWidget.FieldType.INLINEHTML,
                label: 'Summary'
            });
            summaryField.defaultValue = renderSummary(results, daysThreshold);

            context.response.writePage(form);
        }

        // ───────────────────────────────────────────────────────────────────────
        // Search
        // ───────────────────────────────────────────────────────────────────────

        function querySettlements(daysThreshold) {
            const results = [];
            const today = new Date();

            try {
                search.create({
                    type: 'customrecord_sust_settlement_record',
                    filters: [
                        ['custrecord_sust_settlement_status', 'anyof', '@NONE@', 'noneof', '__final__'],
                        // We filter status client-side because list values vary
                    ],
                    columns: [
                        'internalid',
                        'name',
                        'custrecord_sust_settlement_vendor',
                        'custrecord_sust_settlement_status',
                        'custrecord_sust_settlement_mode',
                        'custrecord_sust_settlement_method',
                        'custrecord_sust_settlement_date',
                        'custrecord_sust_settlement_net_value',
                        'custrecord_sust_settlement_balance_due',
                        'custrecord_sust_settlement_price_fixed',
                        'custrecord_sust_settlement_processing'
                    ]
                }).run().each(function(row) {
                    const statusText = row.getText({ name: 'custrecord_sust_settlement_status' }) || '';

                    // Skip closed states
                    if (statusText === 'Final Settled' || statusText === 'Voided') return true;

                    // Parse date + compute age
                    const dateStr = row.getValue({ name: 'custrecord_sust_settlement_date' });
                    let dateObj = null;
                    let ageDays = 0;
                    if (dateStr) {
                        try {
                            dateObj = format.parse({ value: dateStr, type: format.Type.DATE });
                            ageDays = Math.floor((today - dateObj) / MS_PER_DAY);
                        } catch (e) {}
                    }

                    if (ageDays < daysThreshold) return true; // skip younger items

                    results.push({
                        id: row.id,
                        name: row.getValue({ name: 'name' }),
                        vendorText: row.getText({ name: 'custrecord_sust_settlement_vendor' }),
                        vendorId: row.getValue({ name: 'custrecord_sust_settlement_vendor' }),
                        statusText: statusText,
                        modeText: row.getText({ name: 'custrecord_sust_settlement_mode' }) || '',
                        methodText: row.getText({ name: 'custrecord_sust_settlement_method' }) || '',
                        date: dateObj,
                        ageDays: ageDays,
                        netValue: parseFloat(row.getValue({ name: 'custrecord_sust_settlement_net_value' })) || 0,
                        balanceDue: parseFloat(row.getValue({ name: 'custrecord_sust_settlement_balance_due' })) || 0,
                        priceFixed: row.getValue({ name: 'custrecord_sust_settlement_price_fixed' }),
                        processingId: row.getValue({ name: 'custrecord_sust_settlement_processing' })
                    });
                    return true;
                });
            } catch (e) {
                log.error('querySettlements failed', e.message);
            }

            // Sort by age descending (oldest first)
            results.sort(function(a, b) { return b.ageDays - a.ageDays; });
            return results;
        }

        // ───────────────────────────────────────────────────────────────────────
        // Rendering
        // ───────────────────────────────────────────────────────────────────────

        function renderSummary(results, daysThreshold) {
            const counts = { ok: 0, watch: 0, stale: 0 };
            let totalBalance = 0;
            let priceNotFixedCount = 0;

            results.forEach(function(r) {
                if (r.ageDays <= daysThreshold) counts.ok++;
                else if (r.ageDays <= 60) counts.watch++;
                else counts.stale++;
                totalBalance += r.balanceDue;
                if (r.priceFixed !== true && r.priceFixed !== 'T') priceNotFixedCount++;
            });

            // v2.2: also count processing records in Awaiting Cost state.
            // These are blocking IA creation — they need the linked settlement to close.
            const awaitingCostCount = countAwaitingCostProcessing();

            return ''
                + '<div style="display: flex; gap: 12px; font-family: Arial, sans-serif; font-size: 13px;">'
                + tile('🟡 Watch (' + (daysThreshold + 1) + '–60 days)', counts.watch, '#fef3c7', '#d97706', '#78350f')
                + tile('🔴 Stale (>60 days)', counts.stale, '#fee2e2', '#dc2626', '#7f1d1d')
                + tile('💰 Total Balance Due', '$' + round2(totalBalance), '#dbeafe', '#2563eb', '#1e3a8a')
                + tile('🔒 Index Price Not Fixed', priceNotFixedCount, '#e0e7ff', '#4f46e5', '#312e81')
                + tile('⏳ Awaiting Cost (Proc)', awaitingCostCount, '#fefaf0', '#b87f00', '#5a3d00')
                + '</div>';
        }

        // v2.2: count processing records in Awaiting Cost status — these are deferred-pricing
        // records whose IA has not been created because the linked settlement has not yet been
        // completed. Showing this on the dashboard surfaces the bottleneck.
        function countAwaitingCostProcessing() {
            try {
                const ss = search.create({
                    type: 'customrecord_sust_processing_record',
                    filters: [
                        ['custrecord_sust_processing_status', 'is', resolveAwaitingCostId()]
                    ],
                    columns: ['internalid']
                });
                const range = ss.run().getRange({ start: 0, end: 1000 });
                return range.length;
            } catch (e) {
                log.error('Awaiting Cost count failed', e.message);
                return 0;
            }
        }

        let _awaitingCostId = null;
        function resolveAwaitingCostId() {
            if (_awaitingCostId) return _awaitingCostId;
            try {
                const listSearch = search.create({
                    type: 'customlist_sust_processing_status',
                    filters: [['name', 'is', 'Awaiting Cost']],
                    columns: ['internalid']
                });
                const r = listSearch.run().getRange({ start: 0, end: 1 });
                if (r.length > 0) {
                    _awaitingCostId = r[0].id;
                    return _awaitingCostId;
                }
            } catch (e) {
                log.error('resolveAwaitingCostId failed', e.message);
            }
            return null;
        }

        function tile(label, value, bgColor, borderColor, textColor) {
            return ''
                + '<div style="flex: 1; border: 2px solid ' + borderColor + '; background: ' + bgColor + '; color: ' + textColor + ';'
                + ' padding: 12px; border-radius: 6px; text-align: center;">'
                + '  <div style="font-size: 11px; opacity: 0.85;">' + label + '</div>'
                + '  <div style="font-size: 24px; font-weight: bold; margin-top: 4px;">' + value + '</div>'
                + '</div>';
        }

        function renderTable(results, daysThreshold) {
            if (results.length === 0) {
                return '<div style="padding: 20px; color: #6b7280; font-style: italic; font-family: Arial, sans-serif;">' +
                    'No open settlements past ' + daysThreshold + ' days. ✓ All clear.</div>';
            }

            const rows = results.map(function(r) {
                let ageColor = '#374151';
                let ageBadge = '';
                if (r.ageDays > 60) {
                    ageColor = '#7f1d1d';
                    ageBadge = '<span style="background:#fee2e2; color:#7f1d1d; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-left: 4px;">STALE</span>';
                } else if (r.ageDays > daysThreshold) {
                    ageColor = '#78350f';
                    ageBadge = '<span style="background:#fef3c7; color:#78350f; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-left: 4px;">WATCH</span>';
                }

                const priceFlag = (r.priceFixed !== true && r.priceFixed !== 'T')
                    ? '<span style="background:#e0e7ff; color:#312e81; padding: 2px 6px; border-radius: 4px; font-size: 11px;">Index Price Not Fixed</span>'
                    : '';

                return ''
                    + '<tr>'
                    + '  <td style="padding: 6px 10px; border-bottom: 1px solid #e5e7eb;">'
                    + '    <a href="/app/common/custom/custrecordentry.nl?rectype=' + r.id + '&id=' + r.id + '" style="color:#2563eb;">' + escapeHtml(r.name || ('#' + r.id)) + '</a>'
                    + '  </td>'
                    + '  <td style="padding: 6px 10px; border-bottom: 1px solid #e5e7eb;">' + escapeHtml(r.vendorText || ('Vendor ' + r.vendorId)) + '</td>'
                    + '  <td style="padding: 6px 10px; border-bottom: 1px solid #e5e7eb;">' + escapeHtml(r.statusText) + '</td>'
                    + '  <td style="padding: 6px 10px; border-bottom: 1px solid #e5e7eb;">' + escapeHtml(r.modeText) + '</td>'
                    + '  <td style="padding: 6px 10px; border-bottom: 1px solid #e5e7eb;">' + (r.date ? format.format({ value: r.date, type: format.Type.DATE }) : '—') + '</td>'
                    + '  <td style="padding: 6px 10px; border-bottom: 1px solid #e5e7eb; color: ' + ageColor + '; font-weight: ' + (r.ageDays > daysThreshold ? 'bold' : 'normal') + ';">'
                    +      r.ageDays + ' days ' + ageBadge
                    + '  </td>'
                    + '  <td style="padding: 6px 10px; border-bottom: 1px solid #e5e7eb; text-align: right;">$' + round2(r.netValue) + '</td>'
                    + '  <td style="padding: 6px 10px; border-bottom: 1px solid #e5e7eb; text-align: right; font-weight: bold;">$' + round2(r.balanceDue) + '</td>'
                    + '  <td style="padding: 6px 10px; border-bottom: 1px solid #e5e7eb;">' + priceFlag + '</td>'
                    + '</tr>';
            }).join('');

            return ''
                + '<div style="font-family: Arial, sans-serif; font-size: 13px; margin-top: 12px;">'
                + '  <table style="width: 100%; border-collapse: collapse; border: 1px solid #d1d5db;">'
                + '    <thead style="background: #f3f4f6;">'
                + '      <tr>'
                + '        <th style="padding: 8px 10px; text-align: left;">Settlement</th>'
                + '        <th style="padding: 8px 10px; text-align: left;">Vendor</th>'
                + '        <th style="padding: 8px 10px; text-align: left;">Status</th>'
                + '        <th style="padding: 8px 10px; text-align: left;">Mode</th>'
                + '        <th style="padding: 8px 10px; text-align: left;">Date</th>'
                + '        <th style="padding: 8px 10px; text-align: left;">Age</th>'
                + '        <th style="padding: 8px 10px; text-align: right;">Net Value</th>'
                + '        <th style="padding: 8px 10px; text-align: right;">Balance Due</th>'
                + '        <th style="padding: 8px 10px; text-align: left;">Flags</th>'
                + '      </tr>'
                + '    </thead>'
                + '    <tbody>' + rows + '</tbody>'
                + '  </table>'
                + '  <p style="margin-top: 10px; color: #6b7280; font-size: 12px;">'
                + '    ' + results.length + ' open settlement(s) past ' + daysThreshold + ' days. Sorted oldest-first.'
                + '  </p>'
                + '</div>';
        }

        function round2(n) { return Math.round(n * 100) / 100; }

        function escapeHtml(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
        }

        return {
            onRequest: onRequest
        };
    });
