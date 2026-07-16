/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */

/**
 * SUST_SL_SettlementScheduleEntry.js
 *
 * Settlement Schedule Entry Suitelet for Sustana Recovery
 * Allows creation and editing of vendor-specific pricing schedules with
 * quality-deduction definitions (Moisture % / Contamination % thresholds).
 *
 * All prices are entered and stored in $/lb; field help shows the $/ton
 * equivalent (1 short ton = 2,000 lbs).
 *
 * Author: Sustana Dev Team
 * Date: February 2026 (v1) / June 2026 (v2 — quality-deduction sublist)
 */

define(['N/ui/serverWidget', 'N/record', 'N/search', 'N/redirect', 'N/log'],
    function(serverWidget, record, search, redirect, log) {

        /**
         * Suitelet entry point
         */
        function onRequest(context) {
            try {
                if (context.request.method === 'GET') {
                    displayScheduleForm(context);
                } else {
                    processFormSubmission(context);
                }
            } catch (e) {
                log.error('Settlement Schedule Entry Error', e.toString());
                throw e;
            }
        }

        /**
         * Display the settlement schedule entry form
         */
        function displayScheduleForm(context) {
            const form = serverWidget.createForm({
                title: 'Settlement Schedule Entry'
            });

            // Add client script
            form.clientScriptModulePath = './SUST_CS_SettlementScheduleEntry.js';

            // Get schedule ID from parameters (if editing)
            const scheduleId = context.request.parameters.scheduleid;
            let scheduleRecord = null;

            if (scheduleId) {
                scheduleRecord = record.load({
                    type: 'customrecord_sust_settlement_schedule',
                    id: scheduleId
                });
            }

            // Hidden field for schedule ID
            const scheduleIdField = form.addField({
                id: 'custpage_schedule_id',
                type: serverWidget.FieldType.TEXT,
                label: 'Schedule ID'
            });
            scheduleIdField.updateDisplayType({
                displayType: serverWidget.FieldDisplayType.HIDDEN
            });
            if (scheduleId) {
                scheduleIdField.defaultValue = scheduleId;
            }

            // Header Section
            const headerGroup = form.addFieldGroup({
                id: 'custpage_header_group',
                label: 'Schedule Information'
            });

            // Direction — Purchase (supplier settlement) or Sale (customer index pricing)
            const directionField = form.addField({
                id: 'custpage_direction',
                type: serverWidget.FieldType.SELECT,
                label: 'Direction',
                source: 'customlist_sust_sched_direction',
                container: 'custpage_header_group'
            });
            directionField.setHelpText({
                help: 'Purchase = supplier settlement pricing (default). ' +
                      'Sale = customer index pricing — Sales Order lines for the customer + item auto-price from this schedule.'
            });
            if (scheduleRecord) {
                directionField.defaultValue = scheduleRecord.getValue('custrecord_sust_sched_direction');
            }

            // Vendor (Purchase-direction schedules)
            const vendorField = form.addField({
                id: 'custpage_vendor',
                type: serverWidget.FieldType.SELECT,
                label: 'Vendor',
                source: 'vendor',
                container: 'custpage_header_group'
            });
            vendorField.setHelpText({ help: 'Required for Purchase-direction schedules.' });
            if (scheduleRecord) {
                vendorField.defaultValue = scheduleRecord.getValue('custrecord_sust_schedule_vendor');
            }

            // Customer (Sale-direction schedules)
            const customerField = form.addField({
                id: 'custpage_customer',
                type: serverWidget.FieldType.SELECT,
                label: 'Customer',
                source: 'customer',
                container: 'custpage_header_group'
            });
            customerField.setHelpText({ help: 'Required for Sale-direction schedules (e.g. Packaging Mill A: RISI SOP + $10/ton).' });
            if (scheduleRecord) {
                customerField.defaultValue = scheduleRecord.getValue('custrecord_sust_sched_customer');
            }

            // Item
            const itemField = form.addField({
                id: 'custpage_item',
                type: serverWidget.FieldType.SELECT,
                label: 'Material Item (Grade)',
                source: 'item',
                container: 'custpage_header_group'
            });
            if (scheduleRecord) {
                itemField.defaultValue = scheduleRecord.getValue('custrecord_sust_schedule_item');
            }

            // Pricing Method
            const methodField = form.addField({
                id: 'custpage_method',
                type: serverWidget.FieldType.SELECT,
                label: 'Pricing Method',
                source: 'customlist_sust_settlement_method',
                container: 'custpage_header_group'
            });
            methodField.isMandatory = true;
            if (scheduleRecord) {
                methodField.defaultValue = scheduleRecord.getValue('custrecord_sust_schedule_method');
            }

            // Pricing Details Section
            const pricingGroup = form.addFieldGroup({
                id: 'custpage_pricing_group',
                label: 'Pricing Details'
            });

            // Base Price — stored in $/lb
            const basePriceField = form.addField({
                id: 'custpage_base_price',
                type: serverWidget.FieldType.CURRENCY,
                label: 'Base Price ($/lb)',
                container: 'custpage_pricing_group'
            });
            basePriceField.setHelpText({
                help: 'Enter in dollars per pound. The $/ton equivalent is base price × 2,000 ' +
                      '(e.g. $0.05/lb = $100.00/ton).'
            });
            if (scheduleRecord) {
                basePriceField.defaultValue = scheduleRecord.getValue('custrecord_sust_schedule_base_price');
            }

            // Market Reference
            const marketRefField = form.addField({
                id: 'custpage_market_ref',
                type: serverWidget.FieldType.SELECT,
                label: 'Market Reference',
                source: 'customlist_sust_market_price_source',
                container: 'custpage_pricing_group'
            });
            if (scheduleRecord) {
                marketRefField.defaultValue = scheduleRecord.getValue('custrecord_sust_schedule_market_ref');
            }

            // Market Percentage
            const marketPctField = form.addField({
                id: 'custpage_market_pct',
                type: serverWidget.FieldType.PERCENT,
                label: 'Market Percentage',
                container: 'custpage_pricing_group'
            });
            if (scheduleRecord) {
                marketPctField.defaultValue = scheduleRecord.getValue('custrecord_sust_schedule_market_pct');
            }

            // Index Adjustment — stored in $/lb
            const marketAdjField = form.addField({
                id: 'custpage_market_adj',
                type: serverWidget.FieldType.CURRENCY,
                label: 'Index Adjustment ($/lb)',
                container: 'custpage_pricing_group'
            });
            marketAdjField.setHelpText({
                help: 'Dollar-per-pound adjustment added to (or subtracted from) the index price. ' +
                      'Divide a $/ton adjustment by 2,000 — e.g. −$15/ton = −$0.0075/lb.'
            });
            if (scheduleRecord) {
                marketAdjField.defaultValue = scheduleRecord.getValue('custrecord_sust_schedule_market_adj');
            }

            // Processing Charge — stored in $/lb
            const treatmentField = form.addField({
                id: 'custpage_treatment_charge',
                type: serverWidget.FieldType.CURRENCY,
                label: 'Processing Charge ($/lb)',
                container: 'custpage_pricing_group'
            });
            if (scheduleRecord) {
                treatmentField.defaultValue = scheduleRecord.getValue('custrecord_sust_sched_proc_charge');
            }

            // Minimum Content
            const minContentField = form.addField({
                id: 'custpage_min_content',
                type: serverWidget.FieldType.PERCENT,
                label: 'Minimum Content %',
                container: 'custpage_pricing_group'
            });
            if (scheduleRecord) {
                minContentField.defaultValue = scheduleRecord.getValue('custrecord_sust_schedule_min_content');
            }

            // Validity Section
            const validityGroup = form.addFieldGroup({
                id: 'custpage_validity_group',
                label: 'Validity Period'
            });

            // Active
            const activeField = form.addField({
                id: 'custpage_active',
                type: serverWidget.FieldType.CHECKBOX,
                label: 'Active',
                container: 'custpage_validity_group'
            });
            if (scheduleRecord) {
                activeField.defaultValue = scheduleRecord.getValue('custrecord_sust_schedule_active') ? 'T' : 'F';
            } else {
                activeField.defaultValue = 'T';
            }

            // Effective Date
            const effectiveDateField = form.addField({
                id: 'custpage_effective_date',
                type: serverWidget.FieldType.DATE,
                label: 'Effective Date',
                container: 'custpage_validity_group'
            });
            if (scheduleRecord) {
                effectiveDateField.defaultValue = scheduleRecord.getValue('custrecord_sust_schedule_effective_date');
            }

            // Expiration Date
            const expirationDateField = form.addField({
                id: 'custpage_expiration_date',
                type: serverWidget.FieldType.DATE,
                label: 'Expiration Date',
                container: 'custpage_validity_group'
            });
            if (scheduleRecord) {
                expirationDateField.defaultValue = scheduleRecord.getValue('custrecord_sust_schedule_expiration_date');
            }

            // Quality-Deduction Lines Sublist
            const penaltySublist = form.addSublist({
                id: 'custpage_penalties',
                type: serverWidget.SublistType.INLINEEDITOR,
                label: 'Quality Deductions'
            });

            penaltySublist.addField({
                id: 'custpage_penalty_id',
                type: serverWidget.FieldType.TEXT,
                label: 'ID'
            }).updateDisplayType({
                displayType: serverWidget.FieldDisplayType.HIDDEN
            });

            penaltySublist.addField({
                id: 'custpage_penalty_element',
                type: serverWidget.FieldType.SELECT,
                label: 'Quality Metric',
                source: 'customlist_sust_quality_metric'
            });

            penaltySublist.addField({
                id: 'custpage_penalty_calculation',
                type: serverWidget.FieldType.SELECT,
                label: 'Calculation Type',
                source: 'customlist_sust_penalty_calc_type'
            });

            penaltySublist.addField({
                id: 'custpage_penalty_threshold',
                type: serverWidget.FieldType.PERCENT,
                label: 'Threshold %'
            });

            penaltySublist.addField({
                id: 'custpage_penalty_rate',
                type: serverWidget.FieldType.CURRENCY,
                label: 'Penalty Rate ($/lb per %)'
            });

            // Load existing deduction lines if editing
            if (scheduleId) {
                loadPenaltyLines(scheduleId, penaltySublist);
            }

            // Add submit button
            form.addSubmitButton({
                label: 'Save Schedule'
            });

            // Add cancel button
            form.addButton({
                id: 'custpage_cancel',
                label: 'Cancel',
                functionName: 'cancelForm'
            });

            context.response.writePage(form);
        }

        /**
         * Load existing quality-deduction lines for a schedule
         */
        function loadPenaltyLines(scheduleId, sublist) {
            try {
                const penaltySearch = search.create({
                    type: 'customrecord_sust_settlement_penalty',
                    filters: [
                        ['custrecord_sust_penalty_schedule', 'anyof', scheduleId]
                    ],
                    columns: [
                        'internalid',
                        'custrecord_sust_penalty_element',
                        'custrecord_sust_penalty_calculation',
                        'custrecord_sust_penalty_threshold',
                        'custrecord_sust_penalty_rate'
                    ]
                });

                let lineNum = 0;
                penaltySearch.run().each(function(result) {
                    sublist.setSublistValue({
                        id: 'custpage_penalty_id',
                        line: lineNum,
                        value: result.getValue('internalid')
                    });

                    sublist.setSublistValue({
                        id: 'custpage_penalty_element',
                        line: lineNum,
                        value: result.getValue('custrecord_sust_penalty_element')
                    });

                    const calcVal = result.getValue('custrecord_sust_penalty_calculation');
                    if (calcVal) {
                        sublist.setSublistValue({
                            id: 'custpage_penalty_calculation',
                            line: lineNum,
                            value: calcVal
                        });
                    }

                    sublist.setSublistValue({
                        id: 'custpage_penalty_threshold',
                        line: lineNum,
                        value: result.getValue('custrecord_sust_penalty_threshold') || '0'
                    });

                    sublist.setSublistValue({
                        id: 'custpage_penalty_rate',
                        line: lineNum,
                        value: result.getValue('custrecord_sust_penalty_rate') || '0'
                    });

                    lineNum++;
                    return true;
                });
            } catch (e) {
                log.error('Error loading quality-deduction lines', e.toString());
            }
        }

        /**
         * Parse a numeric form value safely, stripping %, $, comma suffixes that
         * NetSuite form fields add for display. Returns '' for empty/invalid.
         *
         * Fixes a v1 latent bug where PERCENT and CURRENCY POST values like "60.0%"
         * or "$5.00" were passed directly to setValue() and rejected as
         * INVALID_FLD_VALUE. See CLAUDE.md "PERCENT Field Form Submission".
         */
        function parseNumeric(val) {
            if (val === null || val === undefined || val === '') return '';
            const cleaned = val.toString().replace(/[%$,\s]/g, '');
            const n = parseFloat(cleaned);
            return isNaN(n) ? '' : n;
        }

        /**
         * Process form submission
         */
        function processFormSubmission(context) {
            try {
                const scheduleId = context.request.parameters.custpage_schedule_id;

                // Create or load schedule record
                let scheduleRecord;
                if (scheduleId) {
                    scheduleRecord = record.load({
                        type: 'customrecord_sust_settlement_schedule',
                        id: scheduleId
                    });
                } else {
                    scheduleRecord = record.create({
                        type: 'customrecord_sust_settlement_schedule'
                    });
                }

                // Set header fields
                if (context.request.parameters.custpage_direction) {
                    scheduleRecord.setValue({
                        fieldId: 'custrecord_sust_sched_direction',
                        value: context.request.parameters.custpage_direction
                    });
                }

                scheduleRecord.setValue({
                    fieldId: 'custrecord_sust_schedule_vendor',
                    value: context.request.parameters.custpage_vendor || ''
                });

                scheduleRecord.setValue({
                    fieldId: 'custrecord_sust_sched_customer',
                    value: context.request.parameters.custpage_customer || ''
                });

                scheduleRecord.setValue({
                    fieldId: 'custrecord_sust_schedule_item',
                    value: context.request.parameters.custpage_item || ''
                });

                scheduleRecord.setValue({
                    fieldId: 'custrecord_sust_schedule_method',
                    value: context.request.parameters.custpage_method
                });

                scheduleRecord.setValue({
                    fieldId: 'custrecord_sust_schedule_base_price',
                    value: parseNumeric(context.request.parameters.custpage_base_price)
                });

                scheduleRecord.setValue({
                    fieldId: 'custrecord_sust_schedule_market_ref',
                    value: context.request.parameters.custpage_market_ref || ''
                });

                scheduleRecord.setValue({
                    fieldId: 'custrecord_sust_schedule_market_pct',
                    value: parseNumeric(context.request.parameters.custpage_market_pct)
                });

                scheduleRecord.setValue({
                    fieldId: 'custrecord_sust_schedule_market_adj',
                    value: parseNumeric(context.request.parameters.custpage_market_adj)
                });

                scheduleRecord.setValue({
                    fieldId: 'custrecord_sust_sched_proc_charge',
                    value: parseNumeric(context.request.parameters.custpage_treatment_charge)
                });

                scheduleRecord.setValue({
                    fieldId: 'custrecord_sust_schedule_min_content',
                    value: parseNumeric(context.request.parameters.custpage_min_content)
                });

                scheduleRecord.setValue({
                    fieldId: 'custrecord_sust_schedule_active',
                    value: context.request.parameters.custpage_active === 'T'
                });

                // Set effective date (convert to Date object if provided)
                const effectiveDate = context.request.parameters.custpage_effective_date;
                if (effectiveDate) {
                    scheduleRecord.setValue({
                        fieldId: 'custrecord_sust_schedule_effective_date',
                        value: new Date(effectiveDate)
                    });
                }

                // Set expiration date (convert to Date object if provided)
                const expirationDate = context.request.parameters.custpage_expiration_date;
                if (expirationDate) {
                    scheduleRecord.setValue({
                        fieldId: 'custrecord_sust_schedule_expiration_date',
                        value: new Date(expirationDate)
                    });
                }

                // Save schedule
                const savedScheduleId = scheduleRecord.save();
                log.audit('Settlement Schedule Saved', 'Schedule ID: ' + savedScheduleId);

                // Save quality-deduction lines
                savePenaltyLines(context, savedScheduleId);

                // Redirect to schedule record
                redirect.toRecord({
                    type: 'customrecord_sust_settlement_schedule',
                    id: savedScheduleId
                });

            } catch (e) {
                log.error('Error saving settlement schedule', e.toString());
                throw e;
            }
        }

        /**
         * Save quality-deduction lines
         */
        function savePenaltyLines(context, scheduleId) {
            try {
                const lineCount = context.request.getLineCount({
                    group: 'custpage_penalties'
                });

                log.debug('Saving Quality-Deduction Lines', 'Line count: ' + lineCount);

                for (let i = 0; i < lineCount; i++) {
                    const penaltyId = context.request.getSublistValue({
                        group: 'custpage_penalties',
                        name: 'custpage_penalty_id',
                        line: i
                    });

                    const element = context.request.getSublistValue({
                        group: 'custpage_penalties',
                        name: 'custpage_penalty_element',
                        line: i
                    });

                    const calculation = context.request.getSublistValue({
                        group: 'custpage_penalties',
                        name: 'custpage_penalty_calculation',
                        line: i
                    });

                    const threshold = context.request.getSublistValue({
                        group: 'custpage_penalties',
                        name: 'custpage_penalty_threshold',
                        line: i
                    });

                    const rate = context.request.getSublistValue({
                        group: 'custpage_penalties',
                        name: 'custpage_penalty_rate',
                        line: i
                    });

                    // Only save if a quality metric is specified
                    if (element) {
                        let penaltyRecord;
                        if (penaltyId) {
                            penaltyRecord = record.load({
                                type: 'customrecord_sust_settlement_penalty',
                                id: penaltyId
                            });
                        } else {
                            penaltyRecord = record.create({
                                type: 'customrecord_sust_settlement_penalty'
                            });
                        }

                        penaltyRecord.setValue({
                            fieldId: 'custrecord_sust_penalty_schedule',
                            value: scheduleId
                        });

                        penaltyRecord.setValue({
                            fieldId: 'custrecord_sust_penalty_element',
                            value: element
                        });

                        // Calculation Type is required — default to Per Percentage Point
                        // (most common) if not explicitly set, so the form doesn't reject save.
                        if (calculation) {
                            penaltyRecord.setValue({
                                fieldId: 'custrecord_sust_penalty_calculation',
                                value: calculation
                            });
                        } else {
                            penaltyRecord.setText({
                                fieldId: 'custrecord_sust_penalty_calculation',
                                text: 'Per Percentage Point'
                            });
                        }

                        penaltyRecord.setValue({
                            fieldId: 'custrecord_sust_penalty_threshold',
                            value: parseNumeric(threshold) || 0
                        });

                        penaltyRecord.setValue({
                            fieldId: 'custrecord_sust_penalty_rate',
                            value: parseNumeric(rate) || 0
                        });

                        const savedPenaltyId = penaltyRecord.save();
                        log.debug('Quality-Deduction Line Saved', 'Deduction ID: ' + savedPenaltyId);
                    }
                }
            } catch (e) {
                log.error('Error saving penalty lines', e.toString());
                throw e;
            }
        }

        return {
            onRequest: onRequest
        };
    });
