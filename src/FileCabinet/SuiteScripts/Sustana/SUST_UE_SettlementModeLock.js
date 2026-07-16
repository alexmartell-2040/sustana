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

define(['N/record', 'N/runtime', 'N/log', 'N/ui/serverWidget'],
    function(record, runtime, log, serverWidget) {

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
                    renderModeBanner(form, modeText, statusText);
                    renderActionLinks(form, rec.id);
                    return;
                }

                // EDIT/CREATE: lock fields per mode + status
                applyFieldLocks(form, modeText, statusText);
                renderModeBanner(form, modeText, statusText);
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
