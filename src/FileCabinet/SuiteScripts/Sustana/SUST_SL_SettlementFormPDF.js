/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */

/**
 * SUST_SL_SettlementFormPDF.js
 *
 * v2 (June 2026): Sustana Recovery Settlement Form PDF generator.
 *
 * Renders a settlement record as a vendor-facing PDF using NetSuite's
 * BFO PDF engine (N/render.xmlToPdf). The settlement form is the primary
 * vendor document — per discovery, ~80% of Sustana Recovery vendors do not send
 * formal invoices, treating this PDF as their bill of lading + receipt.
 *
 * Sections (all rendered; conditional toggles added in Chunk CC):
 *   1. Header — Sustana Recovery branding + settlement #/date
 *   2. Vendor block — vendor name + Item Receipt reference
 *   3. Weights & Yield
 *   4. Pricing detail
 *   5. Deductions (processing charge + quality deductions)
 *   6. Net & Balance Due
 *   7. Footer — disclaimer / dispute window
 *
 * Usage: /app/site/hosting/scriptlet.nl?script=customscript_sust_sl_settle_pdf
 *        &deploy=customdeploy_sust_sl_settle_pdf&settle=123
 *
 * Author: Sustana Dev Team
 * Date: June 2026 (v2)
 */

define(['N/record', 'N/search', 'N/render', 'N/format', 'N/email', 'N/runtime', 'N/log', './SUST_Lib_Units'],
    function(record, search, render, format, email, runtime, log, unitsLib) {

        function onRequest(context) {
            try {
                const settleId = context.request.parameters.settle;
                const emailMode = context.request.parameters.email === 'T';

                if (!settleId) {
                    context.response.write({
                        output: '<h2>Missing settlement parameter</h2><p>Pass ?settle=&lt;id&gt; in URL.</p>'
                    });
                    return;
                }

                const data = loadSettlementData(settleId);
                const xml = buildXml(data);
                const pdfFile = render.xmlToPdf({ xmlString: xml });
                pdfFile.name = 'Settlement_' + (data.settleNumber || settleId) + '.pdf';

                if (emailMode) {
                    const result = emailToVendor(data, pdfFile);
                    context.response.write({
                        output: renderEmailResultHtml(result, settleId)
                    });
                } else {
                    context.response.writeFile({
                        file: pdfFile,
                        isInline: true
                    });
                }
            } catch (e) {
                log.error('SUST_SL_SettlementFormPDF failed',
                    `${e.message}\n${e.stack}`);
                context.response.write({
                    output: '<h2 style="color:#dc2626;">Error rendering settlement PDF</h2><pre>' +
                            String(e.message).replace(/[<>]/g, '') + '</pre>'
                });
            }
        }

        // ───────────────────────────────────────────────────────────────────────
        // Email send
        // ───────────────────────────────────────────────────────────────────────

        function emailToVendor(data, pdfFile) {
            const result = { sent: false, message: '', recipientEmail: null, vendorName: data.vendorName };

            // Vendor primary email
            let vendorEmail = '';
            try {
                const vlookup = search.lookupFields({
                    type: search.Type.VENDOR,
                    id: data.vendorId || null, // safety
                    columns: ['email']
                });
                vendorEmail = vlookup.email || '';
            } catch (e) {
                // try alternate
            }

            // Fallback: use the loaded record's vendor ID if not in data
            if (!vendorEmail) {
                try {
                    const settle = record.load({ type: 'customrecord_sust_settlement_record', id: data.settleId });
                    const vid = settle.getValue({ fieldId: 'custrecord_sust_settlement_vendor' });
                    if (vid) {
                        const v2 = search.lookupFields({ type: search.Type.VENDOR, id: vid, columns: ['email'] });
                        vendorEmail = v2.email || '';
                        result.recipientEmail = vendorEmail;
                    }
                } catch (e) { /* skip */ }
            }
            result.recipientEmail = vendorEmail;

            if (!vendorEmail) {
                result.message = 'Vendor "' + data.vendorName + '" has no email address on file. Add an email to the vendor record, then retry.';
                return result;
            }

            try {
                email.send({
                    author: runtime.getCurrentUser().id,
                    recipients: vendorEmail,
                    subject: 'Sustana Recovery Settlement — ' + (data.settleNumber || 'Settlement') + ' — $' + Math.abs(data.balanceDue || data.netValue).toFixed(2),
                    body: 'Please find attached your settlement form for ' + (data.settleNumber || 'this settlement') + '.\n\n'
                        + 'If you have any questions about the calculations, contact Sustana Recovery within 7 business days.\n\n'
                        + 'Thank you,\nSustana Recovery',
                    attachments: [pdfFile]
                });
                result.sent = true;
                result.message = 'Settlement form emailed to ' + vendorEmail;
                log.audit('Settlement Form Emailed',
                    `Settlement ${data.settleId} → ${vendorEmail}`);
            } catch (e) {
                result.message = 'Send failed: ' + e.message;
                log.error('email.send failed', e.message);
            }
            return result;
        }

        function renderEmailResultHtml(result, settleId) {
            const color = result.sent ? '#059669' : '#dc2626';
            const bg = result.sent ? '#d1fae5' : '#fee2e2';
            const icon = result.sent ? '✓' : '✗';
            return ''
                + '<div style="font-family: Arial, sans-serif; padding: 24px; max-width: 600px; margin: 40px auto;">'
                + '  <div style="border: 2px solid ' + color + '; background: ' + bg + '; padding: 16px 20px; border-radius: 6px;">'
                + '    <div style="font-size: 18px; font-weight: bold; color: ' + color + '; margin-bottom: 8px;">'
                + '      ' + icon + ' ' + (result.sent ? 'Email sent' : 'Email NOT sent')
                + '    </div>'
                + '    <div style="font-size: 14px; color: #1f2937;">' + esc(result.message) + '</div>'
                + (result.recipientEmail ? '    <div style="font-size: 13px; margin-top: 6px; color: #6b7280;">Recipient: ' + esc(result.recipientEmail) + ' (' + esc(result.vendorName) + ')</div>' : '')
                + '  </div>'
                + '  <div style="margin-top: 16px;">'
                + '    <a href="/app/common/custom/custrecordentry.nl?rectype=&id=' + settleId + '" style="color: #2563eb;">← Back to settlement</a>'
                + '  </div>'
                + '</div>';
        }

        // ───────────────────────────────────────────────────────────────────────
        // Data loading
        // ───────────────────────────────────────────────────────────────────────

        function loadSettlementData(settleId) {
            const settle = record.load({
                type: 'customrecord_sust_settlement_record',
                id: settleId
            });

            const vendorId = settle.getValue({ fieldId: 'custrecord_sust_settlement_vendor' });
            const scheduleId = settle.getValue({ fieldId: 'custrecord_sust_settlement_schedule' });
            const irId = settle.getValue({ fieldId: 'custrecord_sust_settlement_item_receipt' });

            // Vendor info
            let vendorName = '', vendorAddress = '';
            try {
                const vlookup = search.lookupFields({
                    type: search.Type.VENDOR,
                    id: vendorId,
                    columns: ['entityid', 'billingaddress']
                });
                vendorName = vlookup.entityid || '';
                vendorAddress = vlookup.billingaddress || '';
            } catch (e) {
                log.debug('vendor lookup', e.message);
            }

            // Schedule reference
            let scheduleName = '';
            let scheduleMethodText = '';
            try {
                if (scheduleId) {
                    const sLookup = search.lookupFields({
                        type: 'customrecord_sust_settlement_schedule',
                        id: scheduleId,
                        columns: [
                            'name',
                            'custrecord_sust_schedule_method'
                        ]
                    });
                    scheduleName = sLookup.name || '';
                    const methodArr = sLookup.custrecord_sust_schedule_method;
                    if (methodArr) {
                        scheduleMethodText = (Array.isArray(methodArr) && methodArr.length)
                            ? methodArr[0].text || ''
                            : '';
                    }
                }
            } catch (e) {
                log.debug('schedule lookup', e.message);
            }

            // Quality-deduction detail records
            const penalties = [];
            try {
                search.create({
                    type: 'customrecord_sust_penalty_detail',
                    filters: [['custrecord_sust_penalty_settlement', 'anyof', settleId]],
                    columns: [
                        'custrecord_sust_penalty_settlement',
                        'custrecord_sust_penalty_detail_element',
                        'custrecord_sust_penalty_detail_amount'
                    ]
                }).run().each(function(row) {
                    penalties.push({
                        element: row.getText({ name: 'custrecord_sust_penalty_detail_element' }) || '',
                        amount: parseFloat(row.getValue({ name: 'custrecord_sust_penalty_detail_amount' })) || 0
                    });
                    return true;
                });
            } catch (e) {
                log.debug('penalties search', e.message);
            }

            // IR reference
            let irNumber = '';
            try {
                if (irId) {
                    const irLookup = search.lookupFields({
                        type: search.Type.ITEM_RECEIPT,
                        id: irId,
                        columns: ['tranid']
                    });
                    irNumber = irLookup.tranid || '';
                }
            } catch (e) { /* skip */ }

            return {
                settleId: settleId,
                settleNumber: settle.getValue({ fieldId: 'name' }) || ('#' + settleId),
                settleDate: settle.getValue({ fieldId: 'custrecord_sust_settlement_date' }),
                statusText: settle.getText({ fieldId: 'custrecord_sust_settlement_status' }) || '',
                modeText: settle.getText({ fieldId: 'custrecord_sust_settlement_mode' }) || '',
                methodText: settle.getText({ fieldId: 'custrecord_sust_settlement_method' }) || scheduleMethodText,
                vendorName: vendorName,
                vendorAddress: vendorAddress,
                irNumber: irNumber,
                grossLbs: parseFloat(settle.getValue({ fieldId: 'custrecord_sust_settlement_gross_lbs' })) || 0,
                netLbs: parseFloat(settle.getValue({ fieldId: 'custrecord_sust_settlement_net_lbs' })) || 0,
                recoveryPct: parseFloat(settle.getValue({ fieldId: 'custrecord_sust_settlement_recovery_pct' })) || 0,
                marketPrice: parseFloat(settle.getValue({ fieldId: 'custrecord_sust_settlement_market_price' })) || 0,
                treatment: parseFloat(settle.getValue({ fieldId: 'custrecord_sust_settlement_treatment' })) || 0,
                penaltiesTotal: parseFloat(settle.getValue({ fieldId: 'custrecord_sust_settlement_penalties' })) || 0,
                grossValue: parseFloat(settle.getValue({ fieldId: 'custrecord_sust_settlement_gross_value' })) || 0,
                netValue: parseFloat(settle.getValue({ fieldId: 'custrecord_sust_settlement_net_value' })) || 0,
                provisional: parseFloat(settle.getValue({ fieldId: 'custrecord_sust_settlement_provisional' })) || 0,
                balanceDue: parseFloat(settle.getValue({ fieldId: 'custrecord_sust_settlement_balance_due' })) || 0,
                notes: settle.getValue({ fieldId: 'custrecord_sust_settlement_notes' }) || '',
                scheduleName: scheduleName,
                penalties: penalties,

                // v2 Chunk CC: section visibility toggles (default checked if unset)
                showDeductions: notFalse(settle.getValue({ fieldId: 'custrecord_sust_settle_show_deduct' })),
                showTreatment:  notFalse(settle.getValue({ fieldId: 'custrecord_sust_settle_show_treat' })),
                showPenalties:  notFalse(settle.getValue({ fieldId: 'custrecord_sust_settle_show_pen' }))
            };
        }

        // Treat null/undefined/empty as TRUE (default-shown) so legacy records without
        // these fields still render the full form
        function notFalse(v) {
            if (v === false || v === 'F' || v === 'f') return false;
            return true;
        }

        // ───────────────────────────────────────────────────────────────────────
        // XML/PDF rendering
        // ───────────────────────────────────────────────────────────────────────

        function buildXml(d) {
            const dateStr = d.settleDate
                ? format.format({ value: new Date(d.settleDate), type: format.Type.DATE })
                : '';

            const xml = ''
                + '<?xml version="1.0"?>'
                + '<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report" "report-1.1.dtd">'
                + '<pdf>'
                + '  <head>'
                + '    <style>'
                + '      body { font-family: Helvetica, sans-serif; font-size: 10pt; color: #1f2937; }'
                + '      h1 { font-size: 18pt; margin: 0; color: #1e3a8a; }'
                + '      h2 { font-size: 12pt; margin: 12pt 0 6pt 0; color: #1e3a8a; border-bottom: 1px solid #d1d5db; padding-bottom: 3pt; }'
                + '      table { border-collapse: collapse; width: 100%; }'
                + '      td { padding: 4pt 6pt; vertical-align: top; }'
                + '      .label { color: #6b7280; font-weight: bold; width: 40%; }'
                + '      .value { width: 60%; }'
                + '      .right { text-align: right; }'
                + '      .totals { background-color: #f3f4f6; font-weight: bold; }'
                + '      .grand-total { background-color: #dbeafe; font-weight: bold; font-size: 12pt; }'
                + '      .small { font-size: 8pt; color: #6b7280; }'
                + '      .header-bar { background-color: #1e3a8a; color: white; padding: 8pt; }'
                + '      .section-header { background-color: #e5e7eb; padding: 4pt 6pt; font-weight: bold; }'
                + '    </style>'
                + '  </head>'
                + '  <body padding="36pt 40pt 36pt 40pt" size="letter">'

                // ── Header ──
                + '    <table class="header-bar">'
                + '      <tr>'
                + '        <td style="color:white; font-weight:bold; font-size:14pt;">SUSTANA RECOVERY SETTLEMENT FORM</td>'
                + '        <td class="right" style="color:white;">'
                + '          ' + esc(d.settleNumber) + '<br/>'
                + '          ' + esc(dateStr)
                + '        </td>'
                + '      </tr>'
                + '    </table>'

                // ── Status banner ──
                + '    <table style="margin-top:8pt;">'
                + '      <tr>'
                + '        <td>'
                + '          <b>Status:</b> ' + esc(d.statusText) + ' &#160;&#160; '
                + '          <b>Mode:</b> ' + esc(d.modeText) + ' &#160;&#160; '
                + '          <b>Method:</b> ' + esc(d.methodText)
                + '        </td>'
                + '      </tr>'
                + '    </table>'

                // ── Vendor block ──
                + '    <h2>Vendor</h2>'
                + '    <table>'
                + '      <tr>'
                + '        <td style="width:50%;">'
                + '          <b>' + esc(d.vendorName) + '</b><br/>'
                + multilineToXml(d.vendorAddress)
                + '        </td>'
                + '        <td class="right" style="width:50%;">'
                + (d.irNumber ? ('<div><span class="label">Item Receipt:</span> ' + esc(d.irNumber) + '</div>') : '')
                + (d.scheduleName ? ('<div><span class="label">Schedule:</span> ' + esc(d.scheduleName) + '</div>') : '')
                + '        </td>'
                + '      </tr>'
                + '    </table>'

                // ── Weights & Yield ──
                + '    <h2>Weights &#38; Yield</h2>'
                + '    <table>'
                + '      <tr><td class="label">Gross Weight Received</td><td class="value right">' + fmtLbsTons(d.grossLbs) + '</td></tr>'
                + '      <tr><td class="label">Net Weight</td><td class="value right">' + fmtLbsTons(d.netLbs) + '</td></tr>'
                + (d.recoveryPct > 0 ? '      <tr><td class="label">Yield %</td><td class="value right">' + fmtPct(d.recoveryPct) + '</td></tr>' : '')
                + '    </table>'

                // ── Pricing ──
                + '    <h2>Pricing</h2>'
                + '    <table>'
                + '      <tr><td class="label">Market Price ($/lb)</td><td class="value right">' + fmt$(d.marketPrice) + ' (' + esc(unitsLib.formatPerTon(d.marketPrice)) + ')</td></tr>'
                + '      <tr><td class="label">Gross Settlement Value</td><td class="value right">' + fmt$(d.grossValue) + '</td></tr>'
                + '    </table>'

                // ── Deductions ──
                + buildDeductionsSection(d)

                // ── Net & Balance ──
                + '    <h2>Settlement Totals</h2>'
                + '    <table>'
                + '      <tr class="totals"><td>Net Settlement Value</td><td class="right">' + fmt$(d.netValue) + '</td></tr>'
                + (d.provisional > 0 ? '      <tr><td class="label">Less: Provisional Paid</td><td class="value right">(' + fmt$(d.provisional) + ')</td></tr>' : '')
                + '      <tr class="grand-total"><td>Balance Due</td><td class="right">' + fmt$(d.balanceDue) + '</td></tr>'
                + '    </table>'

                // ── Notes ──
                + (d.notes ? buildNotesSection(d.notes) : '')

                // ── Footer ──
                + '    <p class="small" style="margin-top:24pt;">'
                + '      This settlement form is the basis for vendor payment. '
                + '      If you disagree with any of the calculations above, please contact Sustana Recovery within 7 business days. '
                + '      Generated automatically by NetSuite on ' + esc(dateStr) + '.'
                + '    </p>'

                + '  </body>'
                + '</pdf>';

            return xml;
        }

        function buildDeductionsSection(d) {
            // Master deductions toggle off — hide entirely
            if (!d.showDeductions) return '';
            if (d.treatment <= 0 && d.penaltiesTotal <= 0) return '';

            let html = '    <h2>Deductions</h2>    <table>';
            let visibleTotal = 0;

            if (d.showTreatment && d.treatment > 0) {
                html += '      <tr><td class="label">Processing Charge</td><td class="value right">(' + fmt$(d.treatment) + ')</td></tr>';
                visibleTotal += d.treatment;
            }
            if (d.showPenalties) {
                if (d.penalties.length > 0) {
                    d.penalties.forEach(function(p) {
                        html += '      <tr><td class="label">Penalty &#8211; ' + esc(p.element) + '</td><td class="value right">(' + fmt$(p.amount) + ')</td></tr>';
                    });
                } else if (d.penaltiesTotal > 0) {
                    html += '      <tr><td class="label">Penalties</td><td class="value right">(' + fmt$(d.penaltiesTotal) + ')</td></tr>';
                }
                visibleTotal += d.penaltiesTotal;
            }
            if (visibleTotal > 0) {
                html += '      <tr class="totals"><td>Total Deductions</td><td class="right">(' + fmt$(visibleTotal) + ')</td></tr>';
            }
            html += '    </table>';
            return html;
        }

        function buildNotesSection(notes) {
            return ''
                + '    <h2>Notes</h2>'
                + '    <table>'
                + '      <tr><td>' + multilineToXml(notes) + '</td></tr>'
                + '    </table>';
        }

        // ───────────────────────────────────────────────────────────────────────
        // Helpers
        // ───────────────────────────────────────────────────────────────────────

        function esc(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function multilineToXml(s) {
            return esc(s || '').replace(/\n/g, '<br/>');
        }

        function fmt$(n) {
            const v = Math.abs(parseFloat(n) || 0);
            return '$' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        }
        function fmtLbs(n) {
            const v = parseFloat(n) || 0;
            return v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' lb';
        }
        // Display rule: values are stored in lbs; tons shown in parentheses for reference.
        function fmtLbsTons(n) {
            return fmtLbs(n) + ' (' + unitsLib.formatTons(n) + ')';
        }
        function fmtPct(n) {
            const v = parseFloat(n) || 0;
            return v.toFixed(2) + '%';
        }

        return {
            onRequest: onRequest
        };
    });
