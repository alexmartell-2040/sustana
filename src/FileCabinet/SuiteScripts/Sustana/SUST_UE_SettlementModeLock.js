/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */

/**
 * SUST_UE_SettlementModeLock.js
 *
 * v2 (June 2026): Mode-driven field-lock for the Sustana Recovery Settlement Record.
 * Implements SETTLE-001's field-lock policy.
 *
 * Modes:
 *   - Auto       : schedule-driven; all calc fields locked (read-only)
 *   - Custom     : analyst override; all calc fields editable
 *   - Calculator : freeform handshake; calc fields editable, no IR required
 *
 * beforeLoad:
 *   - Auto-defaults mode if not set:
 *       * If a pricing schedule is attached → Auto
 *       * Else → Custom
 *   - Locks/unlocks calc fields based on mode
 *   - Renders a mode banner explaining current behavior
 *   - If Final Settled, locks ALL fields regardless of mode
 *
 * beforeSubmit:
 *   - Validates mode-specific requirements
 *   - Logs audit
 *
 * Author: Sustana Dev Team
 * Date: June 2026 (v2)
 */

define(['N/record', 'N/search', 'N/runtime', 'N/url', 'N/log', 'N/ui/serverWidget'],
    function(record, search, runtime, url, log, serverWidget) {

        // Calc/derived fields that lock in Auto mode
        const CALC_FIELDS = [
            'custrecord_sust_settlement_gross_lbs',
            'custrecord_sust_settlement_net_lbs',
            'custrecord_sust_settlement_recovery_pct',
            'custrecord_sust_settlement_market_price',
            'custrecord_sust_settlement_treatment',
            'custrecord_sust_settlement_penalties',
            'custrecord_sust_settlement_gross_value',
            'custrecord_sust_settlement_net_value',
            'custrecord_sust_settlement_balance_due'
        ];

        // Fields ALWAYS locked once Final Settled
        const ALL_FIELDS_AT_FINAL = CALC_FIELDS.concat([
            'custrecord_sust_settlement_method',
            'custrecord_sust_settlement_mode',
            'custrecord_sust_settlement_schedule',
            'custrecord_sust_settlement_provisional',
            'custrecord_sust_settlement_vendor',
            'custrecord_sust_settlement_item_receipt',
            'custrecord_sust_settlement_price_fixed'
        ]);

        function beforeLoad(context) {
            try {
                if (context.type !== context.UserEventType.VIEW &&
                    context.type !== context.UserEventType.EDIT &&
                    context.type !== context.UserEventType.CREATE) {
                    return;
                }

                const rec = context.newRecord;
                const form = context.form;

                // Auto-default mode on CREATE if not set
                if (context.type === context.UserEventType.CREATE) {
                    const currentMode = rec.getValue({ fieldId: 'custrecord_sust_settlement_mode' });
                    if (!currentMode) {
                        const hasSchedule = rec.getValue({ fieldId: 'custrecord_sust_settlement_schedule' });
                        const defaultMode = hasSchedule ? 'Auto' : 'Custom';
                        try {
                            rec.setText({ fieldId: 'custrecord_sust_settlement_mode', text: defaultMode });
                            log.audit('Mode Defaulted',
                                `New settlement defaulted to ${defaultMode} mode (schedule ${hasSchedule ? 'present' : 'absent'}).`);
                        } catch (e) {
                            log.debug('Mode default skipped', e.message);
                        }
                    }
                }

                const modeText = (rec.getText({ fieldId: 'custrecord_sust_settlement_mode' }) || '').trim();
                const statusText = (rec.getText({ fieldId: 'custrecord_sust_settlement_status' }) || '').trim();

                // On VIEW, no need to disable fields (everything's already display-only)
                if (context.type === context.UserEventType.VIEW) {
                    renderStatusButtons(form, rec, statusText);
                    renderModeBanner(form, modeText, statusText);
                    renderAggregationPanel(form, rec);
                    renderActionLinks(form, rec.id);
                    return;
                }

                // EDIT/CREATE: lock fields per mode + status
                applyFieldLocks(form, modeText, statusText);
                renderModeBanner(form, modeText, statusText);
                renderAggregationPanel(form, rec);
                renderActionLinks(form, rec.id);

            } catch (e) {
                log.error('SUST_UE_SettlementModeLock.beforeLoad failed',
                    `Error: ${e.message}\nStack: ${e.stack}`);
            }
        }

        function beforeSubmit(context) {
            try {
                if (context.type !== context.UserEventType.CREATE &&
                    context.type !== context.UserEventType.EDIT) {
                    return;
                }

                const rec = context.newRecord;
                const modeText = (rec.getText({ fieldId: 'custrecord_sust_settlement_mode' }) || '').trim();
                const statusText = (rec.getText({ fieldId: 'custrecord_sust_settlement_status' }) || '').trim();
                const priceFixed = rec.getValue({ fieldId: 'custrecord_sust_settlement_price_fixed' });

                // v2 SETTLE-012: block Final Settled when price is not yet fixed
                if (statusText === 'Final Settled' && priceFixed !== true && priceFixed !== 'T') {
                    const errMsg = 'Cannot transition this settlement to Final Settled — Price Fixed flag is unchecked. ' +
                        'Some settlements wait for the customer/vendor to lock the market price on a future date ' +
                        '(per Costing Review). Check the "Price Fixed" box on the Main tab once pricing has locked, then save.';
                    log.error('Final Settled BLOCKED — Price Not Fixed', errMsg);
                    throw {
                        name: 'PRICE_NOT_FIXED',
                        message: errMsg,
                        toString: function() { return errMsg; }
                    };
                }

                // Mode-specific validation
                if (modeText === 'Calculator') {
                    // Calculator mode allows no IR; just confirm vendor + weight + value
                    const vendor = rec.getValue({ fieldId: 'custrecord_sust_settlement_vendor' });
                    const grossLbs = parseFloat(rec.getValue({ fieldId: 'custrecord_sust_settlement_gross_lbs' })) || 0;
                    const netValue = parseFloat(rec.getValue({ fieldId: 'custrecord_sust_settlement_net_value' })) || 0;
                    if (!vendor || grossLbs <= 0 || netValue <= 0) {
                        log.audit('Calculator Mode Validation',
                            `Settlement ${rec.id || 'new'}: Calculator mode expects vendor + gross_lbs + net_value. Got vendor=${vendor}, gross=${grossLbs}, value=${netValue}. Save proceeds (non-blocking).`);
                    }
                }

                log.audit('Settlement Save', `Settlement ${rec.id || 'new'} saving in ${modeText || 'unset'} mode, status ${statusText || 'unset'}.`);

            } catch (e) {
                if (e.name === 'PRICE_NOT_FIXED') throw e; // re-throw blocking error
                log.error('SUST_UE_SettlementModeLock.beforeSubmit failed', e.message);
            }
        }

        // ───────────────────────────────────────────────────────────────────────
        // Field lock logic
        // ───────────────────────────────────────────────────────────────────────

        function applyFieldLocks(form, modeText, statusText) {
            // Final Settled: lock everything
            if (statusText === 'Final Settled' || statusText === 'Voided') {
                ALL_FIELDS_AT_FINAL.forEach(function(fieldId) {
                    safeSetDisplay(form, fieldId, serverWidget.FieldDisplayType.DISABLED);
                });
                return;
            }

            // Auto mode: lock calc fields (analyst can only change status + non-calc metadata)
            if (modeText === 'Auto') {
                CALC_FIELDS.forEach(function(fieldId) {
                    safeSetDisplay(form, fieldId, serverWidget.FieldDisplayType.DISABLED);
                });
                return;
            }

            // Custom / Calculator: leave fields editable (Suitelet/UI defaults)
            // No-op; fields editable by default
        }

        function safeSetDisplay(form, fieldId, displayType) {
            try {
                const fld = form.getField({ id: fieldId });
                if (fld) fld.updateDisplayType({ displayType: displayType });
            } catch (e) {
                // Field might not exist on form (e.g., hidden by NS), skip silently
            }
        }

        // ───────────────────────────────────────────────────────────────────────
        // UI banner
        // ───────────────────────────────────────────────────────────────────────

        function renderModeBanner(form, modeText, statusText) {
            let title, body, bgColor, borderColor, textColor;

            if (statusText === 'Final Settled' || statusText === 'Voided') {
                title = '🔒 Settlement ' + statusText;
                body = 'This settlement is closed. All fields are read-only. To make changes, reopen the settlement first (admin action).';
                bgColor = '#e5e7eb'; borderColor = '#374151'; textColor = '#111827';
            } else if (modeText === 'Auto') {
                title = '⚙ Auto Mode';
                body = 'Pricing schedule + recovery + quality deductions drive the calculation. All calc fields are locked. Recalculate via the Settlement Calculation Suitelet to refresh values.';
                bgColor = '#dbeafe'; borderColor = '#2563eb'; textColor = '#1e3a8a';
            } else if (modeText === 'Custom') {
                title = '✎ Custom Mode';
                body = 'No pricing schedule applied — analyst may type any value into any calc field. Capture override rationale in Notes for audit.';
                bgColor = '#fef3c7'; borderColor = '#d97706'; textColor = '#78350f';
            } else if (modeText === 'Calculator') {
                title = '🤝 Calculator Mode (Handshake)';
                body = 'Freeform settlement — no IR or processing required. Used for known materials with established history, or quick vendor handshakes. Enter vendor + agreed weight + agreed price. Settlement can be reconciled against actual IR/WIP later.';
                bgColor = '#fce7f3'; borderColor = '#be185d'; textColor = '#831843';
            } else {
                title = '— Settlement Mode Not Set';
                body = 'Mode will default to Auto (if schedule attached) or Custom on save. Pick a mode explicitly on the Main tab to control field-lock behavior.';
                bgColor = '#f3f4f6'; borderColor = '#6b7280'; textColor = '#1f2937';
            }

            const html = ''
                + '<div style="border: 2px solid ' + borderColor + '; background: ' + bgColor + '; color: ' + textColor + ';'
                + ' padding: 12px 16px; margin: 10px 0; border-radius: 6px; font-family: Arial, sans-serif;">'
                + '  <div style="font-weight: bold; font-size: 14px; margin-bottom: 6px;">'
                +      escapeHtml(title)
                + '  </div>'
                + '  <div style="font-size: 13px;">'
                +      escapeHtml(body)
                + '  </div>'
                + '</div>';

            try {
                const fld = form.addField({
                    id: 'custpage_settle_mode_banner',
                    type: serverWidget.FieldType.INLINEHTML,
                    label: 'Settlement Mode'
                });
                fld.defaultValue = html;
            } catch (e) {
                log.debug('Banner skip', e.message);
            }
        }

        function escapeHtml(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        /**
         * v2 Chunk CC: Print + Email vendor-form action links.
         * Settlement form Suitelet handles both modes via ?email=T param.
         */
        /**
         * Lifecycle tracker + one-click actions (VIEW mode) — pizza-tracker
         * style: Draft → Approved → Provisional Paid (optional) → Final
         * Settled, with the current stage lit and the next action(s) as
         * buttons. Buttons hit SUST_SL_SettlementAction (URL resolved via
         * N/url so it always points at the live deployment); guards and
         * bill-creating UEs still fire on the server-side save.
         */
        function renderStatusButtons(form, rec, statusText) {
            try {
                if (!rec.id) return;

                let base;
                try {
                    base = url.resolveScript({
                        scriptId: 'customscript_sust_sl_settle_action',
                        deploymentId: 'customdeploy_sust_sl_settle_action'
                    }) + '&settle=' + rec.id + '&action=';
                } catch (eUrl) {
                    log.error('Settlement action Suitelet unresolvable',
                        'Deploy customscript_sust_sl_settle_action first: ' + eUrl.message);
                    base = null; // tracker still renders; buttons hidden
                }

                const priceFixed = rec.getValue({ fieldId: 'custrecord_sust_settlement_price_fixed' });
                const isFixed = (priceFixed === true || priceFixed === 'T');

                // ── Tracker ──
                const STAGES = [
                    { key: 'Draft',            label: 'Draft' },
                    { key: 'Completed',        label: 'Approved' },
                    { key: 'Provisional Paid', label: 'Provisional Paid', optional: true },
                    { key: 'Final Settled',    label: 'Final Settled &rarr; AP Bill' }
                ];
                const currentIdx = STAGES.map(function(s) { return s.key; }).indexOf(statusText);
                const isVoided = (statusText === 'Voided');

                const chips = STAGES.map(function(s, i) {
                    let bg = '#f1f5f9', border = '#cbd5e1', color = '#94a3b8', icon = '';
                    if (!isVoided && currentIdx > -1) {
                        if (i < currentIdx) {
                            bg = '#dcfce7'; border = '#16a34a'; color = '#14532d'; icon = '&#10004; ';
                        } else if (i === currentIdx) {
                            bg = '#2976F3'; border = '#1F5FCC'; color = '#ffffff'; icon = '&#9679; ';
                        }
                        // A skipped optional stage stays gray even when passed
                        if (s.optional && currentIdx === 3 && i === 2) {
                            bg = '#f8fafc'; border = '#cbd5e1'; color = '#94a3b8'; icon = '';
                        }
                    }
                    const lock = (s.key === 'Final Settled' && !isFixed && currentIdx < 3 && !isVoided)
                        ? ' &#128274;' : '';
                    const opt = s.optional ? '<div style="font-size:9px;opacity:0.8;">optional</div>' : '';
                    return '<div style="flex:1;text-align:center;padding:8px 6px;background:' + bg
                        + ';border:2px solid ' + border + ';color:' + color
                        + ';border-radius:6px;font-weight:600;font-size:12px;min-width:110px;">'
                        + icon + s.label + lock + opt + '</div>';
                }).join('<div style="align-self:center;color:#94a3b8;font-size:14px;padding:0 4px;">&#8594;</div>');

                const tracker = isVoided
                    ? '<div style="padding:8px 12px;background:#fef2f2;border:2px solid #dc2626;color:#7f1d1d;border-radius:6px;font-weight:600;font-size:13px;">&#10006; Voided — lifecycle ended. Bills are not auto-voided; reverse manually if any exist.</div>'
                    : '<div style="display:flex;gap:2px;align-items:stretch;">' + chips + '</div>';

                // ── Action buttons for the current stage ──
                const btn = function(action, label, bg, confirmMsg) {
                    if (!base) return '';
                    return '<a href="' + base + action + '"'
                        + (confirmMsg ? ' onclick="return confirm(\'' + confirmMsg + '\');"' : '')
                        + ' style="display:inline-block;padding:8px 16px;margin:8px 8px 0 0;background:' + bg
                        + ';color:#fff;text-decoration:none;border-radius:4px;font-weight:600;font-size:13px;">'
                        + label + '</a>';
                };

                const periodKey = rec.getValue({ fieldId: 'custrecord_sust_settle_period_key' });
                let buttons = '';
                if (periodKey && (statusText === 'Draft' || statusText === 'Completed')) {
                    buttons += btn('rebuild', '&#10227; Rebuild Totals from Slices', '#475569',
                        'Recompute weights and values from the receipt slices and penalty rows?');
                }
                if (statusText === 'Draft') {
                    buttons += btn('approve', '&#10004; Approve &amp; Complete', '#059669',
                        'Approve this settlement and mark it Completed?');
                } else if (statusText === 'Completed' || statusText === 'Provisional Paid') {
                    if (statusText === 'Completed') {
                        buttons += btn('provisional', '&#128181; Mark Provisional Paid', '#0284c7',
                            'Mark Provisional Paid? A provisional vendor bill will be created.');
                    }
                    if (!isFixed) {
                        buttons += btn('fixprice', '&#128274; Mark Price Fixed', '#7c3aed');
                    }
                    buttons += btn('finalize', '&#129534; Final Settle &rarr; Create AP Bill', '#b45309',
                        'Final Settle now? The final vendor bill for the balance due will be created.');
                }
                const hint = (statusText === 'Completed' || statusText === 'Provisional Paid') && !isFixed
                    ? '<div style="color:#92400e;font-size:11px;margin-top:6px;">&#128274; Final Settle is blocked until Price Fixed — that guard still applies.</div>'
                    : '';

                const fld = form.addField({
                    id: 'custpage_sust_status_actions',
                    type: serverWidget.FieldType.INLINEHTML,
                    label: ' '
                });
                fld.defaultValue =
                    '<div style="background:#ffffff;border:1px solid #cbd5e1;border-radius:8px;'
                    + 'padding:12px 14px;margin:8px 0;font-family:Arial,sans-serif;">'
                    + tracker
                    + (buttons ? '<div>' + buttons + '</div>' : '')
                    + hint
                    + '</div>';
            } catch (e) {
                log.debug('renderStatusButtons skipped', e.message);
            }
        }

        /**
         * Aggregated-settlement panel: when this settlement carries a period key
         * (Weekly/Monthly cadence), show WHICH receipt slices make it up — IR
         * drill-down, line, date, gross/net lbs, slice value — with totals, so
         * the parent is clearly distinguishable from a one-off settlement.
         */
        function renderAggregationPanel(form, rec) {
            try {
                const periodKey = rec.getValue({ fieldId: 'custrecord_sust_settle_period_key' });
                if (!periodKey || !rec.id) return;

                const slices = [];
                search.create({
                    type: 'customrecord_sust_settle_slice',
                    filters: [['custrecord_sust_slice_settlement', 'anyof', rec.id]],
                    columns: ['custrecord_sust_slice_ir', 'custrecord_sust_slice_source_line',
                        'custrecord_sust_slice_date', 'custrecord_sust_slice_gross_lbs',
                        'custrecord_sust_slice_net_lbs', 'custrecord_sust_slice_value',
                        'custrecord_sust_slice_lot']
                }).run().each(function(r) {
                    slices.push({
                        irId: r.getValue('custrecord_sust_slice_ir') || null,
                        irText: r.getText('custrecord_sust_slice_ir') || '',
                        line: r.getValue('custrecord_sust_slice_source_line') || '',
                        date: r.getValue('custrecord_sust_slice_date') || '',
                        gross: parseFloat(r.getValue('custrecord_sust_slice_gross_lbs')) || 0,
                        net: parseFloat(r.getValue('custrecord_sust_slice_net_lbs')) || 0,
                        value: parseFloat(r.getValue('custrecord_sust_slice_value')) || 0,
                        lot: r.getText('custrecord_sust_slice_lot') || ''
                    });
                    return true;
                });

                const cadence = String(periodKey).indexOf('-W') !== -1 ? 'Weekly' : 'Monthly';
                let totG = 0, totN = 0, totV = 0;
                const rows = slices.map(function(s) {
                    totG += s.gross; totN += s.net; totV += s.value;
                    let irCell = '&mdash;';
                    if (s.irId) {
                        try {
                            const u = url.resolveRecord({ recordType: 'itemreceipt', recordId: s.irId });
                            irCell = `<a href="${u}" style="color:#2976F3;">${escapeHtml(s.irText || ('IR #' + s.irId))}</a>`;
                        } catch (eUrl) { irCell = escapeHtml(s.irText || ('IR #' + s.irId)); }
                    }
                    return `<tr>
                        <td style="padding:4px 10px;border-bottom:1px solid #e5e7eb;">${irCell}</td>
                        <td style="padding:4px 10px;border-bottom:1px solid #e5e7eb;">${escapeHtml(String(s.line))}</td>
                        <td style="padding:4px 10px;border-bottom:1px solid #e5e7eb;">${escapeHtml(String(s.date))}</td>
                        <td style="padding:4px 10px;border-bottom:1px solid #e5e7eb;">${escapeHtml(s.lot)}</td>
                        <td style="padding:4px 10px;border-bottom:1px solid #e5e7eb;text-align:right;">${s.gross.toLocaleString()}</td>
                        <td style="padding:4px 10px;border-bottom:1px solid #e5e7eb;text-align:right;">${s.net.toLocaleString()}</td>
                        <td style="padding:4px 10px;border-bottom:1px solid #e5e7eb;text-align:right;">$${s.value.toFixed(2)}</td>
                      </tr>`;
                }).join('');

                const body = slices.length
                    ? `<table style="border-collapse:collapse;border:1px solid #cbd5e1;min-width:640px;font-size:12px;">
                         <thead><tr style="background:#7c3aed;color:#fff;">
                           <th style="padding:5px 10px;text-align:left;">Item Receipt</th>
                           <th style="padding:5px 10px;text-align:left;">Line</th>
                           <th style="padding:5px 10px;text-align:left;">Date</th>
                           <th style="padding:5px 10px;text-align:left;">Lot</th>
                           <th style="padding:5px 10px;text-align:right;">Gross Lbs</th>
                           <th style="padding:5px 10px;text-align:right;">Net Lbs</th>
                           <th style="padding:5px 10px;text-align:right;">Slice Value</th>
                         </tr></thead>
                         <tbody>${rows}
                           <tr style="background:#f5f3ff;font-weight:bold;">
                             <td style="padding:4px 10px;" colspan="4">Total (${slices.length} slice${slices.length === 1 ? '' : 's'})</td>
                             <td style="padding:4px 10px;text-align:right;">${totG.toLocaleString()}</td>
                             <td style="padding:4px 10px;text-align:right;">${totN.toLocaleString()}</td>
                             <td style="padding:4px 10px;text-align:right;">$${totV.toFixed(2)}</td>
                           </tr>
                         </tbody>
                       </table>`
                    : `<div style="color:#64748b;font-size:12px;">No receipt slices recorded yet — the next receipt for this vendor in period ${escapeHtml(String(periodKey))} will append here.</div>`;

                const panel = form.addField({
                    id: 'custpage_sust_agg_panel',
                    type: serverWidget.FieldType.INLINEHTML,
                    label: ' '
                });
                panel.defaultValue =
                    `<div style="margin:8px 0 12px;font-family:Arial,sans-serif;border:2px solid #7c3aed;border-radius:6px;padding:12px 14px;background:#faf5ff;">
                       <div style="font-weight:bold;font-size:14px;color:#5b21b6;margin-bottom:2px;">
                         &#128257; ${cadence} Aggregated Settlement &mdash; period ${escapeHtml(String(periodKey))}
                       </div>
                       <div style="font-size:12px;color:#4c1d95;margin-bottom:8px;">
                         This is a PARENT settlement: the receipt lines below were rolled into it by the vendor's ${cadence} settlement cadence
                         (values are schedule-priced per slice, before deductions). Slices also appear on the <b>Settlement Receipt Slice</b> child sublist.
                       </div>
                       ${body}
                     </div>`;
            } catch (e) {
                log.debug('renderAggregationPanel skipped', e.message);
            }
        }

        function renderActionLinks(form, settleId) {
            if (!settleId) return;

            const pdfBase = '/app/site/hosting/scriptlet.nl?script=customscript_sust_sl_settle_pdf'
                + '&deploy=customdeploy_sust_sl_settle_pdf&settle=' + settleId;
            const printUrl = pdfBase;
            const emailUrl = pdfBase + '&email=T';

            const html = ''
                + '<div style="background: #f9fafb; border: 1px solid #d1d5db; padding: 10px 14px; margin: 8px 0;'
                + ' border-radius: 6px; font-family: Arial, sans-serif; font-size: 13px;">'
                + '  <span style="font-weight: bold; margin-right: 12px;">Settlement Form:</span>'
                + '  <a href="' + printUrl + '" target="_blank"'
                + '     style="display: inline-block; padding: 6px 14px; margin-right: 8px;'
                + '            background: #1e3a8a; color: white; text-decoration: none; border-radius: 4px;">'
                + '    📄 Print PDF'
                + '  </a>'
                + '  <a href="' + emailUrl + '" target="_blank"'
                + '     onclick="return confirm(\'Email this settlement form to the vendor?\');"'
                + '     style="display: inline-block; padding: 6px 14px;'
                + '            background: #059669; color: white; text-decoration: none; border-radius: 4px;">'
                + '    ✉ Email to Vendor'
                + '  </a>'
                + '  <span style="margin-left: 12px; color: #6b7280; font-size: 11px;">'
                + '    PDF respects section-toggle checkboxes on this record.'
                + '  </span>'
                + '</div>';

            try {
                const fld = form.addField({
                    id: 'custpage_pdf_actions',
                    type: serverWidget.FieldType.INLINEHTML,
                    label: 'Settlement Form Actions'
                });
                fld.defaultValue = html;
            } catch (e) {
                log.debug('Action links field skipped', e.message);
            }
        }

        return {
            beforeLoad: beforeLoad,
            beforeSubmit: beforeSubmit
        };
    });
