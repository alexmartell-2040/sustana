/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 * @description Processing Entry Interface - Custom UI for recycling/processing operations (1 input → multiple outputs)
 */
define(['N/ui/serverWidget', 'N/record', 'N/search', 'N/redirect', 'N/log', 'N/runtime', './SUST_Lib_Units'],
    (serverWidget, record, search, redirect, log, runtime, units) => {

        // UNITS: the form is entered/displayed in TONS; all stored record values
        // (processing record, output lines) stay in POUNDS. POST converts with
        // units.toLbs(); GET display converts with units.toTons().

        const PROCESSING_STATUS = {
            DRAFT: '1',        // val_scheduled
            IN_PROCESS: '2',   // val_in_process
            COMPLETED: '3'     // val_completed
        };

        /**
         * Main entry point for the Suitelet
         * @param {Object} context
         * @param {ServerRequest} context.request
         * @param {ServerResponse} context.response
         */
        const onRequest = (context) => {
            try {
                if (context.request.method === 'GET') {
                    displayProcessingForm(context);
                } else {
                    processFormSubmission(context);
                }
            } catch (e) {
                log.error('onRequest', {
                    error: e.message,
                    stack: e.stack
                });
                context.response.write(`<html><body><h1>Error</h1><p>${e.message}</p></body></html>`);
            }
        };

        /**
         * Display the processing entry form
         * @param {Object} context
         */
        const displayProcessingForm = (context) => {
            const processingId = context.request.parameters.processingid;
            const isEdit = !!processingId;

            const form = serverWidget.createForm({
                title: 'Sustana Recovery — Processing Entry (No BOM / No Work Order)'
            });

            // Attach client script
            form.clientScriptModulePath = './SUST_CS_ProcessingEntry.js';

            // Add hidden field for processing ID (for edits)
            const hiddenId = form.addField({
                id: 'custpage_processing_id',
                type: serverWidget.FieldType.TEXT,
                label: 'Processing ID'
            });
            hiddenId.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            if (processingId) {
                hiddenId.defaultValue = processingId;
            }

            // v2.2: Awaiting Cost banner — shown when this processing record is waiting for
            // settlement cost determination. Only renders for edit context (processingId set).
            let isAwaitingCost = false;
            let linkedSettlementId = null;
            if (processingId) {
                try {
                    const procLookup = search.lookupFields({
                        type: 'customrecord_sust_processing_record',
                        id: processingId,
                        columns: ['custrecord_sust_processing_status', 'custrecord_sust_processing_settlement', 'custrecord_sust_proc_ia_pending']
                    });
                    const statusText = procLookup.custrecord_sust_processing_status
                        && Array.isArray(procLookup.custrecord_sust_processing_status)
                        && procLookup.custrecord_sust_processing_status.length
                            ? procLookup.custrecord_sust_processing_status[0].text
                            : '';
                    isAwaitingCost = statusText === 'Awaiting Cost'
                        || procLookup.custrecord_sust_proc_ia_pending === true
                        || procLookup.custrecord_sust_proc_ia_pending === 'T';
                    if (procLookup.custrecord_sust_processing_settlement) {
                        linkedSettlementId = Array.isArray(procLookup.custrecord_sust_processing_settlement)
                            ? procLookup.custrecord_sust_processing_settlement[0].value
                            : procLookup.custrecord_sust_processing_settlement;
                    }
                } catch (lookupErr) {
                    log.debug('Awaiting Cost banner lookup failed', lookupErr.message);
                }
            }

            if (isAwaitingCost) {
                const banner = form.addField({
                    id: 'custpage_awaiting_cost_banner',
                    type: serverWidget.FieldType.INLINEHTML,
                    label: ' '
                });
                const settlementLink = linkedSettlementId
                    ? '<a href="/app/common/custom/custrecordentry.nl?id=' + linkedSettlementId
                        + '" style="color:#1f5fcc;text-decoration:underline">View linked settlement #' + linkedSettlementId + '</a>'
                    : '<em>No linked settlement found — link manually before completion.</em>';
                banner.defaultValue =
                    '<div style="background:#fefaf0;border-left:4px solid #b87f00;padding:14px 18px;margin:10px 0;font-family:Calibri,Arial,sans-serif">' +
                    '<div style="font-size:9pt;letter-spacing:0.08em;text-transform:uppercase;color:#b87f00;font-weight:700;margin-bottom:4px">' +
                    'AWAITING COST — IA DEFERRED</div>' +
                    '<div style="font-size:11pt;color:#1a1a1a;margin-bottom:6px">' +
                    'This processing record was completed with Total Input Cost = $0 (deferred-pricing path). ' +
                    'The Inventory Adjustment will be created automatically when the linked settlement closes and the cost is determined.</div>' +
                    '<div style="font-size:10pt;color:#555">' + settlementLink + '</div>' +
                    '</div>';
            }

            // ==================== HEADER SECTION ====================
            const headerGroup = form.addFieldGroup({
                id: 'custpage_header_group',
                label: 'Processing Header'
            });

            // Processing Number (auto-generated)
            const procNumberField = form.addField({
                id: 'custpage_proc_number',
                type: serverWidget.FieldType.TEXT,
                label: 'Processing Number',
                container: 'custpage_header_group'
            });
            if (!isEdit) {
                procNumberField.defaultValue = '(Auto-generated on save)';
                procNumberField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            }

            // Processing Date
            const procDateField = form.addField({
                id: 'custpage_proc_date',
                type: serverWidget.FieldType.DATE,
                label: 'Processing Date',
                container: 'custpage_header_group'
            });
            procDateField.isMandatory = true;
            procDateField.defaultValue = new Date();

            // Status
            const statusField = form.addField({
                id: 'custpage_status',
                type: serverWidget.FieldType.SELECT,
                label: 'Status',
                container: 'custpage_header_group'
            });
            statusField.addSelectOption({ value: PROCESSING_STATUS.DRAFT, text: 'Draft' });
            statusField.addSelectOption({ value: PROCESSING_STATUS.IN_PROCESS, text: 'In Process' });
            statusField.addSelectOption({ value: PROCESSING_STATUS.COMPLETED, text: 'Completed' });
            statusField.defaultValue = PROCESSING_STATUS.DRAFT;
            statusField.isMandatory = true;

            // Processing Type
            const processTypeField = form.addField({
                id: 'custpage_process_type',
                type: serverWidget.FieldType.SELECT,
                label: 'Processing Type',
                source: 'customlist_sust_process_type',
                container: 'custpage_header_group'
            });
            processTypeField.isMandatory = true;

            // Operator
            const operatorField = form.addField({
                id: 'custpage_operator',
                type: serverWidget.FieldType.SELECT,
                label: 'Operator',
                source: 'employee',
                container: 'custpage_header_group'
            });

            // Location
            const locationField = form.addField({
                id: 'custpage_location',
                type: serverWidget.FieldType.SELECT,
                label: 'Location',
                source: 'location',
                container: 'custpage_header_group'
            });

            // Source Transaction (optional - can be PO, Item Receipt, etc.)
            const poField = form.addField({
                id: 'custpage_po',
                type: serverWidget.FieldType.SELECT,
                label: 'Source Transaction',
                source: 'transaction',
                container: 'custpage_header_group'
            });

            // ==================== INPUT SECTION ====================
            const inputGroup = form.addFieldGroup({
                id: 'custpage_input_group',
                label: 'Input Material'
            });

            // v2: Source Type — drives downstream behavior
            const sourceTypeField = form.addField({
                id: 'custpage_source_type',
                type: serverWidget.FieldType.SELECT,
                label: 'Source Type',
                source: 'customlist_sust_proc_source_type',
                container: 'custpage_input_group'
            });

            // v2: Equipment used
            const equipmentField = form.addField({
                id: 'custpage_equipment',
                type: serverWidget.FieldType.SELECT,
                label: 'Equipment',
                source: 'customlist_sust_equipment',
                container: 'custpage_input_group'
            });

            // Input Item
            const inputItemField = form.addField({
                id: 'custpage_input_item',
                type: serverWidget.FieldType.SELECT,
                label: 'Input Item',
                source: 'item',
                container: 'custpage_input_group'
            });
            inputItemField.isMandatory = true;

            // Input Lot
            const inputLotField = form.addField({
                id: 'custpage_input_lot',
                type: serverWidget.FieldType.SELECT,
                label: 'Input Lot',
                source: 'inventorynumber',
                container: 'custpage_input_group'
            });
            inputLotField.isMandatory = true;

            // Input Weight — entered in TONS (stored on the record in lbs; converted on POST)
            const inputWeightField = form.addField({
                id: 'custpage_input_weight',
                type: serverWidget.FieldType.FLOAT,
                label: 'Input Weight (tons)',
                container: 'custpage_input_group'
            });
            inputWeightField.isMandatory = true;

            // v2: Gross Input (full weight before tare) — entered in TONS
            const grossInputField = form.addField({
                id: 'custpage_gross_input',
                type: serverWidget.FieldType.FLOAT,
                label: 'Gross Input (tons)',
                container: 'custpage_input_group'
            });

            // v2: Tare Estimate (from receiver lot at receipt time) — entered in TONS
            const tareEstField = form.addField({
                id: 'custpage_tare_estimate',
                type: serverWidget.FieldType.FLOAT,
                label: 'Tare Estimate (tons)',
                container: 'custpage_input_group'
            });

            // v2: Tare Actual (measured at processing) — entered in TONS
            const tareActualField = form.addField({
                id: 'custpage_tare_actual',
                type: serverWidget.FieldType.FLOAT,
                label: 'Tare Actual (tons)',
                container: 'custpage_input_group'
            });

            // v2: Total Input Cost (drives cost allocation)
            const totalInputCostField = form.addField({
                id: 'custpage_total_input_cost',
                type: serverWidget.FieldType.CURRENCY,
                label: 'Total Input Cost ($)',
                container: 'custpage_input_group'
            });
            totalInputCostField.setHelpText({
                help: 'Total $ being allocated across outputs by the cost allocation engine. Leave $0 for Post-Processing deferred-pricing mode — cost flows back from Settlement Completed.'
            });

            // v2.1: Allocation Mode — drives cost allocation engine behavior
            const allocModeField = form.addField({
                id: 'custpage_alloc_mode',
                type: serverWidget.FieldType.SELECT,
                label: 'Allocation Mode',
                source: 'customlist_sust_alloc_mode',
                container: 'custpage_input_group'
            });
            allocModeField.setHelpText({
                help: 'Cost allocation method. Byproduct (default, GAAP-recommended) — primary output absorbs cost, byproducts at NRV. Relative NRV — pro-rata by NRV across all outputs. Weight — allocates cost uniformly by weight (legacy).'
            });
            // Default to Byproduct on new records. On edit, value is set by loadExistingProcessing().

            // ==================== OUTPUT LINES SUBLIST ====================
            const outputSublist = form.addSublist({
                id: 'custpage_output_lines',
                type: serverWidget.SublistType.INLINEEDITOR,
                label: 'Output Materials'
            });

            // Line Number
            outputSublist.addField({
                id: 'custpage_line_num',
                type: serverWidget.FieldType.INTEGER,
                label: 'Line #'
            }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });

            // Output Item
            const outItemField = outputSublist.addField({
                id: 'custpage_out_item',
                type: serverWidget.FieldType.SELECT,
                label: 'Output Item',
                source: 'item'
            });
            outItemField.isMandatory = true;

            // Output Type
            const outTypeField = outputSublist.addField({
                id: 'custpage_out_type',
                type: serverWidget.FieldType.SELECT,
                label: 'Output Type',
                source: 'customlist_sust_output_type'
            });
            outTypeField.isMandatory = true;

            // Output Weight — entered in TONS (stored on the line record in lbs; converted on POST)
            const outWeightField = outputSublist.addField({
                id: 'custpage_out_weight',
                type: serverWidget.FieldType.FLOAT,
                label: 'Weight (tons)'
            });
            outWeightField.isMandatory = true;

            // Output Percentage (calculated)
            const outPctField = outputSublist.addField({
                id: 'custpage_out_pct',
                type: serverWidget.FieldType.PERCENT,
                label: '% of Input'
            });
            outPctField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });

            // Output Lot (will be auto-generated)
            outputSublist.addField({
                id: 'custpage_out_lot',
                type: serverWidget.FieldType.TEXT,
                label: 'Output Lot'
            }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });

            // Disposition
            outputSublist.addField({
                id: 'custpage_disposition',
                type: serverWidget.FieldType.SELECT,
                label: 'Disposition',
                source: 'customlist_sust_output_disposition'
            });

            // ==================== NOTES SECTION ====================
            const notesField = form.addField({
                id: 'custpage_notes',
                type: serverWidget.FieldType.TEXTAREA,
                label: 'Processing Notes'
            });

            // ==================== BUTTONS ====================
            form.addSubmitButton({ label: 'Save Processing Record' });

            form.addButton({
                id: 'custpage_btn_load_defaults',
                label: 'Load Default Outputs',
                functionName: 'loadDefaultOutputs'
            });

            form.addButton({
                id: 'custpage_btn_clear',
                label: 'Clear Output Lines',
                functionName: 'clearOutputLines'
            });

            // ==================== LOAD EXISTING DATA ====================
            if (isEdit) {
                loadExistingProcessing(form, processingId);
            }

            // ==================== PRE-POPULATE FROM ITEM RECEIPT ====================
            const itemReceiptId = context.request.parameters.itemreceiptid;
            if (itemReceiptId && !isEdit) {
                // v2.3: optional ?line=<lineuniquekey> targets a specific IR scrap line
                prePopulateFromItemReceipt(form, itemReceiptId, context.request.parameters.line);
            }

            context.response.writePage(form);
        };

        /**
         * Load existing processing record data into the form
         * @param {Form} form
         * @param {string|number} processingId
         */
        const loadExistingProcessing = (form, processingId) => {
            try {
                const procRec = record.load({
                    type: 'customrecord_sust_processing_record',
                    id: processingId
                });

                // Set header fields
                form.getField({ id: 'custpage_proc_number' }).defaultValue = procRec.getValue('name');
                form.getField({ id: 'custpage_proc_date' }).defaultValue = procRec.getValue('custrecord_sust_processing_date');
                form.getField({ id: 'custpage_status' }).defaultValue = procRec.getValue('custrecord_sust_processing_status');
                form.getField({ id: 'custpage_process_type' }).defaultValue = procRec.getValue('custrecord_sust_processing_type');
                form.getField({ id: 'custpage_operator' }).defaultValue = procRec.getValue('custrecord_sust_processing_operator');
                form.getField({ id: 'custpage_location' }).defaultValue = procRec.getValue('custrecord_sust_processing_location');
                form.getField({ id: 'custpage_po' }).defaultValue = procRec.getValue('custrecord_sust_processing_po');

                // Set input fields — stored weights are POUNDS; the form shows TONS
                form.getField({ id: 'custpage_input_item' }).defaultValue = procRec.getValue('custrecord_sust_processing_input_item');
                form.getField({ id: 'custpage_input_lot' }).defaultValue = procRec.getValue('custrecord_sust_processing_input_lot');
                form.getField({ id: 'custpage_input_weight' }).defaultValue = units.toTons(procRec.getValue('custrecord_sust_processing_input_lbs'));

                // v2/v2.1 fields — only set if the form field exists (defensive).
                // Optional transform converts stored value for display (e.g. lbs -> tons).
                const setIfPresent = (fieldId, recordFieldId, transform) => {
                    try {
                        const f = form.getField({ id: fieldId });
                        const v = procRec.getValue(recordFieldId);
                        if (f && v !== null && v !== '' && v !== undefined) {
                            f.defaultValue = transform ? transform(v) : v;
                        }
                    } catch (e) { /* field not on form — ignore */ }
                };
                setIfPresent('custpage_source_type', 'custrecord_sust_proc_source_type');
                setIfPresent('custpage_equipment', 'custrecord_sust_proc_equipment');
                setIfPresent('custpage_gross_input', 'custrecord_sust_proc_gross_input_lbs', units.toTons);
                setIfPresent('custpage_tare_estimate', 'custrecord_sust_proc_tare_estimate_lbs', units.toTons);
                setIfPresent('custpage_tare_actual', 'custrecord_sust_proc_tare_actual_lbs', units.toTons);
                setIfPresent('custpage_total_input_cost', 'custrecord_sust_proc_total_input_cost');
                setIfPresent('custpage_alloc_mode', 'custrecord_sust_processing_alloc_mode');

                // Set notes
                form.getField({ id: 'custpage_notes' }).defaultValue = procRec.getValue('custrecord_sust_processing_notes');

                // v2.3: preserve the source line key through edit so the line scope round-trips
                try {
                    const slKey = procRec.getValue('custrecord_sust_proc_source_line');
                    if (slKey !== null && slKey !== '' && slKey !== undefined) {
                        const f = form.addField({
                            id: 'custpage_source_line',
                            type: serverWidget.FieldType.TEXT,
                            label: 'Source Line Key'
                        });
                        f.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
                        f.defaultValue = String(slKey);
                    }
                } catch (e) { /* field add best-effort */ }

                // Load output lines
                loadExistingOutputLines(form, processingId);

                log.audit('loadExistingProcessing', 'Loaded processing record: ' + processingId);
            } catch (e) {
                log.error('loadExistingProcessing', {
                    error: e.message,
                    processingId: processingId
                });
            }
        };

        /**
         * Load existing output lines into the sublist
         * @param {Form} form
         * @param {string|number} processingId
         */
        const loadExistingOutputLines = (form, processingId) => {
            const outputLines = search.create({
                type: 'customrecord_sust_processing_output_line',
                filters: [
                    ['custrecord_sust_output_processing', 'anyof', processingId]
                ],
                columns: [
                    'custrecord_sust_output_line_number',
                    'custrecord_sust_output_item',
                    'custrecord_sust_output_type',
                    'custrecord_sust_output_weight',
                    'custrecord_sust_output_percentage',
                    'custrecord_sust_output_lot',
                    'custrecord_sust_output_disposition'
                ]
            });

            const sublist = form.getSublist({ id: 'custpage_output_lines' });
            let lineNum = 0;

            outputLines.run().each(result => {
                sublist.setSublistValue({
                    id: 'custpage_line_num',
                    line: lineNum,
                    value: result.getValue('custrecord_sust_output_line_number')
                });
                sublist.setSublistValue({
                    id: 'custpage_out_item',
                    line: lineNum,
                    value: result.getValue('custrecord_sust_output_item')
                });
                sublist.setSublistValue({
                    id: 'custpage_out_type',
                    line: lineNum,
                    value: result.getValue('custrecord_sust_output_type')
                });
                // Stored weight is POUNDS; the sublist entry field is TONS
                sublist.setSublistValue({
                    id: 'custpage_out_weight',
                    line: lineNum,
                    value: String(units.toTons(result.getValue('custrecord_sust_output_weight')))
                });
                sublist.setSublistValue({
                    id: 'custpage_out_pct',
                    line: lineNum,
                    value: result.getValue('custrecord_sust_output_percentage') || 0
                });
                sublist.setSublistValue({
                    id: 'custpage_out_lot',
                    line: lineNum,
                    value: result.getValue('custrecord_sust_output_lot') || '(Auto-generated)'
                });
                sublist.setSublistValue({
                    id: 'custpage_disposition',
                    line: lineNum,
                    value: result.getValue('custrecord_sust_output_disposition')
                });

                lineNum++;
                return true;
            });
        };

        /**
         * Process form submission
         * @param {Object} context
         */
        const processFormSubmission = (context) => {
            const params = context.request.parameters;
            const existingId = params.custpage_processing_id;
            const isEdit = !!existingId;

            let processingId;

            try {
                // Create or load processing record
                let procRec;
                if (isEdit) {
                    procRec = record.load({
                        type: 'customrecord_sust_processing_record',
                        id: existingId
                    });
                } else {
                    procRec = record.create({
                        type: 'customrecord_sust_processing_record'
                    });
                    // Generate processing number
                    const procNumber = generateProcessingNumber();
                    procRec.setValue({ fieldId: 'name', value: procNumber });
                }

                // Store requested status for later
                const requestedStatus = params.custpage_status;

                // Set header fields
                procRec.setValue({ fieldId: 'custrecord_sust_processing_date', value: new Date(params.custpage_proc_date) });

                // For new records with COMPLETED status, save as DRAFT first to prevent premature User Event firing
                if (!isEdit && requestedStatus === PROCESSING_STATUS.COMPLETED) {
                    procRec.setValue({ fieldId: 'custrecord_sust_processing_status', value: PROCESSING_STATUS.DRAFT });
                } else {
                    procRec.setValue({ fieldId: 'custrecord_sust_processing_status', value: requestedStatus });
                }

                procRec.setValue({ fieldId: 'custrecord_sust_processing_type', value: params.custpage_process_type });
                if (params.custpage_operator) {
                    procRec.setValue({ fieldId: 'custrecord_sust_processing_operator', value: params.custpage_operator });
                }
                if (params.custpage_location) {
                    procRec.setValue({ fieldId: 'custrecord_sust_processing_location', value: params.custpage_location });
                }
                if (params.custpage_po) {
                    procRec.setValue({ fieldId: 'custrecord_sust_processing_po', value: params.custpage_po });
                }
                // v2.3 line-level: bind this processing record to the source IR line
                if (params.custpage_source_line) {
                    procRec.setValue({ fieldId: 'custrecord_sust_proc_source_line', value: parseInt(params.custpage_source_line, 10) });
                }

                // Set input fields — form weights arrive in TONS; convert to POUNDS
                // with units.toLbs() BEFORE any record write (stored values stay lbs)
                const inputWeightLbs = units.toLbs(params.custpage_input_weight);
                procRec.setValue({ fieldId: 'custrecord_sust_processing_input_item', value: params.custpage_input_item });
                procRec.setValue({ fieldId: 'custrecord_sust_processing_input_lot', value: params.custpage_input_lot });
                procRec.setValue({ fieldId: 'custrecord_sust_processing_input_lbs', value: inputWeightLbs });

                // v2: Set source type + equipment + weight detail + total input cost
                if (params.custpage_source_type) {
                    procRec.setValue({ fieldId: 'custrecord_sust_proc_source_type', value: params.custpage_source_type });
                }
                if (params.custpage_equipment) {
                    procRec.setValue({ fieldId: 'custrecord_sust_proc_equipment', value: params.custpage_equipment });
                }
                if (params.custpage_gross_input) {
                    procRec.setValue({ fieldId: 'custrecord_sust_proc_gross_input_lbs', value: units.toLbs(params.custpage_gross_input) });
                }
                if (params.custpage_tare_estimate) {
                    procRec.setValue({ fieldId: 'custrecord_sust_proc_tare_estimate_lbs', value: units.toLbs(params.custpage_tare_estimate) });
                }
                if (params.custpage_tare_actual) {
                    procRec.setValue({ fieldId: 'custrecord_sust_proc_tare_actual_lbs', value: units.toLbs(params.custpage_tare_actual) });
                }
                if (params.custpage_total_input_cost) {
                    procRec.setValue({ fieldId: 'custrecord_sust_proc_total_input_cost', value: parseFloat(params.custpage_total_input_cost) || 0 });
                }

                // v2.1: Allocation Mode (drives cost allocation engine)
                if (params.custpage_alloc_mode) {
                    procRec.setValue({ fieldId: 'custrecord_sust_processing_alloc_mode', value: params.custpage_alloc_mode });
                }

                // Set notes
                procRec.setValue({ fieldId: 'custrecord_sust_processing_notes', value: params.custpage_notes || '' });

                // Start/End times: start stamps when work begins (In Process, or any
                // completed-path save without one), end stamps at Completed.
                stampTimes(procRec, requestedStatus);

                // Save parent record
                processingId = procRec.save();
                log.audit('processFormSubmission', 'Saved processing record: ' + processingId);

                // Save output lines (input weight passed in POUNDS)
                saveOutputLines(processingId, context.request, inputWeightLbs);

                // If this was a new record with COMPLETED status, now update to trigger the
                // User Event. MUST be a full load+save (EDIT context) — submitFields fires
                // the UE as XEDIT, which the IA-creation UE ignores, so the Inventory
                // Adjustment silently never happened for form-submitted Completed records.
                if (!isEdit && requestedStatus === PROCESSING_STATUS.COMPLETED) {
                    log.audit('processFormSubmission', 'Updating status to COMPLETED to trigger Inventory Adjustment creation');
                    const flip = record.load({ type: 'customrecord_sust_processing_record', id: processingId });
                    flip.setValue({ fieldId: 'custrecord_sust_processing_status', value: PROCESSING_STATUS.COMPLETED });
                    stampTimes(flip, PROCESSING_STATUS.COMPLETED);
                    flip.save();
                    log.audit('processFormSubmission', 'Status updated to COMPLETED');
                }

                // Redirect to the saved record
                redirect.toRecord({
                    type: 'customrecord_sust_processing_record',
                    id: processingId
                });

            } catch (e) {
                log.error('processFormSubmission', {
                    error: e.message,
                    stack: e.stack
                });
                throw e;
            }
        };

        /**
         * Save output lines for a processing record.
         * Sublist weights POST in TONS; stored line weights are POUNDS.
         * @param {string|number} processingId
         * @param {ServerRequest} request
         * @param {number} inputWeightLbs input weight in POUNDS
         */
        const saveOutputLines = (processingId, request, inputWeightLbs) => {
            // Delete existing output lines
            const existingLines = search.create({
                type: 'customrecord_sust_processing_output_line',
                filters: [
                    ['custrecord_sust_output_processing', 'anyof', processingId]
                ],
                columns: ['internalid']
            });

            existingLines.run().each(result => {
                try {
                    record.delete({
                        type: 'customrecord_sust_processing_output_line',
                        id: result.id
                    });
                } catch (e) {
                    log.error('saveOutputLines', 'Error deleting existing line: ' + e.message);
                }
                return true;
            });

            // Get line count
            const lineCount = request.getLineCount({ group: 'custpage_output_lines' });

            // Create new output lines
            for (let i = 0; i < lineCount; i++) {
                const outItem = request.getSublistValue({ group: 'custpage_output_lines', name: 'custpage_out_item', line: i });
                const outType = request.getSublistValue({ group: 'custpage_output_lines', name: 'custpage_out_type', line: i });
                const outWeight = request.getSublistValue({ group: 'custpage_output_lines', name: 'custpage_out_weight', line: i });
                const disposition = request.getSublistValue({ group: 'custpage_output_lines', name: 'custpage_disposition', line: i });

                if (!outItem || !outType || !outWeight) continue;

                try {
                    const outputLine = record.create({
                        type: 'customrecord_sust_processing_output_line'
                    });

                    // Form weight is TONS — convert to POUNDS before writing the record
                    const outWeightLbs = units.toLbs(outWeight);

                    outputLine.setValue({ fieldId: 'custrecord_sust_output_processing', value: processingId });
                    outputLine.setValue({ fieldId: 'custrecord_sust_output_line_number', value: i + 1 });
                    outputLine.setValue({ fieldId: 'custrecord_sust_output_item', value: outItem });
                    outputLine.setValue({ fieldId: 'custrecord_sust_output_type', value: outType });
                    outputLine.setValue({ fieldId: 'custrecord_sust_output_weight', value: outWeightLbs });

                    // Calculate percentage (lbs ÷ lbs — same ratio as tons ÷ tons)
                    if (inputWeightLbs > 0) {
                        const outPct = (outWeightLbs / inputWeightLbs) * 100;
                        outputLine.setValue({ fieldId: 'custrecord_sust_output_percentage', value: outPct });
                    }

                    if (disposition) {
                        outputLine.setValue({ fieldId: 'custrecord_sust_output_disposition', value: disposition });
                    }

                    const lineId = outputLine.save();
                    log.audit('saveOutputLines', 'Created output line: ' + lineId);
                } catch (e) {
                    log.error('saveOutputLines', {
                        error: e.message,
                        line: i
                    });
                }
            }
        };

        /**
         * Generate a processing number in format PROC-YYMMDD-NNN
         * @returns {string}
         */
        /**
         * Stamp start/end dates for the requested status: start when work
         * begins (In Process) or when completing without one; end at Completed.
         * Never overwrites an existing stamp.
         */
        function stampTimes(procRec, statusVal) {
            try {
                const started = procRec.getValue({ fieldId: 'custrecord_sust_processing_start_date' });
                const ended = procRec.getValue({ fieldId: 'custrecord_sust_processing_end_date' });
                if (!started && (statusVal === PROCESSING_STATUS.IN_PROCESS || statusVal === PROCESSING_STATUS.COMPLETED)) {
                    procRec.setValue({ fieldId: 'custrecord_sust_processing_start_date', value: new Date() });
                }
                if (!ended && statusVal === PROCESSING_STATUS.COMPLETED) {
                    procRec.setValue({ fieldId: 'custrecord_sust_processing_end_date', value: new Date() });
                }
            } catch (e) {
                log.debug('stampTimes skipped', e.message);
            }
        }

        const generateProcessingNumber = () => {
            const now = new Date();
            const yy = String(now.getFullYear()).slice(-2);
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const dd = String(now.getDate()).padStart(2, '0');
            const datePrefix = `PROC-${yy}${mm}${dd}`;

            // Search for existing records with the same date prefix
            const existingRecords = search.create({
                type: 'customrecord_sust_processing_record',
                filters: [
                    ['name', 'startswith', datePrefix]
                ],
                columns: ['name']
            });

            let maxSequence = 0;
            existingRecords.run().each(result => {
                const name = result.getValue('name');
                const parts = name.split('-');
                if (parts.length === 3) {
                    const seq = parseInt(parts[2], 10);
                    if (!isNaN(seq) && seq > maxSequence) {
                        maxSequence = seq;
                    }
                }
                return true;
            });

            const nextSequence = maxSequence + 1;
            return `${datePrefix}-${String(nextSequence).padStart(3, '0')}`;
        };

        /**
         * Pre-populate processing form fields from an Item Receipt
         * @param {Form} form
         * @param {string|number} itemReceiptId
         */
        const prePopulateFromItemReceipt = (form, itemReceiptId, targetLineKey) => {
            try {
                log.debug('prePopulateFromItemReceipt', `Loading Item Receipt ${itemReceiptId}`);

                const itemReceipt = record.load({
                    type: record.Type.ITEM_RECEIPT,
                    id: itemReceiptId,
                    isDynamic: false
                });

                const lineCount = itemReceipt.getLineCount({ sublistId: 'item' });
                if (lineCount === 0) {
                    log.debug('prePopulateFromItemReceipt', 'No item lines on Item Receipt');
                    return;
                }

                // Get first scrap item line data (or the line targeted by targetLineKey)
                let itemId = null;
                let locationId = null;
                let lotId = null;
                let quantity = 0;
                let sourceLineKey = null; // v2.3: IR line this processing record is scoped to

                for (let i = 0; i < lineCount; i++) {
                    const lineItemId = itemReceipt.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: i
                    });

                    // Check if item is scrap material
                    const isScrap = lookupItemField(lineItemId, 'custitem_sust_is_scrap_material');
                    if (isScrap !== true && isScrap !== 'T') continue;

                    // v2.3 line-level: when a target line key is supplied, only accept that line;
                    // otherwise take the first scrap line (legacy behavior). Capture the line key.
                    const lineKey = itemReceipt.getSublistValue({ sublistId: 'item', fieldId: 'lineuniquekey', line: i });
                    if (targetLineKey && String(lineKey) !== String(targetLineKey)) continue;
                    sourceLineKey = (lineKey !== null && lineKey !== '' && lineKey !== undefined) ? lineKey : (i + 1);

                    itemId = lineItemId;
                    locationId = itemReceipt.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'location',
                        line: i
                    });

                    // Get lot info from inventory detail
                    try {
                        const lineInventoryDetail = itemReceipt.getSublistSubrecord({
                            sublistId: 'item',
                            fieldId: 'inventorydetail',
                            line: i
                        });

                        if (lineInventoryDetail) {
                            const invLineCount = lineInventoryDetail.getLineCount({
                                sublistId: 'inventoryassignment'
                            });

                            if (invLineCount > 0) {
                                // Try existing lot first
                                lotId = lineInventoryDetail.getSublistValue({
                                    sublistId: 'inventoryassignment',
                                    fieldId: 'inventorynumber',
                                    line: 0
                                });

                                // If no existing lot, search by new lot number
                                if (!lotId) {
                                    const newLotNumber = lineInventoryDetail.getSublistValue({
                                        sublistId: 'inventoryassignment',
                                        fieldId: 'receiptinventorynumber',
                                        line: 0
                                    });
                                    if (newLotNumber) {
                                        lotId = findLotByNumber(newLotNumber);
                                    }
                                }

                                quantity = parseFloat(lineInventoryDetail.getSublistValue({
                                    sublistId: 'inventoryassignment',
                                    fieldId: 'quantity',
                                    line: 0
                                })) || 0;
                            }
                        }
                    } catch (detailError) {
                        log.debug('prePopulateFromItemReceipt', `No inventory detail for line ${i}: ${detailError.message}`);
                    }

                    // Found a scrap line, stop looking
                    if (itemId) break;
                }

                if (!itemId) {
                    log.debug('prePopulateFromItemReceipt', 'No scrap material lines found on Item Receipt');
                    return;
                }

                // Set Processing Type to "Separation"
                const separationId = findListValueId('customlist_sust_process_type', 'Separation');
                if (separationId) {
                    form.getField({ id: 'custpage_process_type' }).defaultValue = separationId;
                }

                // Set Location
                if (locationId) {
                    form.getField({ id: 'custpage_location' }).defaultValue = locationId;
                }

                // Set Input Item
                form.getField({ id: 'custpage_input_item' }).defaultValue = itemId;

                // Set Input Lot
                if (lotId) {
                    form.getField({ id: 'custpage_input_lot' }).defaultValue = lotId;
                }

                // Set Input Weight — IR inventory-detail quantity is stored in POUNDS;
                // the form field is entered/displayed in TONS
                if (quantity > 0) {
                    form.getField({ id: 'custpage_input_weight' }).defaultValue = units.toTons(quantity);
                }

                // Set Source Transaction to the Item Receipt
                form.getField({ id: 'custpage_po' }).defaultValue = itemReceiptId;

                // Add hidden field for Item Receipt ID reference
                const hiddenIR = form.addField({
                    id: 'custpage_item_receipt_id',
                    type: serverWidget.FieldType.TEXT,
                    label: 'Item Receipt ID'
                });
                hiddenIR.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
                hiddenIR.defaultValue = itemReceiptId;

                // v2.3: carry the source IR line key through POST so the processing record is line-scoped
                if (sourceLineKey !== null) {
                    const hiddenLine = form.addField({
                        id: 'custpage_source_line',
                        type: serverWidget.FieldType.TEXT,
                        label: 'Source Line Key'
                    });
                    hiddenLine.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
                    hiddenLine.defaultValue = String(sourceLineKey);
                }

                log.audit('prePopulateFromItemReceipt', {
                    itemReceiptId: itemReceiptId,
                    itemId: itemId,
                    locationId: locationId,
                    lotId: lotId,
                    quantity: quantity
                });

            } catch (e) {
                log.error('prePopulateFromItemReceipt', {
                    error: e.message,
                    stack: e.stack,
                    itemReceiptId: itemReceiptId
                });
            }
        };

        /**
         * Look up an item field value
         * @param {number} itemId
         * @param {string} fieldId
         * @returns {*}
         */
        const lookupItemField = (itemId, fieldId) => {
            try {
                const fields = search.lookupFields({
                    type: search.Type.ITEM,
                    id: itemId,
                    columns: [fieldId]
                });
                return fields[fieldId];
            } catch (e) {
                return null;
            }
        };

        /**
         * Find lot internal ID by lot number string
         * @param {string} lotNumber
         * @returns {number|null}
         */
        const findLotByNumber = (lotNumber) => {
            try {
                const lotSearch = search.create({
                    type: 'inventorynumber',
                    filters: [['inventorynumber', 'is', lotNumber]],
                    columns: ['internalid']
                });
                const results = lotSearch.run().getRange({ start: 0, end: 1 });
                if (results.length > 0) {
                    return parseInt(results[0].id, 10);
                }
            } catch (e) {
                log.error('findLotByNumber', e.message);
            }
            return null;
        };

        /**
         * Find a custom list value ID by text
         * @param {string} listScriptId
         * @param {string} valueText
         * @returns {string|null}
         */
        const findListValueId = (listScriptId, valueText) => {
            try {
                const listSearch = search.create({
                    type: listScriptId,
                    filters: [['name', 'is', valueText]],
                    columns: ['internalid']
                });
                const results = listSearch.run().getRange({ start: 0, end: 1 });
                if (results.length > 0) {
                    return results[0].id;
                }
            } catch (e) {
                log.error('findListValueId', `Error searching ${listScriptId} for "${valueText}": ${e.message}`);
            }
            return null;
        };

        return {
            onRequest
        };
    });
