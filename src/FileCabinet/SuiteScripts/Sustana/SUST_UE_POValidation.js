/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */

/**
 * SUST_UE_POValidation.js
 *
 * v2 (June 2026): Unified PO handler for Sustana Recovery's three pricing-timing
 * patterns (CROSS-020).
 *
 * beforeLoad — renders a mode-aware guidance banner on Sustana Recovery POs.
 * beforeSubmit — validates the PO consistent with the selected pricing
 *   timing mode, sets sensible defaults, logs non-blocking warnings.
 * afterSubmit — audit log.
 *
 * Pricing Timing modes (custbody_sust_pricing_timing):
 *   - "Known at PO": vendor knows what they're shipping; price committed at
 *     PO entry. Lines should have real items + non-zero rates + schedule
 *     attached.
 *   - "Determined on Arrival": vendor ships without committing; price set at
 *     IR. PO can use the placeholder item OR a best-guess item; rate may
 *     be $0 until IR.
 *   - "Determined After Processing": vendor brings unknown-yield material;
 *     PO uses the generic placeholder item at $0; final price determined
 *     by Settlement Calculator post-WIP.
 *
 * Subsidiary-gated via configurable script parameter.
 *
 * Author: Sustana Dev Team
 * Date: June 2026 (v2)
 */

