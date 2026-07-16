/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */

/**
 * SUST_SL_CalculatorSettlement.js
 *
 * v2 (June 2026): Calculator-mode standalone settlement entry.
 *
 * Lets a Sustana Recovery analyst create a settlement record WITHOUT an Item
 * Receipt or processing run. The "handshake" mode from the discovery —
 * used when the vendor brings consistent/known material and Sustana Recovery
 * agrees to a flat $/lb regardless of actual quality/yield.
 *
 * Per Ara (D2B Discovery 32:09): "I have a thing called the settlement
 * calculator. It means you don't have to do anything to this. I can
 * manually go create a settlement and pay the customer."
 *
 * GET  — renders the entry form (vendor + weight + price + notes)
 * POST — creates customrecord_sust_settlement_record with mode=Calculator,
 *        then redirects to the new record
 *
 * Author: Sustana Dev Team
 * Date: June 2026 (v2)
 */

define(['N/record', 'N/ui/serverWidget', 'N/redirect', 'N/log', 'N/format'],
    function(record, serverWidget, redirect, log, format) {

        function onRequest(context) {
            try {
                if (context.request.method === 'GET') {
                    renderForm(context);
                } else {
                    handleSubmit(context);
                }
            } catch (e) {
                log.error('SUST_SL_CalculatorSettlement failed', `${e.message}\n${e.stack}`);
                context.response.write({
                    output: '<h2 style="color:#dc2626;">Error</h2><pre>' +
                            String(e.message).replace(/[<>]/g, '') + '</pre>'
                });
            }
        }

        // ───────────────────────────────────────────────────────────────────────
        // GET — render form
        // ───────────────────────────────────────────────────────────────────────

        function renderForm(context) {
            const form = serverWidget.createForm({
                title: 'Sustana Recovery Settlement Calculator (Handshake Mode)'
            });

            // Top banner explaining the mode
            const banner = form.addField({
                id: 'custpage_banner',
                type: serverWidget.FieldType.INLINEHTML,
                label: ' '
            });
            banner.defaultValue =
                '<div style="border: 2px solid #be185d; background: #fce7f3; color: #831843;' +
                ' padding: 14px 16px; margin: 8px 0; border-radius: 6px; font-family: Arial, sans-serif;">' +
                '  <div style="font-weight: bold; font-size: 14px; margin-bottom: 6px;">🤝 Calculator Mode</div>' +
                '  <div style="font-size: 13px;">' +
                '    Use this form when a vendor brings <em>consistent / known material</em> and a flat handshake price is agreed — no Item Receipt or processing run required. ' +
                '    Settlement is created in <strong>Calculator mode</strong>; can be reconciled against actual IR/WIP later if desired.' +
                '  </div>' +
                '</div>';

            // Vendor
            const vendorField = form.addField({
                id: 'custpage_vendor',
                type: serverWidget.FieldType.SELECT,
                label: 'Vendor',
                source: 'vendor'
            });
            vendorField.isMandatory = true;

            // Settlement date
            const dateField = form.addField({
                id: 'custpage_settle_date',
                type: serverWidget.FieldType.DATE,
                label: 'Settlement Date'
            });
            dateField.defaultValue = new Date();
            dateField.isMandatory = true;

            // Agreed weight
            const weightField = form.addField({
                id: 'custpage_agreed_weight',
                type: serverWidget.FieldType.FLOAT,
                label: 'Agreed Weight (lbs)'
            });
            weightField.isMandatory = true;
            weightField.setHelpText({
                help: 'Total pounds you are settling on (vendor weight or your weight estimate).'
            });

            // Agreed $/lb
            const ratePerLbField = form.addField({
                id: 'custpage_agreed_rate',
                type: serverWidget.FieldType.CURRENCY,
                label: 'Agreed $/lb'
            });
            ratePerLbField.setHelpText({
                help: 'Flat per-pound rate agreed with the vendor. Total = weight × $/lb (or override Total directly).'
            });

            // Total settlement value (optional override)
            const totalField = form.addField({
                id: 'custpage_total_value',
                type: serverWidget.FieldType.CURRENCY,
                label: 'Total Settlement Value ($)'
            });
            totalField.setHelpText({
                help: 'Computed as weight × $/lb on save if left blank. Override to set a specific total directly.'
            });

            // Memo / notes
            const notesField = form.addField({
                id: 'custpage_notes',
                type: serverWidget.FieldType.TEXTAREA,
                label: 'Settlement Notes / Context'
            });
            notesField.setHelpText({
                help: 'Document the handshake context — vendor name & PO if not in system, material description, any verbal agreements, reconciliation plan.'
            });

            // Auto-complete to Final Settled?
            const finalNowField = form.addField({
                id: 'custpage_final_now',
                type: serverWidget.FieldType.CHECKBOX,
                label: 'Mark as Final Settled now?'
            });
            finalNowField.setHelpText({
                help: 'If checked, settlement is created with status = Final Settled (immediate vendor bill). Otherwise creates as Draft for review.'
            });

            // Submit button
            form.addSubmitButton({
                label: 'Create Calculator Settlement'
            });

            // Set hidden mode field
            const hiddenMode = form.addField({
                id: 'custpage_hidden_mode',
                type: serverWidget.FieldType.TEXT,
                label: 'Mode'
            });
            hiddenMode.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            hiddenMode.defaultValue = 'Calculator';

            context.response.writePage(form);
        }

        // ───────────────────────────────────────────────────────────────────────
        // POST — create settlement record
        // ───────────────────────────────────────────────────────────────────────

        function handleSubmit(context) {
            const params = context.request.parameters;
            const vendor = params.custpage_vendor;
            const settleDate = params.custpage_settle_date;
            const weight = parseFloat(params.custpage_agreed_weight) || 0;
            const ratePerLb = parseFloat(params.custpage_agreed_rate) || 0;
            let total = parseFloat(params.custpage_total_value) || 0;
            const notes = params.custpage_notes || '';
            const finalNow = (params.custpage_final_now === 'T' || params.custpage_final_now === true);

            if (!vendor || weight <= 0) {
                context.response.write({
                    output: '<h2 style="color:#dc2626;">Missing required fields</h2>' +
                            '<p>Vendor and Agreed Weight are required.</p>' +
                            '<p><a href="javascript:history.back()">← Back</a></p>'
                });
                return;
            }

            // Compute total if not overridden
            if (total <= 0) {
                total = weight * ratePerLb;
            }

            log.audit('Calculator Settlement Creation', {
                vendor: vendor,
                weight: weight,
                ratePerLb: ratePerLb,
                total: total,
                finalNow: finalNow
            });

            // Create the settlement record
            const settle = record.create({
                type: 'customrecord_sust_settlement_record',
                isDynamic: false
            });

            // Convert date string to Date object
            let parsedDate;
            try {
                parsedDate = format.parse({ value: settleDate, type: format.Type.DATE });
            } catch (e) {
                parsedDate = new Date();
            }

            settle.setValue({ fieldId: 'custrecord_sust_settlement_vendor', value: parseInt(vendor) });
            settle.setValue({ fieldId: 'custrecord_sust_settlement_date', value: parsedDate });
            settle.setValue({ fieldId: 'custrecord_sust_settlement_gross_lbs', value: weight });
            settle.setValue({ fieldId: 'custrecord_sust_settlement_net_lbs', value: weight }); // Calculator: gross = net (no recovery)
            settle.setValue({ fieldId: 'custrecord_sust_settlement_market_price', value: ratePerLb });
            settle.setValue({ fieldId: 'custrecord_sust_settlement_gross_value', value: total });
            settle.setValue({ fieldId: 'custrecord_sust_settlement_net_value', value: total });
            settle.setValue({ fieldId: 'custrecord_sust_settlement_balance_due', value: total });
            settle.setValue({ fieldId: 'custrecord_sust_settlement_notes', value: notes });

            // Set mode = Calculator
            try {
                settle.setText({ fieldId: 'custrecord_sust_settlement_mode', text: 'Calculator' });
            } catch (e) {
                log.error('Mode set failed', e.message);
            }

            // Set method (fallback) and status
            try {
                settle.setText({ fieldId: 'custrecord_sust_settlement_method', text: 'Fixed Price' });
            } catch (e) {
                log.debug('Method set skipped', e.message);
            }

            const statusText = finalNow ? 'Final Settled' : 'Draft';
            try {
                settle.setText({ fieldId: 'custrecord_sust_settlement_status', text: statusText });
            } catch (e) {
                log.error('Status set failed', e.message);
            }

            const settleId = settle.save();
            log.audit('Calculator Settlement Created', `Settlement ID: ${settleId}, status: ${statusText}`);

            // Redirect to the new record
            redirect.toRecord({
                type: 'customrecord_sust_settlement_record',
                id: settleId
            });
        }

        return {
            onRequest: onRequest
        };
    });
