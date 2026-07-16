/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */

/**
 * SUST_SL_SettlementCalculation.js
 *
 * Settlement Calculation Suitelet for Sustana Recovery
 * Features:
 * - Status-based field locking (Draft → Completed → Provisional Paid → Final Settled → Voided)
 * - Filtered status transitions (only valid next statuses shown)
 * - Server-side quality-deduction calculation from lot quality data + schedule deduction definitions
 * - Market price auto-population from the stored RISI index price table
 * - Vendor bill creation triggers via status change (handled by UE script)
 *
 * Author: Sustana Dev Team
 * Date: February 2026
 */

define(['N/ui/serverWidget', 'N/record', 'N/search', 'N/redirect', 'N/log', 'N/format', 'N/url', './SUST_Lib_MarketPrice', './SUST_Lib_SettlementCreate', './SUST_Lib_Units'],
    function(serverWidget, record, search, redirect, log, format, url, marketPriceLib, settlementLib, unitsLib) {

        // Status constants — text values from customlist_sust_settlement_status
        const STATUS = {
            DRAFT: 'Draft',
            COMPLETED: 'Completed',
            PROVISIONAL_PAID: 'Provisional Paid',
            FINAL_SETTLED: 'Final Settled',
            VOIDED: 'Voided'
        };

        // Valid status transitions
        const VALID_TRANSITIONS = {
            'Draft': ['Draft', 'Completed', 'Voided'],
            'Completed': ['Completed', 'Provisional Paid', 'Final Settled', 'Voided', 'Draft'],
            'Provisional Paid': ['Provisional Paid', 'Final Settled', 'Voided'],
            'Final Settled': ['Final Settled'],
            'Voided': ['Voided']
        };

        // Quality-metric display text → SUST_Lib_SettlementCreate.getLotQuality() property.
        // 'Other' has no measured lot value, so definitions using it are skipped.
        const QUALITY_METRIC_PROP = {
            'Moisture %': 'moisturePct',
            'Contamination %': 'contaminationPct'
        };

        // Penalty calculation type text values
        const PENALTY_CALC_TYPE = {
            PER_PERCENTAGE: 'Per Percentage Point',
            FLAT_FEE: 'Flat Fee',
            PCT_REDUCTION: 'Percentage Reduction'
        };

        /**
         * Suitelet entry point
         */
        function onRequest(context) {
            try {
                if (context.request.method === 'GET') {
                    if (context.request.parameters.action === 'getprice') {
                        returnMarketPrice(context);
                    } else if (context.request.parameters.action === 'calculate') {
                        calculateSettlementServer(context);
                    } else if (context.request.parameters.settlementid || context.request.parameters.new === 'T') {
                        displaySettlementForm(context);
                    } else {
                        displaySettlementList(context);
                    }
                } else {
                    processFormSubmission(context);
                }
            } catch (e) {
                log.error('Settlement Calculation Error', e.toString());
                throw e;
            }
        }

        /**
         * Display settlement list/search page when no settlementid is provided
         */
        function displaySettlementList(context) {
            const form = serverWidget.createForm({
                title: 'Settlement Calculation'
            });

            form.clientScriptModulePath = './SUST_CS_SettlementCalculation.js';

            form.addButton({
                id: 'custpage_create_new',
                label: 'Create New Settlement',
                functionName: 'createNewSettlement'
            });

            // Settlement list sublist
            const sublist = form.addSublist({
                id: 'custpage_settlements',
                type: serverWidget.SublistType.LIST,
                label: 'Settlements'
            });

            const viewField = sublist.addField({ id: 'custpage_sl_view', type: serverWidget.FieldType.URL, label: 'View' });
            viewField.linkText = 'View';
            sublist.addField({ id: 'custpage_sl_id', type: serverWidget.FieldType.TEXT, label: 'ID' });
            sublist.addField({ id: 'custpage_sl_vendor', type: serverWidget.FieldType.TEXT, label: 'Vendor' });
            sublist.addField({ id: 'custpage_sl_date', type: serverWidget.FieldType.TEXT, label: 'Settlement Date' });
            sublist.addField({ id: 'custpage_sl_status', type: serverWidget.FieldType.TEXT, label: 'Status' });
            sublist.addField({ id: 'custpage_sl_method', type: serverWidget.FieldType.TEXT, label: 'Method' });
            sublist.addField({ id: 'custpage_sl_gross_lbs', type: serverWidget.FieldType.TEXT, label: 'Gross Lbs' });
            sublist.addField({ id: 'custpage_sl_net_value', type: serverWidget.FieldType.TEXT, label: 'Net Value' });

            // Resolve Suitelet URL for linking
            const suiteletUrl = url.resolveScript({
                scriptId: 'customscript_sust_sl_settlecalc',
                deploymentId: 'customdeploy_sust_sl_settlecalc'
            });

            // Search for all settlements, most recent first
            const settlementSearch = search.create({
                type: 'customrecord_sust_settlement_record',
                columns: [
                    search.createColumn({ name: 'created', sort: search.Sort.DESC }),
                    'custrecord_sust_settlement_vendor',
                    'custrecord_sust_settlement_date',
                    'custrecord_sust_settlement_status',
                    'custrecord_sust_settlement_method',
                    'custrecord_sust_settlement_gross_lbs',
                    'custrecord_sust_settlement_net_value'
                ]
            });

            let lineNum = 0;
            settlementSearch.run().each(function(result) {
                const viewUrl = suiteletUrl + '&settlementid=' + result.id;
                sublist.setSublistValue({ id: 'custpage_sl_view', line: lineNum, value: viewUrl });
                sublist.setSublistValue({ id: 'custpage_sl_id', line: lineNum, value: result.id });
                sublist.setSublistValue({ id: 'custpage_sl_vendor', line: lineNum, value: result.getText('custrecord_sust_settlement_vendor') || '' });
                sublist.setSublistValue({ id: 'custpage_sl_date', line: lineNum, value: result.getValue('custrecord_sust_settlement_date') || '' });
                sublist.setSublistValue({ id: 'custpage_sl_status', line: lineNum, value: result.getText('custrecord_sust_settlement_status') || '' });
                sublist.setSublistValue({ id: 'custpage_sl_method', line: lineNum, value: result.getText('custrecord_sust_settlement_method') || '' });
                // Read-only list display: lbs stored value + tons reference
                const listGrossLbs = result.getValue('custrecord_sust_settlement_gross_lbs');
                sublist.setSublistValue({
                    id: 'custpage_sl_gross_lbs',
                    line: lineNum,
                    value: listGrossLbs ? (listGrossLbs + ' (' + unitsLib.formatTons(listGrossLbs) + ')') : ''
                });
                sublist.setSublistValue({ id: 'custpage_sl_net_value', line: lineNum, value: result.getValue('custrecord_sust_settlement_net_value') || '' });

                lineNum++;
                return lineNum < 200;
            });

            context.response.writePage(form);
        }

        /**
         * Display the settlement calculation form with status-based field locking
         */
        function displaySettlementForm(context) {
            const form = serverWidget.createForm({
                title: 'Settlement Calculation'
            });

            form.clientScriptModulePath = './SUST_CS_SettlementCalculation.js';

            const settlementId = context.request.parameters.settlementid;
            let settlementRecord = null;
            let currentStatusText = STATUS.DRAFT;

            if (settlementId) {
                settlementRecord = record.load({
                    type: 'customrecord_sust_settlement_record',
                    id: settlementId
                });
                currentStatusText = settlementRecord.getText({ fieldId: 'custrecord_sust_settlement_status' }) || STATUS.DRAFT;
            }

            // Determine field locking levels based on status
            const isReadOnly = (currentStatusText === STATUS.FINAL_SETTLED || currentStatusText === STATUS.VOIDED);
            const isProvisionalOrBeyond = (currentStatusText === STATUS.PROVISIONAL_PAID || isReadOnly);
            const isCompletedOrBeyond = (currentStatusText === STATUS.COMPLETED || isProvisionalOrBeyond);

            // --- Hidden field for settlement ID ---
            const settlementIdField = form.addField({
                id: 'custpage_settlement_id',
                type: serverWidget.FieldType.TEXT,
                label: 'Settlement ID'
            });
            settlementIdField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            if (settlementId) {
                settlementIdField.defaultValue = settlementId;
            }

            // Hidden field to track original status (for client-side transition detection)
            const originalStatusField = form.addField({
                id: 'custpage_original_status',
                type: serverWidget.FieldType.TEXT,
                label: 'Original Status'
            });
            originalStatusField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            originalStatusField.defaultValue = currentStatusText;

            // ===== HEADER SECTION =====
            const headerGroup = form.addFieldGroup({
                id: 'custpage_header_group',
                label: 'Settlement Information'
            });

            // Vendor
            const vendorField = form.addField({
                id: 'custpage_vendor',
                type: serverWidget.FieldType.SELECT,
                label: 'Vendor/Customer',
                source: 'vendor',
                container: 'custpage_header_group'
            });
            vendorField.isMandatory = true;
            if (settlementRecord) {
                vendorField.defaultValue = settlementRecord.getValue('custrecord_sust_settlement_vendor');
            }
            if (isCompletedOrBeyond) {
                vendorField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            }

            // Settlement Date
            const dateField = form.addField({
                id: 'custpage_settlement_date',
                type: serverWidget.FieldType.DATE,
                label: 'Settlement Date',
                container: 'custpage_header_group'
            });
            dateField.isMandatory = true;
            if (settlementRecord) {
                dateField.defaultValue = settlementRecord.getValue('custrecord_sust_settlement_date');
            } else {
                dateField.defaultValue = format.format({ value: new Date(), type: format.Type.DATE });
            }
            if (isCompletedOrBeyond) {
                dateField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            }

            // Status — filtered to valid transitions only
            const statusField = form.addField({
                id: 'custpage_status',
                type: serverWidget.FieldType.SELECT,
                label: 'Status',
                container: 'custpage_header_group'
            });
            statusField.isMandatory = true;
            addFilteredStatusOptions(statusField, currentStatusText);
            if (isReadOnly) {
                statusField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            }

            // Method
            const methodField = form.addField({
                id: 'custpage_method',
                type: serverWidget.FieldType.SELECT,
                label: 'Settlement Method',
                source: 'customlist_sust_settlement_method',
                container: 'custpage_header_group'
            });
            methodField.isMandatory = true;
            if (settlementRecord) {
                methodField.defaultValue = settlementRecord.getValue('custrecord_sust_settlement_method');
            }
            if (isCompletedOrBeyond) {
                methodField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            }

            // Schedule
            const scheduleField = form.addField({
                id: 'custpage_schedule',
                type: serverWidget.FieldType.SELECT,
                label: 'Pricing Schedule',
                source: 'customrecord_sust_settlement_schedule',
                container: 'custpage_header_group'
            });
            if (settlementRecord) {
                scheduleField.defaultValue = settlementRecord.getValue('custrecord_sust_settlement_schedule');
            }
            if (isCompletedOrBeyond) {
                scheduleField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            }

            // Look up schedule market settings for auto-population
            let scheduleMarketPct = 100;
            let scheduleMarketAdj = 0;
            let scheduleMarketSourceText = '';
            let autoMarketPrice = null;

            const scheduleId = settlementRecord ? settlementRecord.getValue('custrecord_sust_settlement_schedule') : null;
            if (scheduleId) {
                try {
                    const scheduleLookup = search.lookupFields({
                        type: 'customrecord_sust_settlement_schedule',
                        id: scheduleId,
                        columns: ['custrecord_sust_schedule_market_ref', 'custrecord_sust_schedule_market_pct', 'custrecord_sust_schedule_market_adj']
                    });

                    const marketRef = scheduleLookup.custrecord_sust_schedule_market_ref;
                    if (marketRef && marketRef.length > 0) {
                        scheduleMarketSourceText = marketRef[0].text;
                    }
                    if (scheduleLookup.custrecord_sust_schedule_market_pct) {
                        scheduleMarketPct = parseFloat(scheduleLookup.custrecord_sust_schedule_market_pct) || 100;
                    }
                    if (scheduleLookup.custrecord_sust_schedule_market_adj) {
                        scheduleMarketAdj = parseFloat(scheduleLookup.custrecord_sust_schedule_market_adj) || 0;
                    }

                    if (scheduleMarketSourceText) {
                        const storedPrice = marketPriceLib.getLatestPrice(scheduleMarketSourceText);
                        if (storedPrice) {
                            autoMarketPrice = storedPrice;
                        }
                    }
                } catch (e) {
                    log.debug('Schedule Lookup', 'Could not load schedule details: ' + e.toString());
                }
            }

            // Hidden fields for schedule market adjustments (used by client-side calculation)
            const schedMarketPctField = form.addField({
                id: 'custpage_schedule_market_pct',
                type: serverWidget.FieldType.FLOAT,
                label: 'Schedule Market %'
            });
            schedMarketPctField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            schedMarketPctField.defaultValue = scheduleMarketPct;

            const schedMarketAdjField = form.addField({
                id: 'custpage_schedule_market_adj',
                type: serverWidget.FieldType.CURRENCY,
                label: 'Schedule Market Adj'
            });
            schedMarketAdjField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            schedMarketAdjField.defaultValue = scheduleMarketAdj;

            // ===== MATERIAL SECTION =====
            const materialGroup = form.addFieldGroup({
                id: 'custpage_material_group',
                label: 'Material Information'
            });

            // Gross Weight
            const grossLbsField = form.addField({
                id: 'custpage_gross_lbs',
                type: serverWidget.FieldType.FLOAT,
                label: 'Gross Weight (lbs)',
                container: 'custpage_material_group'
            });
            grossLbsField.isMandatory = true;
            if (settlementRecord) {
                grossLbsField.defaultValue = settlementRecord.getValue('custrecord_sust_settlement_gross_lbs');
            }
            if (isProvisionalOrBeyond) {
                grossLbsField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            }

            // Net Weight
            const netLbsField = form.addField({
                id: 'custpage_net_lbs',
                type: serverWidget.FieldType.FLOAT,
                label: 'Net Weight (lbs)',
                container: 'custpage_material_group'
            });
            if (settlementRecord) {
                netLbsField.defaultValue = settlementRecord.getValue('custrecord_sust_settlement_net_lbs');
            }
            if (isProvisionalOrBeyond) {
                netLbsField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            }

            // Recovery Percentage
            const recoveryPctField = form.addField({
                id: 'custpage_recovery_pct',
                type: serverWidget.FieldType.PERCENT,
                label: 'Recovery %',
                container: 'custpage_material_group'
            });
            recoveryPctField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            if (settlementRecord) {
                recoveryPctField.defaultValue = settlementRecord.getValue('custrecord_sust_settlement_recovery_pct');
            }

            // Read-only tons reference (stored values and math stay in lbs)
            if (settlementRecord) {
                const storedGrossLbs = parseFloat(settlementRecord.getValue('custrecord_sust_settlement_gross_lbs') || 0);
                const storedNetLbs = parseFloat(settlementRecord.getValue('custrecord_sust_settlement_net_lbs') || 0);
                const tonsSummaryField = form.addField({
                    id: 'custpage_tons_summary',
                    type: serverWidget.FieldType.INLINEHTML,
                    label: 'Tons Equivalent',
                    container: 'custpage_material_group'
                });
                tonsSummaryField.defaultValue =
                    '<div style="font-family: Arial, sans-serif; font-size: 12px; color: #374151; padding: 4px 0;">' +
                    '<b>Tons equivalent:</b> Gross ' + unitsLib.formatTons(storedGrossLbs) +
                    ' &middot; Net ' + unitsLib.formatTons(storedNetLbs) +
                    '</div>';
            }

            // ===== PRICING SECTION =====
            const pricingGroup = form.addFieldGroup({
                id: 'custpage_pricing_group',
                label: 'Pricing Details'
            });

            // Market Price
            const marketPriceField = form.addField({
                id: 'custpage_market_price',
                type: serverWidget.FieldType.CURRENCY,
                label: 'Market Price ($/lb)',
                container: 'custpage_pricing_group'
            });
            if (settlementRecord) {
                const existingMarketPrice = settlementRecord.getValue('custrecord_sust_settlement_market_price');
                if (existingMarketPrice) {
                    marketPriceField.defaultValue = existingMarketPrice;
                } else if (autoMarketPrice) {
                    marketPriceField.defaultValue = autoMarketPrice.pricePerLb;
                }
            } else if (autoMarketPrice) {
                marketPriceField.defaultValue = autoMarketPrice.pricePerLb;
            }
            if (autoMarketPrice) {
                marketPriceField.setHelpText({
                    help: 'Latest ' + scheduleMarketSourceText + ': $' + autoMarketPrice.pricePerLb.toFixed(4) + '/lb (' +
                        unitsLib.formatPerTon(autoMarketPrice.pricePerLb) + ') as of ' + autoMarketPrice.date
                });
            }
            if (isProvisionalOrBeyond) {
                marketPriceField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            }

            // Market Source
            const marketSourceField = form.addField({
                id: 'custpage_market_source',
                type: serverWidget.FieldType.SELECT,
                label: 'Market Price Source',
                source: 'customlist_sust_market_price_source',
                container: 'custpage_pricing_group'
            });
            if (settlementRecord) {
                const existingSource = settlementRecord.getValue('custrecord_sust_settlement_market_source');
                if (existingSource) {
                    marketSourceField.defaultValue = existingSource;
                } else if (scheduleMarketSourceText) {
                    marketSourceField.defaultValue = scheduleMarketSourceText;
                }
            }
            if (isProvisionalOrBeyond) {
                marketSourceField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            }

            // Treatment Charge
            const treatmentField = form.addField({
                id: 'custpage_treatment',
                type: serverWidget.FieldType.CURRENCY,
                label: 'Treatment Charges',
                container: 'custpage_pricing_group'
            });
            if (settlementRecord) {
                treatmentField.defaultValue = settlementRecord.getValue('custrecord_sust_settlement_treatment');
            }
            if (isProvisionalOrBeyond) {
                treatmentField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            }

            // Penalties (always disabled — calculated server-side)
            const penaltiesField = form.addField({
                id: 'custpage_penalties',
                type: serverWidget.FieldType.CURRENCY,
                label: 'Total Penalties',
                container: 'custpage_pricing_group'
            });
            penaltiesField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            if (settlementRecord) {
                penaltiesField.defaultValue = settlementRecord.getValue('custrecord_sust_settlement_penalties');
            }

            // ===== SETTLEMENT VALUES SECTION =====
            const valuesGroup = form.addFieldGroup({
                id: 'custpage_values_group',
                label: 'Settlement Values'
            });

            // Gross Value
            const grossValueField = form.addField({
                id: 'custpage_gross_value',
                type: serverWidget.FieldType.CURRENCY,
                label: 'Gross Value',
                container: 'custpage_values_group'
            });
            grossValueField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            if (settlementRecord) {
                grossValueField.defaultValue = settlementRecord.getValue('custrecord_sust_settlement_gross_value');
            }

            // Net Value
            const netValueField = form.addField({
                id: 'custpage_net_value',
                type: serverWidget.FieldType.CURRENCY,
                label: 'Net Settlement Value',
                container: 'custpage_values_group'
            });
            netValueField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            netValueField.isMandatory = true;
            if (settlementRecord) {
                netValueField.defaultValue = settlementRecord.getValue('custrecord_sust_settlement_net_value');
            }

            // Provisional Paid
            const provisionalField = form.addField({
                id: 'custpage_provisional',
                type: serverWidget.FieldType.CURRENCY,
                label: 'Provisional Paid',
                container: 'custpage_values_group'
            });
            if (settlementRecord) {
                provisionalField.defaultValue = settlementRecord.getValue('custrecord_sust_settlement_provisional');
            }
            if (isReadOnly) {
                provisionalField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            }

            // Balance Due
            const balanceField = form.addField({
                id: 'custpage_balance_due',
                type: serverWidget.FieldType.CURRENCY,
                label: 'Balance Due',
                container: 'custpage_values_group'
            });
            balanceField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            if (settlementRecord) {
                balanceField.defaultValue = settlementRecord.getValue('custrecord_sust_settlement_balance_due');
            }

            // ===== LINKED BILLS SECTION (show when bills exist) =====
            if (settlementRecord) {
                const provBill = settlementRecord.getValue('custrecord_sust_settlement_prov_bill');
                const finalBill = settlementRecord.getValue('custrecord_sust_settlement_bill');

                if (provBill || finalBill) {
                    const billGroup = form.addFieldGroup({
                        id: 'custpage_bill_group',
                        label: 'Linked Bills'
                    });

                    if (provBill) {
                        const provBillField = form.addField({
                            id: 'custpage_prov_bill_display',
                            type: serverWidget.FieldType.SELECT,
                            label: 'Provisional Bill',
                            source: 'transaction',
                            container: 'custpage_bill_group'
                        });
                        provBillField.defaultValue = provBill;
                        provBillField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
                    }

                    if (finalBill) {
                        const finalBillField = form.addField({
                            id: 'custpage_final_bill_display',
                            type: serverWidget.FieldType.SELECT,
                            label: 'Final Bill',
                            source: 'transaction',
                            container: 'custpage_bill_group'
                        });
                        finalBillField.defaultValue = finalBill;
                        finalBillField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
                    }
                }
            }

            // Notes
            const notesField = form.addField({
                id: 'custpage_notes',
                type: serverWidget.FieldType.TEXTAREA,
                label: 'Settlement Notes'
            });
            if (settlementRecord) {
                notesField.defaultValue = settlementRecord.getValue('custrecord_sust_settlement_notes');
            }
            if (isReadOnly) {
                notesField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            }

            // ===== BUTTONS =====
            if (!isReadOnly) {
                if (!isProvisionalOrBeyond) {
                    form.addButton({
                        id: 'custpage_calculate',
                        label: 'Calculate Settlement',
                        functionName: 'calculateSettlement'
                    });

                    form.addButton({
                        id: 'custpage_refresh_price',
                        label: 'Refresh Market Price',
                        functionName: 'refreshMarketPrice'
                    });
                }

                form.addSubmitButton({ label: 'Save Settlement' });
            }

            form.addButton({
                id: 'custpage_cancel',
                label: isReadOnly ? 'Back' : 'Cancel',
                functionName: 'cancelForm'
            });

            context.response.writePage(form);
        }

        /**
         * Add filtered status options based on current status.
         * Uses status TEXT as both value and display to avoid hardcoded internal ID issues.
         * processFormSubmission() uses setText() to save by text value.
         */
        function addFilteredStatusOptions(statusField, currentStatusText) {
            const validTargets = VALID_TRANSITIONS[currentStatusText] || [currentStatusText];
            const allStatuses = [STATUS.DRAFT, STATUS.COMPLETED, STATUS.PROVISIONAL_PAID, STATUS.FINAL_SETTLED, STATUS.VOIDED];

            statusField.addSelectOption({ value: '', text: '' });

            for (const statusText of allStatuses) {
                if (validTargets.indexOf(statusText) !== -1) {
                    statusField.addSelectOption({
                        value: statusText,
                        text: statusText,
                        isSelected: (statusText === currentStatusText)
                    });
                }
            }
        }

        /**
         * Server-side settlement calculation with penalty computation
         * Called via action=calculate&settlementid=X — returns JSON
         */
        function calculateSettlementServer(context) {
            const settlementId = context.request.parameters.settlementid;

            if (!settlementId) {
                context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
                context.response.write(JSON.stringify({ error: 'No settlement ID provided' }));
                return;
            }

            try {
                const result = performCalculation(settlementId);
                context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
                context.response.write(JSON.stringify(result));
            } catch (e) {
                log.error('Calculate Error', e.toString());
                context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
                context.response.write(JSON.stringify({ error: e.toString() }));
            }
        }

        /**
         * Perform full settlement calculation including penalties
         */
        function performCalculation(settlementId) {
            const settlement = record.load({
                type: 'customrecord_sust_settlement_record',
                id: settlementId
            });

            const netLbs = parseFloat(settlement.getValue({ fieldId: 'custrecord_sust_settlement_net_lbs' }) || 0);
            const marketPrice = parseFloat(settlement.getValue({ fieldId: 'custrecord_sust_settlement_market_price' }) || 0);
            const treatment = parseFloat(settlement.getValue({ fieldId: 'custrecord_sust_settlement_treatment' }) || 0);
            const provisional = parseFloat(settlement.getValue({ fieldId: 'custrecord_sust_settlement_provisional' }) || 0);
            const scheduleId = settlement.getValue({ fieldId: 'custrecord_sust_settlement_schedule' });
            const lotId = settlement.getValue({ fieldId: 'custrecord_sust_settlement_lot' });

            // v2: recovery % for recovered-pricing mode (SETTLE-003)
            const recoveryPct = parseFloat(settlement.getValue({ fieldId: 'custrecord_sust_settlement_recovery_pct' }) || 0);

            // v2: pricing method text from settlement record (rename-aware)
            const settleMethodText = (settlement.getText({ fieldId: 'custrecord_sust_settlement_method' }) || '').trim();

            // Get schedule market adjustments + method
            let scheduleMarketPct = 100;
            let scheduleMarketAdj = 0;
            let scheduleMethodText = '';
            if (scheduleId) {
                try {
                    const scheduleLookup = search.lookupFields({
                        type: 'customrecord_sust_settlement_schedule',
                        id: scheduleId,
                        columns: ['custrecord_sust_schedule_market_pct', 'custrecord_sust_schedule_market_adj', 'custrecord_sust_schedule_method']
                    });
                    if (scheduleLookup.custrecord_sust_schedule_market_pct) {
                        scheduleMarketPct = parseFloat(scheduleLookup.custrecord_sust_schedule_market_pct) || 100;
                    }
                    if (scheduleLookup.custrecord_sust_schedule_market_adj) {
                        scheduleMarketAdj = parseFloat(scheduleLookup.custrecord_sust_schedule_market_adj) || 0;
                    }
                    // Method is a SELECT — lookupFields returns [{value, text}]
                    const methodLookup = scheduleLookup.custrecord_sust_schedule_method;
                    if (methodLookup) {
                        scheduleMethodText = (Array.isArray(methodLookup) && methodLookup.length)
                            ? (methodLookup[0].text || '')
                            : (methodLookup.text || methodLookup.toString());
                    }
                } catch (e) {
                    log.debug('Schedule Lookup Error', e.toString());
                }
            }

            // Calculate effective price with schedule adjustments
            const effectivePrice = (marketPrice * scheduleMarketPct / 100) + scheduleMarketAdj;

            // Apply yield multiplier for Recovered-Pricing mode.
            // Worked example: index $0.16/lb × 100% schedule = $0.16/lb effective,
            // × 95% yield = $0.152 paid per pound of received material.
            const effectiveMethodText = scheduleMethodText || settleMethodText;
            const isRecoveredMode = effectiveMethodText.indexOf('Recover') !== -1;
            const recoveryFactor = (isRecoveredMode && recoveryPct > 0) ? (recoveryPct / 100) : 1;

            const grossValue = netLbs * effectivePrice * recoveryFactor;

            log.audit('Calc Path', `Method "${effectiveMethodText}" → ${isRecoveredMode ? 'Recovered (× recovery)' : 'Received (no recovery)'} | netLbs=${netLbs} × effectivePrice=${effectivePrice.toFixed(4)} × recoveryFactor=${recoveryFactor.toFixed(4)} = grossValue=${grossValue.toFixed(2)}`);

            // Calculate quality deductions from lot quality measurements and schedule deduction definitions
            const penaltyResult = calculatePenalties(scheduleId, lotId, netLbs, grossValue);

            const totalPenalties = penaltyResult.totalPenalties;
            const netValue = grossValue - treatment - totalPenalties;
            const balanceDue = netValue - provisional;

            // Save penalty detail records
            savePenaltyDetails(settlementId, penaltyResult.details);

            // Update settlement record with calculated values
            record.submitFields({
                type: 'customrecord_sust_settlement_record',
                id: settlementId,
                values: {
                    custrecord_sust_settlement_penalties: totalPenalties,
                    custrecord_sust_settlement_gross_value: grossValue,
                    custrecord_sust_settlement_net_value: netValue,
                    custrecord_sust_settlement_balance_due: balanceDue
                }
            });

            log.audit('Settlement Calculated', {
                settlementId: settlementId,
                effectivePrice: effectivePrice,
                grossValue: grossValue,
                totalPenalties: totalPenalties,
                netValue: netValue,
                balanceDue: balanceDue
            });

            return {
                effectivePrice: effectivePrice,
                grossValue: grossValue,
                totalPenalties: totalPenalties,
                netValue: netValue,
                balanceDue: balanceDue,
                penaltyDetails: penaltyResult.details,
                scheduleMarketPct: scheduleMarketPct,
                scheduleMarketAdj: scheduleMarketAdj
            };
        }

        /**
         * Calculate quality deductions from lot quality measurements + schedule deduction definitions
         */
        function calculatePenalties(scheduleId, lotId, netLbs, grossValue) {
            const result = { totalPenalties: 0, details: [] };

            if (!scheduleId || !lotId) {
                return result;
            }

            // Resolve the lot number string, then fetch measured quality values
            // (moisture / contamination) via the shared settlement-creation library.
            let lotQuality = null;
            try {
                const lotLookup = search.lookupFields({
                    type: 'inventorynumber',
                    id: lotId,
                    columns: ['inventorynumber']
                });
                const lotNumber = lotLookup.inventorynumber;
                if (!lotNumber) {
                    log.debug('Lot Quality Lookup', 'Lot ' + lotId + ' has no lot number — skipping quality deductions.');
                    return result;
                }
                lotQuality = settlementLib.getLotQuality(lotNumber);
            } catch (e) {
                log.debug('Lot Quality Lookup Error', 'Lot ' + lotId + ': ' + e.toString());
                return result;
            }

            // Get quality-deduction definitions from schedule
            let penaltyDefs = [];
            try {
                const penaltySearch = search.create({
                    type: 'customrecord_sust_settlement_penalty',
                    filters: [['custrecord_sust_penalty_schedule', 'anyof', scheduleId]],
                    columns: [
                        'custrecord_sust_penalty_element',
                        'custrecord_sust_penalty_threshold',
                        'custrecord_sust_penalty_rate',
                        'custrecord_sust_penalty_calculation'
                    ]
                });

                penaltySearch.run().each(function(r) {
                    penaltyDefs.push({
                        elementId: r.getValue('custrecord_sust_penalty_element'),
                        elementText: r.getText('custrecord_sust_penalty_element'),
                        threshold: parseFloat(r.getValue('custrecord_sust_penalty_threshold') || 0),
                        rate: parseFloat(r.getValue('custrecord_sust_penalty_rate') || 0),
                        calcTypeText: r.getText('custrecord_sust_penalty_calculation')
                    });
                    return true;
                });
            } catch (e) {
                log.debug('Penalty Defs Error', e.toString());
                return result;
            }

            // Evaluate each deduction definition against the lot's measured quality
            for (const def of penaltyDefs) {
                const qualityProp = QUALITY_METRIC_PROP[def.elementText];
                if (!qualityProp) {
                    // 'Other' (or any unmapped metric) has no measured lot value — skip
                    log.debug('Unmapped Quality Metric', 'No measured lot value for: ' + def.elementText);
                    continue;
                }

                const actualPct = parseFloat(lotQuality[qualityProp] || 0);
                const threshold = def.threshold;

                if (actualPct <= threshold) {
                    continue; // Below threshold — no penalty
                }

                const excessPct = actualPct - threshold;
                let penaltyAmount = 0;

                if (def.calcTypeText === PENALTY_CALC_TYPE.PER_PERCENTAGE) {
                    penaltyAmount = excessPct * def.rate * netLbs;
                } else if (def.calcTypeText === PENALTY_CALC_TYPE.FLAT_FEE) {
                    penaltyAmount = def.rate;
                } else if (def.calcTypeText === PENALTY_CALC_TYPE.PCT_REDUCTION) {
                    penaltyAmount = grossValue * (def.rate / 100);
                }

                if (penaltyAmount > 0) {
                    result.details.push({
                        elementId: def.elementId,
                        elementText: def.elementText,
                        actualPct: actualPct,
                        threshold: threshold,
                        excessPct: excessPct,
                        rate: def.rate,
                        calcType: def.calcTypeText,
                        amount: Math.round(penaltyAmount * 100) / 100
                    });
                    result.totalPenalties += penaltyAmount;
                }
            }

            result.totalPenalties = Math.round(result.totalPenalties * 100) / 100;
            return result;
        }

        /**
         * Save penalty detail records for a settlement (idempotent — deletes existing first)
         */
        function savePenaltyDetails(settlementId, penaltyDetails) {
            // Delete existing penalty details
            try {
                const existingSearch = search.create({
                    type: 'customrecord_sust_penalty_detail',
                    filters: [['custrecord_sust_penalty_settlement', 'anyof', settlementId]],
                    columns: ['internalid']
                });

                existingSearch.run().each(function(r) {
                    record.delete({ type: 'customrecord_sust_penalty_detail', id: r.id });
                    return true;
                });
            } catch (e) {
                log.debug('Delete Existing Penalty Details', e.toString());
            }

            // Create new penalty detail records
            for (const detail of penaltyDetails) {
                try {
                    const penaltyDetail = record.create({ type: 'customrecord_sust_penalty_detail' });
                    penaltyDetail.setValue({ fieldId: 'custrecord_sust_penalty_settlement', value: settlementId });
                    penaltyDetail.setValue({ fieldId: 'custrecord_sust_penalty_detail_element', value: detail.elementId });
                    penaltyDetail.setValue({ fieldId: 'custrecord_sust_penalty_detail_actual', value: detail.actualPct });
                    penaltyDetail.setValue({ fieldId: 'custrecord_sust_penalty_detail_threshold', value: detail.threshold });
                    penaltyDetail.setValue({ fieldId: 'custrecord_sust_penalty_detail_excess', value: detail.excessPct });
                    penaltyDetail.setValue({ fieldId: 'custrecord_sust_penalty_detail_rate', value: detail.rate });
                    penaltyDetail.setValue({ fieldId: 'custrecord_sust_penalty_detail_amount', value: detail.amount });
                    penaltyDetail.save();
                } catch (e) {
                    log.error('Save Penalty Detail Error', e.toString());
                }
            }
        }

        /**
         * Return market price as JSON (called via AJAX from client script)
         */
        function returnMarketPrice(context) {
            const marketSource = context.request.parameters.source;

            let result;
            if (marketSource) {
                result = marketPriceLib.getLatestPrice(marketSource);
            }

            context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
            context.response.write(JSON.stringify(result || { error: 'No price found for: ' + (marketSource || 'empty source') }));
        }

        /**
         * Process form submission
         */
        function processFormSubmission(context) {
            try {
                const settlementId = context.request.parameters.custpage_settlement_id;

                let settlementRecord;
                if (settlementId) {
                    settlementRecord = record.load({
                        type: 'customrecord_sust_settlement_record',
                        id: settlementId
                    });
                } else {
                    settlementRecord = record.create({
                        type: 'customrecord_sust_settlement_record'
                    });
                }

                // Set header fields
                settlementRecord.setValue({
                    fieldId: 'custrecord_sust_settlement_vendor',
                    value: context.request.parameters.custpage_vendor
                });

                const settlementDate = context.request.parameters.custpage_settlement_date;
                if (settlementDate) {
                    settlementRecord.setValue({
                        fieldId: 'custrecord_sust_settlement_date',
                        value: new Date(settlementDate)
                    });
                }

                // Use setText() because the status dropdown submits text values (not internal IDs)
                settlementRecord.setText({
                    fieldId: 'custrecord_sust_settlement_status',
                    text: context.request.parameters.custpage_status
                });

                settlementRecord.setValue({
                    fieldId: 'custrecord_sust_settlement_method',
                    value: context.request.parameters.custpage_method
                });

                settlementRecord.setValue({
                    fieldId: 'custrecord_sust_settlement_schedule',
                    value: context.request.parameters.custpage_schedule || ''
                });

                // Set material fields
                const grossLbs = parseFloat(context.request.parameters.custpage_gross_lbs || 0);
                const netLbs = parseFloat(context.request.parameters.custpage_net_lbs || 0);

                settlementRecord.setValue({ fieldId: 'custrecord_sust_settlement_gross_lbs', value: grossLbs });
                settlementRecord.setValue({ fieldId: 'custrecord_sust_settlement_net_lbs', value: netLbs });

                const recoveryPct = grossLbs > 0 ? (netLbs / grossLbs) * 100 : 0;
                settlementRecord.setValue({ fieldId: 'custrecord_sust_settlement_recovery_pct', value: recoveryPct });

                // Set pricing fields — parseFloat to strip currency formatting
                const marketPriceVal = parseFloat(context.request.parameters.custpage_market_price || 0);
                if (marketPriceVal > 0) {
                    settlementRecord.setValue({
                        fieldId: 'custrecord_sust_settlement_market_price',
                        value: marketPriceVal
                    });
                }

                const marketSourceVal = context.request.parameters.custpage_market_source;
                if (marketSourceVal) {
                    settlementRecord.setValue({
                        fieldId: 'custrecord_sust_settlement_market_source',
                        value: marketSourceVal
                    });
                }

                const treatmentVal = parseFloat(context.request.parameters.custpage_treatment || 0);
                settlementRecord.setValue({
                    fieldId: 'custrecord_sust_settlement_treatment',
                    value: treatmentVal
                });

                // Persist form-side scalars (provisional + notes); calc fields below
                const provisional = parseFloat(context.request.parameters.custpage_provisional || 0);
                settlementRecord.setValue({ fieldId: 'custrecord_sust_settlement_provisional', value: provisional });

                settlementRecord.setValue({
                    fieldId: 'custrecord_sust_settlement_notes',
                    value: context.request.parameters.custpage_notes || ''
                });

                const savedSettlementId = settlementRecord.save();
                log.audit('Settlement Record Saved', 'Settlement ID: ' + savedSettlementId);

                // v2 fix: always recalc on save using the schedule-aware engine.
                // The legacy save path computed grossValue = netLbs × marketPrice (raw),
                // ignoring schedule market % / adj / recovery / penalties — silently
                // overwriting whatever Calculate had produced. Route through performCalculation()
                // so saves always reflect the true schedule-driven math.
                try {
                    const calcResult = performCalculation(savedSettlementId);
                    log.audit('Settlement Recalc on Save',
                        `Settlement ${savedSettlementId}: gross=${calcResult.grossValue.toFixed(2)}, ` +
                        `penalties=${calcResult.totalPenalties.toFixed(2)}, net=${calcResult.netValue.toFixed(2)}`);
                } catch (calcErr) {
                    log.error('Recalc on Save Failed',
                        `Settlement ${savedSettlementId}: ${calcErr.message} — record saved but calc fields may be stale.`);
                }

                // Redirect back to Suitelet so user sees field locking applied
                redirect.toSuitelet({
                    scriptId: 'customscript_sust_sl_settlecalc',
                    deploymentId: 'customdeploy_sust_sl_settlecalc',
                    parameters: { settlementid: savedSettlementId }
                });

            } catch (e) {
                log.error('Error saving settlement', e.toString());
                throw e;
            }
        }

        return {
            onRequest: onRequest
        };
    });