define(['N/record', 'N/runtime', 'N/log', 'N/ui/serverWidget', './SUST_Lib_Config'],
    function(record, runtime, log, serverWidget, configLib) {
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


        const PRICING_TIMING_FIELD = 'custbody_sust_pricing_timing';

        /**
         * beforeLoad — render mode-aware guidance.
         */
        function beforeLoad(context) {
            try {
                if (context.type !== context.UserEventType.VIEW &&
                    context.type !== context.UserEventType.EDIT &&
                    context.type !== context.UserEventType.CREATE) {
                    return;
                }
                if (!isSustanaSubsidiary(context.newRecord)) return;

                const timingText = (function() {
                    try {
                        return context.newRecord.getText({ fieldId: PRICING_TIMING_FIELD }) || '';
                    } catch (e) { return ''; }
                })();

                renderModeGuidance(context.form, timingText);

            } catch (e) {
                log.error('SUST_UE_POValidation.beforeLoad failed', e.message);
            }
        }

        /**
         * beforeSubmit — validate consistent with pricing-timing mode.
         */
        function beforeSubmit(context) {
            try {
                if (context.type !== context.UserEventType.CREATE &&
                    context.type !== context.UserEventType.EDIT) {
                    return;
                }
                if (!isSustanaSubsidiary(context.newRecord)) return;

                const newRec = context.newRecord;
                const timingValue = newRec.getValue({ fieldId: PRICING_TIMING_FIELD });
                const timingText = newRec.getText({ fieldId: PRICING_TIMING_FIELD }) || '';

                // Default to "Known at PO" if unset (most common path)
                if (!timingValue) {
                    try {
                        newRec.setText({ fieldId: PRICING_TIMING_FIELD, text: 'Known at PO' });
                        log.audit('PO Pricing Timing Defaulted',
                            `PO had no pricing_timing — defaulted to "Known at PO" (most common). User can change post-save.`);
                    } catch (e) {
                        log.debug('Default Skipped', `Could not set default pricing_timing: ${e.message}`);
                    }
                    return; // skip further validation on this save
                }

                const warnings = validateForMode(newRec, timingText);
                if (warnings.length > 0) {
                    log.audit('PO Validation Warnings',
                        `Mode: "${timingText}"\nWarnings:\n - ${warnings.join('\n - ')}`);
                }

            } catch (e) {
                log.error('SUST_UE_POValidation.beforeSubmit failed', e.message);
            }
        }

        // ───────────────────────────────────────────────────────────────────────
        // Validation
        // ───────────────────────────────────────────────────────────────────────

        function validateForMode(rec, timingText) {
            const warnings = [];
            const lineCount = rec.getLineCount({ sublistId: 'item' });

            switch (timingText) {
                case 'Known at PO':
                    // Each line should have a non-zero rate
                    for (let i = 0; i < lineCount; i++) {
                        const rate = rec.getSublistValue({ sublistId: 'item', fieldId: 'rate', line: i });
                        if (!rate || parseFloat(rate) <= 0) {
                            warnings.push(`Line ${i + 1}: rate is 0 / empty — Known-at-PO mode expects committed pricing.`);
                        }
                    }
                    break;

                case 'Determined on Arrival':
                    // Anything goes — pricing finalized at IR. Just note that final pricing is deferred.
                    log.debug('On-Arrival PO',
                        `PO will defer pricing finalization to IR (Sustana Recovery determines on receipt).`);
                    break;

                case 'Determined After Processing':
                    // Each line should be placeholder item @ $0
                    for (let i = 0; i < lineCount; i++) {
                        const rate = rec.getSublistValue({ sublistId: 'item', fieldId: 'rate', line: i });
                        if (rate && parseFloat(rate) !== 0) {
                            warnings.push(`Line ${i + 1}: rate is ${rate} — Post-Processing mode expects $0 placeholder (cost determined post-WIP via Settlement Calculator).`);
                        }
                        // Could also check that item = configured placeholder ID, but that ID isn't
                        // wired in yet — deferred to a later chunk.
                    }
                    break;

                default:
                    warnings.push(`Unrecognized pricing-timing mode: "${timingText}"`);
            }

            return warnings;
        }

        // ───────────────────────────────────────────────────────────────────────
        // UI Rendering
        // ───────────────────────────────────────────────────────────────────────

        function renderModeGuidance(form, timingText) {
            // Mode-specific guidance text
            let title, body, bgColor, borderColor, textColor;

            switch (timingText) {
                case 'Known at PO':
                    title = 'Pricing Timing: Known at PO';
                    body = 'Vendor specifies composition + committed price. Enter real items, non-zero rates, and (optionally) attach a settlement schedule. Settlement created in Auto mode at IR.';
                    bgColor = '#dbeafe'; borderColor = '#2563eb'; textColor = '#1e3a8a';
                    break;
                case 'Determined on Arrival':
                    title = 'Pricing Timing: Determined on Arrival';
                    body = 'Vendor ships unannounced. PO can carry best-guess items. Sustana Recovery finalizes item + price at Item Receipt. Settlement created in Auto or Custom mode at IR.';
                    bgColor = '#fef3c7'; borderColor = '#d97706'; textColor = '#78350f';
                    break;
                case 'Determined After Processing':
                    title = 'Pricing Timing: Determined After Processing';
                    body = 'Unknown-yield material. PO must use the "Material Pending Determination" placeholder item at $0. Settlement created in Calculator mode at IR; final cost flows back from settlement value to output lots after WIP completion.';
                    bgColor = '#fce7f3'; borderColor = '#be185d'; textColor = '#831843';
                    break;
                default:
                    title = 'Pricing Timing: Not Set';
                    body = 'Select a Pricing Timing value on the Main tab to drive Sustana Recovery PO behavior. Defaults to "Known at PO" if left blank.';
                    bgColor = '#f3f4f6'; borderColor = '#6b7280'; textColor = '#1f2937';
            }

            const html = ''
                + '<div style="border: 2px solid ' + borderColor + '; background: ' + bgColor + '; color: ' + textColor + ';'
                + ' padding: 12px 16px; margin: 10px 0; border-radius: 6px; font-family: Arial, sans-serif;">'
                + '  <div style="font-weight: bold; font-size: 14px; margin-bottom: 6px;">'
                + '    ⓘ ' + escapeHtml(title)
                + '  </div>'
                + '  <div style="font-size: 13px;">'
                +      escapeHtml(body)
                + '  </div>'
                + '</div>';

            const fld = form.addField({
                id: 'custpage_pricing_guidance',
                type: serverWidget.FieldType.INLINEHTML,
                label: 'Pricing Guidance'
            });
            fld.defaultValue = html;
        }

        function isSustanaSubsidiary(rec) {
            return subsidiaryAllowed(rec.getValue({ fieldId: 'subsidiary' }), 'custscript_sust_sub_id_po');
        }

        function escapeHtml(s) {
            return String(s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        return {
            beforeLoad: beforeLoad,
            beforeSubmit: beforeSubmit
        };
    });
