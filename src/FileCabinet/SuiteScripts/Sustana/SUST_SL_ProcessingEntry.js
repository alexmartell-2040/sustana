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
                label: 'Costing & Equipment'
            });
            form.addFieldGroup({
                id: 'custpage_scale_group',
                label: 'Scale Reconciliation (optional)'
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
            inputItemField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN }); // input entry moved to the Materials grid

            // Input Lot
            const inputLotField = form.addField({
                id: 'custpage_input_lot',
                type: serverWidget.FieldType.SELECT,
                label: 'Input Lot',
                source: 'inventorynumber',
                container: 'custpage_input_group'
            });
            inputLotField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN }); // input entry moved to the Materials grid

            // Input Weight — entered in TONS (stored on the record in lbs; converted on POST)
            const inputWeightField = form.addField({
                id: 'custpage_input_weight',
                type: serverWidget.FieldType.FLOAT,
                label: 'Input Weight (tons)',
                container: 'custpage_input_group'
            });
            inputWeightField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN }); // input entry moved to the Materials grid

            // v2: Gross Input (full weight before tare) — entered in TONS
            const grossInputField = form.addField({
                id: 'custpage_gross_input',
                type: serverWidget.FieldType.FLOAT,
                label: 'Gross Input (tons)',
                container: 'custpage_scale_group'
            });

            // v2: Tare Estimate (from receiver lot at receipt time) — entered in TONS
            const tareEstField = form.addField({
                id: 'custpage_tare_estimate',
                type: serverWidget.FieldType.FLOAT,
                label: 'Tare Estimate (tons)',
                container: 'custpage_scale_group'
            });

            // v2: Tare Actual (measured at processing) — entered in TONS
            const tareActualField = form.addField({
                id: 'custpage_tare_actual',
                type: serverWidget.FieldType.FLOAT,
                label: 'Tare Actual (tons)',
                container: 'custpage_scale_group'
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
            // ==================== ADDITIONAL INPUTS (multi-input) ====================
            // The header Input Item/Lot/Weight is the PRIMARY input; these lines add
            // more grades consumed into the same run (e.g. 30t WL + 15t MP + 10t SOP).
            // ==================== NOTES SECTION ====================
            const notesField = form.addField({
                id: 'custpage_notes',
                type: serverWidget.FieldType.TEXTAREA,
                label: 'Processing Notes'
            });

            // ==================== BUTTONS ====================
            form.addSubmitButton({ label: 'Save Processing Record' });

            // ==================== LOAD EXISTING DATA ====================
            if (isEdit) {
                loadExistingProcessing(form, processingId);
            }

            // ==================== PRE-POPULATE FROM ITEM RECEIPT ====================
            const itemReceiptId = context.request.parameters.itemreceiptid;
            let irSeedRow = null;
            if (itemReceiptId && !isEdit) {
                // v2.3: optional ?line=<lineuniquekey> targets a specific IR scrap line
                irSeedRow = prePopulateFromItemReceipt(form, itemReceiptId, context.request.parameters.line);
            }

            // ==================== MATERIALS UI (Inbound / Outbound panels) ====================
            renderMaterialsUI(form, processingId, irSeedRow);

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

                // Materials rows are rendered by renderMaterialsUI (reads the record directly)

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
        /**
         * Existing materials rows for the UI: primary input (header fields) +
         * additional input lines + output lines. Tons for display.
         * @returns {Object} { inputs: [{item,lot,tons}], outputs: [{item,tons,outLot}] }
         */
        const collectExistingRows = (processingId) => {
            const out = { inputs: [], outputs: [] };
            try {
                const procRec = record.load({ type: 'customrecord_sust_processing_record', id: processingId });
                const primItem = procRec.getValue('custrecord_sust_processing_input_item');
                const primLot = procRec.getValue('custrecord_sust_processing_input_lot');
                const totalLbs = parseFloat(procRec.getValue('custrecord_sust_processing_input_lbs')) || 0;

                const extraInputs = [];
                search.create({
                    type: 'customrecord_sust_proc_input_line',
                    filters: [['custrecord_sust_pil_processing', 'anyof', processingId]],
                    columns: ['custrecord_sust_pil_item', 'custrecord_sust_pil_lot', 'custrecord_sust_pil_qty_consumed']
                }).run().each(result => {
                    extraInputs.push({
                        item: result.getValue('custrecord_sust_pil_item'),
                        lot: result.getValue('custrecord_sust_pil_lot') || '',
                        tons: units.toTons(parseFloat(result.getValue('custrecord_sust_pil_qty_consumed')) || 0)
                    });
                    return true;
                });
                const extraLbs = extraInputs.reduce(function(acc, r) { return acc + units.toLbs(r.tons); }, 0);
                const primLbs = Math.max(totalLbs - extraLbs, 0);
                if (primItem && primLbs > 0) {
                    out.inputs.push({ item: String(primItem), lot: primLot ? String(primLot) : '', tons: units.toTons(primLbs) });
                }
                extraInputs.forEach(function(r) {
                    out.inputs.push({ item: String(r.item), lot: r.lot ? String(r.lot) : '', tons: r.tons });
                });

                search.create({
                    type: 'customrecord_sust_processing_output_line',
                    filters: [['custrecord_sust_output_processing', 'anyof', processingId]],
                    columns: ['custrecord_sust_output_item', 'custrecord_sust_output_weight', 'custrecord_sust_output_lot']
                }).run().each(result => {
                    out.outputs.push({
                        item: String(result.getValue('custrecord_sust_output_item')),
                        tons: units.toTons(parseFloat(result.getValue('custrecord_sust_output_weight')) || 0),
                        outLot: result.getValue('custrecord_sust_output_lot') || ''
                    });
                    return true;
                });
            } catch (e) {
                log.error('collectExistingRows', e.message);
            }
            return out;
        };

        /**
         * Materials UI — Inbound / Outbound panels rendered as custom HTML.
         * State lives in JS and syncs to the hidden custpage_materials_json
         * field on every change; POST parses that JSON (parseMaterialLines).
         */
        const renderMaterialsUI = (form, processingId, irSeedRow) => {
            // Data for the pickers
            const items = [];
            try {
                search.create({
                    type: 'item',
                    filters: [['type', 'anyof', 'InvtPart', 'Assembly'], 'AND', ['isinactive', 'is', 'F']],
                    columns: ['itemid']
                }).run().each(function(r) {
                    items.push({ id: String(r.id), name: r.getValue('itemid') || ('Item ' + r.id) });
                    return true;
                });
            } catch (e) { log.error('renderMaterialsUI items', e.message); }
            items.sort(function(a, b) { return a.name < b.name ? -1 : 1; });

            const lots = [];
            try {
                search.create({
                    type: 'inventorynumber',
                    filters: [['quantityonhand', 'greaterthan', 0]],
                    columns: ['inventorynumber', 'item', 'quantityonhand']
                }).run().each(function(r) {
                    lots.push({
                        id: String(r.id),
                        number: r.getValue('inventorynumber'),
                        item: String(r.getValue('item')),
                        tons: Math.round(units.toTons(parseFloat(r.getValue('quantityonhand')) || 0) * 100) / 100
                    });
                    return true;
                });
            } catch (e) { log.error('renderMaterialsUI lots', e.message); }

            const templates = {};
            try {
                search.create({
                    type: 'customrecord_sust_item_output_template',
                    filters: [['custrecord_sust_template_active', 'is', 'T']],
                    columns: ['custrecord_sust_template_input_item', 'custrecord_sust_template_output_item',
                        'custrecord_sust_template_default_pct', 'custrecord_sust_template_sequence']
                }).run().each(function(r) {
                    const inItem = String(r.getValue('custrecord_sust_template_input_item'));
                    if (!templates[inItem]) templates[inItem] = [];
                    templates[inItem].push({
                        item: String(r.getValue('custrecord_sust_template_output_item')),
                        pct: parseFloat(r.getValue('custrecord_sust_template_default_pct')) || 0,
                        seq: parseFloat(r.getValue('custrecord_sust_template_sequence')) || 0
                    });
                    return true;
                });
                Object.keys(templates).forEach(function(k) {
                    templates[k].sort(function(a, b) { return a.seq - b.seq; });
                });
            } catch (e) { log.error('renderMaterialsUI templates', e.message); }

            // Initial rows
            let initial = { inputs: [], outputs: [] };
            if (processingId) {
                initial = collectExistingRows(processingId);
            } else if (irSeedRow && irSeedRow.item) {
                initial.inputs.push(irSeedRow);
            }
            if (initial.inputs.length === 0) initial.inputs.push({ item: '', lot: '', tons: '' });
            if (initial.outputs.length === 0) initial.outputs.push({ item: '', tons: '' });

            // Hidden JSON carrier
            const jsonField = form.addField({
                id: 'custpage_materials_json',
                type: serverWidget.FieldType.LONGTEXT,
                label: 'Materials JSON'
            });
            jsonField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            jsonField.defaultValue = JSON.stringify(initial);

            const boot = {
                items: items, lots: lots, templates: templates, initial: initial
            };

            const html = ''
+ '<div id="sustmat"></div>'
+ '<script>(function(){'
+ 'var D=' + JSON.stringify(boot) + ';'
+ 'var st={inputs:D.initial.inputs.slice(),outputs:D.initial.outputs.slice()};'
+ 'function hid(){var els=document.getElementsByName("custpage_materials_json");return els.length?els[0]:null;}'
+ 'function sync(){var h=hid();if(h){h.value=JSON.stringify({'
+ 'inputs:st.inputs.filter(function(r){return r.item&&parseFloat(r.tons)>0;}),'
+ 'outputs:st.outputs.filter(function(r){return r.item&&parseFloat(r.tons)>0;})});}}'
+ 'function tot(a){var t=0;a.forEach(function(r){t+=parseFloat(r.tons)||0;});return t;}'
+ 'function fmt(n){return (Math.round(n*100)/100).toLocaleString();}'
+ 'function itemOpts(sel){var o="<option value=\"\"></option>";D.items.forEach(function(it){o+="<option value=\""+it.id+"\""+(String(sel)===it.id?" selected":"")+">"+it.name+"</option>";});return o;}'
+ 'function lotOpts(item,sel){var o="<option value=\"\"></option>";D.lots.forEach(function(l){if(item&&l.item!==String(item))return;o+="<option value=\""+l.id+"\""+(String(sel)===l.id?" selected":"")+">"+l.number+" ("+l.tons+" t)</option>";});return o;}'
+ 'var S={panel:"border:1px solid #cbd5e1;border-radius:8px;margin:10px 0;overflow:hidden;font-family:Arial,sans-serif;",'
+ 'headI:"background:#eaf2ff;border-left:5px solid #2976F3;padding:10px 14px;font-weight:bold;color:#0d2a52;font-size:14px;display:flex;justify-content:space-between;align-items:center;",'
+ 'headO:"background:#fff7ed;border-left:5px solid #ea580c;padding:10px 14px;font-weight:bold;color:#7c2d12;font-size:14px;display:flex;justify-content:space-between;align-items:center;",'
+ 'th:"text-align:left;padding:6px 12px;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;",'
+ 'td:"padding:5px 12px;",'
+ 'inp:"width:110px;padding:5px 8px;border:1px solid #cbd5e1;border-radius:4px;font-size:13px;",'
+ 'sel:"min-width:220px;padding:5px 8px;border:1px solid #cbd5e1;border-radius:4px;font-size:13px;",'
+ 'x:"color:#dc2626;cursor:pointer;font-weight:bold;text-decoration:none;font-size:15px;",'
+ 'add:"display:inline-block;margin:8px 12px 12px;padding:6px 14px;background:#fff;border:1px solid #2976F3;color:#2976F3;border-radius:4px;cursor:pointer;font-weight:600;font-size:12px;",'
+ 'btn:"margin-left:8px;padding:5px 12px;background:#fff;border:1px solid #ea580c;color:#ea580c;border-radius:4px;cursor:pointer;font-weight:600;font-size:12px;"};'
+ 'function render(){var tin=tot(st.inputs),tout=tot(st.outputs),loss=tin-tout,yld=tin>0?(tout/tin*100):0;'
+ 'var h="";'
+ 'h+="<div style=\""+S.panel+"\">";'
+ 'h+="<div style=\""+S.headI+"\"><span>&#11015;&#65039; Inbound &mdash; Materials Consumed</span><span>"+fmt(tin)+" tons in</span></div>";'
+ 'h+="<table style=\"width:100%;border-collapse:collapse;\"><tr><th style=\""+S.th+"\">Grade</th><th style=\""+S.th+"\">Lot</th><th style=\""+S.th+"\">Weight (tons)</th><th style=\""+S.th+"\">% of Input</th><th></th></tr>";'
+ 'st.inputs.forEach(function(r,i){var pct=tin>0?((parseFloat(r.tons)||0)/tin*100):0;'
+ 'h+="<tr style=\"border-top:1px solid #e5e7eb;\">";'
+ 'h+="<td style=\""+S.td+"\"><select style=\""+S.sel+"\" onchange=\"SUSTMAT.setIn("+i+",&quot;item&quot;,this.value)\">"+itemOpts(r.item)+"</select></td>";'
+ 'h+="<td style=\""+S.td+"\"><select style=\""+S.sel+"\" onchange=\"SUSTMAT.setIn("+i+",&quot;lot&quot;,this.value)\">"+lotOpts(r.item,r.lot)+"</select></td>";'
+ 'h+="<td style=\""+S.td+"\"><input type=\"number\" step=\"0.01\" min=\"0\" style=\""+S.inp+"\" value=\""+(r.tons||"")+"\" onchange=\"SUSTMAT.setIn("+i+",&quot;tons&quot;,this.value)\"/></td>";'
+ 'h+="<td style=\""+S.td+"color:#64748b;\">"+(r.tons?pct.toFixed(1)+"%":"&mdash;")+"</td>";'
+ 'h+="<td style=\""+S.td+"\"><a style=\""+S.x+"\" onclick=\"SUSTMAT.delIn("+i+")\">&#10005;</a></td></tr>";});'
+ 'h+="</table><a style=\""+S.add+"\" onclick=\"SUSTMAT.addIn()\">+ Add Input</a></div>";'
+ 'h+="<div style=\""+S.panel+"\">";'
+ 'h+="<div style=\""+S.headO+"\"><span>&#11014;&#65039; Outbound &mdash; Materials Produced</span><span>"'
+ '+"<button type=\"button\" style=\""+S.btn+"\" onclick=\"SUSTMAT.loadDefaults()\">Load Default Outputs</button>"'
+ '+"<button type=\"button\" style=\""+S.btn+"\" onclick=\"SUSTMAT.clearOut()\">Clear</button>"'
+ '+"<span style=\"margin-left:12px;\">"+fmt(tout)+" tons out</span></span></div>";'
+ 'h+="<table style=\"width:100%;border-collapse:collapse;\"><tr><th style=\""+S.th+"\">Grade</th><th style=\""+S.th+"\">Weight (tons)</th><th style=\""+S.th+"\">% of Input</th><th style=\""+S.th+"\">Output Lot</th><th></th></tr>";'
+ 'st.outputs.forEach(function(r,i){var pct=tin>0?((parseFloat(r.tons)||0)/tin*100):0;'
+ 'h+="<tr style=\"border-top:1px solid #e5e7eb;\">";'
+ 'h+="<td style=\""+S.td+"\"><select style=\""+S.sel+"\" onchange=\"SUSTMAT.setOut("+i+",&quot;item&quot;,this.value)\">"+itemOpts(r.item)+"</select></td>";'
+ 'h+="<td style=\""+S.td+"\"><input type=\"number\" step=\"0.01\" min=\"0\" style=\""+S.inp+"\" value=\""+(r.tons||"")+"\" onchange=\"SUSTMAT.setOut("+i+",&quot;tons&quot;,this.value)\"/></td>";'
+ 'h+="<td style=\""+S.td+"color:#64748b;\">"+(r.tons?pct.toFixed(1)+"%":"&mdash;")+"</td>";'
+ 'h+="<td style=\""+S.td+"color:#94a3b8;\">"+(r.outLot||"(auto on completion)")+"</td>";'
+ 'h+="<td style=\""+S.td+"\"><a style=\""+S.x+"\" onclick=\"SUSTMAT.delOut("+i+")\">&#10005;</a></td></tr>";});'
+ 'h+="</table><a style=\""+S.add+"border-color:#ea580c;color:#ea580c;\" onclick=\"SUSTMAT.addOut()\">+ Add Output</a></div>";'
+ 'var over=tout>tin&&tin>0;'
+ 'h+="<div style=\"display:flex;gap:18px;align-items:center;border:1px solid #cbd5e1;border-radius:8px;padding:10px 16px;font-family:Arial,sans-serif;font-size:13px;"+(over?"background:#fef2f2;border-color:#dc2626;":"background:#f8fafc;")+"\">";'
+ 'h+="<b>Balance:</b><span>"+fmt(tin)+" in</span><span>&rarr;</span><span>"+fmt(tout)+" out</span>";'
+ 'h+="<span style=\"color:#64748b;\">Loss "+fmt(Math.max(loss,0))+" t (residual + moisture)</span>";'
+ 'h+="<span style=\"font-weight:bold;"+(over?"color:#dc2626;":"color:#0d2a52;")+"\">Yield "+(tin>0?yld.toFixed(1):"0")+"%"+(over?" &mdash; OUTPUT EXCEEDS INPUT":"")+"</span>";'
+ 'h+="<div style=\"flex:1;height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden;\"><div style=\"height:8px;width:"+Math.min(yld,100)+"%;background:"+(over?"#dc2626":"#2976F3")+";\"></div></div></div>";'
+ 'document.getElementById("sustmat").innerHTML=h;sync();}'
+ 'window.SUSTMAT={'
+ 'setIn:function(i,k,v){st.inputs[i][k]=v;if(k==="item")st.inputs[i].lot="";render();},'
+ 'setOut:function(i,k,v){st.outputs[i][k]=v;render();},'
+ 'addIn:function(){st.inputs.push({item:"",lot:"",tons:""});render();},'
+ 'addOut:function(){st.outputs.push({item:"",tons:""});render();},'
+ 'delIn:function(i){st.inputs.splice(i,1);if(!st.inputs.length)st.inputs.push({item:"",lot:"",tons:""});render();},'
+ 'delOut:function(i){st.outputs.splice(i,1);if(!st.outputs.length)st.outputs.push({item:"",tons:""});render();},'
+ 'clearOut:function(){st.outputs=[{item:"",tons:""}];render();},'
+ 'loadDefaults:function(){var first=null;for(var i=0;i<st.inputs.length;i++){if(st.inputs[i].item){first=st.inputs[i];break;}}'
+ 'if(!first){alert("Add an Inbound row first (grade, lot, weight).");return;}'
+ 'var tpl=D.templates[String(first.item)];'
+ 'if(!tpl||!tpl.length){alert("No output templates configured for this input grade. Add outputs manually.");return;}'
+ 'var tin=tot(st.inputs);st.outputs=tpl.map(function(t){return {item:t.item,tons:(tin*t.pct/100).toFixed(2)};});render();}'
+ '};'
+ 'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",render);}else{render();}'
+ '})();</script>';

            const uiField = form.addField({
                id: 'custpage_materials_ui',
                type: serverWidget.FieldType.INLINEHTML,
                label: ' '
            });
            uiField.defaultValue = html;
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

                // Parse the Materials grid — form weights arrive in TONS; convert
                // to POUNDS with units.toLbs() BEFORE any record write.
                const matRows = parseMaterialLines(context.request);
                const inputRows = matRows.filter(function(r) { return r.direction === 'input'; });
                const outputRows = matRows.filter(function(r) { return r.direction === 'output'; });
                if (inputRows.length === 0 && params.custpage_input_item && params.custpage_input_weight) {
                    // Legacy fallback: hidden header fields carry the input
                    inputRows.push({
                        itemId: params.custpage_input_item,
                        lotId: params.custpage_input_lot,
                        weightLbs: units.toLbs(params.custpage_input_weight)
                    });
                }
                if (inputRows.length === 0) {
                    throw new Error('Add at least one Input row on the Materials grid.');
                }
                const inputWeightLbs = inputRows.reduce(function(acc, r) { return acc + r.weightLbs; }, 0);
                // Primary input = first input row (downstream links: settlement, flow-back, IA)
                procRec.setValue({ fieldId: 'custrecord_sust_processing_input_item', value: inputRows[0].itemId });
                if (inputRows[0].lotId) {
                    procRec.setValue({ fieldId: 'custrecord_sust_processing_input_lot', value: inputRows[0].lotId });
                }
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

                // Save output + non-primary input lines (weights in POUNDS)
                saveOutputLines(processingId, outputRows, inputWeightLbs);
                saveInputLines(processingId, inputRows.slice(1), inputWeightLbs);

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
        /**
         * Output Type derives from the item (no user entry): Byproduct-class
         * items (Mill Residuals) -> Residual, everything else -> Fiber.
         */
        const _outputTypeCache = {};
        const deriveOutputTypeId = (itemId) => {
            if (_outputTypeCache[itemId] !== undefined) return _outputTypeCache[itemId];
            let text = 'Fiber';
            try {
                const lk = search.lookupFields({
                    type: search.Type.ITEM, id: itemId,
                    columns: ['itemid', 'custitem_sust_cost_alloc_class']
                });
                const alloc = Array.isArray(lk.custitem_sust_cost_alloc_class) && lk.custitem_sust_cost_alloc_class.length
                    ? lk.custitem_sust_cost_alloc_class[0].text : '';
                const name = lk.itemid || '';
                if (alloc === 'Byproduct' || /residual/i.test(name)) text = 'Residual';
            } catch (e) { log.debug('deriveOutputTypeId', e.message); }
            _outputTypeCache[itemId] = findListValueId('customlist_sust_output_type', text);
            return _outputTypeCache[itemId];
        };

        /**
         * Parse the Materials UI's hidden JSON into row objects.
         * Schema: {"inputs":[{"item","lot","tons"}],"outputs":[{"item","tons"}]}
         * @returns {Array} [{ direction, itemId, lotId, typeId, weightLbs, disposition }]
         */
        const parseMaterialLines = (request) => {
            const rows = [];
            let data = { inputs: [], outputs: [] };
            try {
                data = JSON.parse(request.parameters.custpage_materials_json || '{}') || {};
            } catch (e) {
                log.error('parseMaterialLines', 'Bad materials JSON: ' + e.message);
            }
            (data.inputs || []).forEach(function(r) {
                if (!r.item || !(parseFloat(r.tons) > 0)) return;
                rows.push({
                    direction: 'input',
                    itemId: String(r.item),
                    lotId: r.lot ? String(r.lot) : null,
                    typeId: null,
                    weightLbs: units.toLbs(r.tons),
                    disposition: null
                });
            });
            (data.outputs || []).forEach(function(r) {
                if (!r.item || !(parseFloat(r.tons) > 0)) return;
                rows.push({
                    direction: 'output',
                    itemId: String(r.item),
                    lotId: null,
                    typeId: deriveOutputTypeId(String(r.item)),
                    weightLbs: units.toLbs(r.tons),
                    disposition: null
                });
            });
            return rows;
        };

        /**
         * Persist non-primary input rows as customrecord_sust_proc_input_line
         * children. Delete-and-recreate, matching the output-line pattern.
         */
        const saveInputLines = (processingId, inputRows, totalInputLbs) => {
            search.create({
                type: 'customrecord_sust_proc_input_line',
                filters: [['custrecord_sust_pil_processing', 'anyof', processingId]],
                columns: ['internalid']
            }).run().each(result => {
                try {
                    record.delete({ type: 'customrecord_sust_proc_input_line', id: result.id });
                } catch (e) {
                    log.error('saveInputLines', 'Error deleting existing line: ' + e.message);
                }
                return true;
            });

            (inputRows || []).forEach(function(row, i) {
                try {
                    const line = record.create({ type: 'customrecord_sust_proc_input_line' });
                    line.setValue({ fieldId: 'custrecord_sust_pil_processing', value: processingId });
                    line.setValue({ fieldId: 'custrecord_sust_pil_line_number', value: i + 2 }); // primary is line 1
                    line.setValue({ fieldId: 'custrecord_sust_pil_item', value: row.itemId });
                    if (row.lotId) line.setValue({ fieldId: 'custrecord_sust_pil_lot', value: row.lotId });
                    line.setValue({ fieldId: 'custrecord_sust_pil_qty_consumed', value: row.weightLbs });
                    if (totalInputLbs > 0) {
                        line.setValue({ fieldId: 'custrecord_sust_pil_weight_pct', value: (row.weightLbs / totalInputLbs) * 100 });
                    }
                    const lineId = line.save();
                    log.audit('saveInputLines', 'Created input line: ' + lineId);
                } catch (e) {
                    log.error('saveInputLines', { error: e.message, line: i });
                }
            });
        };

        const saveOutputLines = (processingId, outputRows, inputWeightLbs) => {
            // Delete existing output lines
            search.create({
                type: 'customrecord_sust_processing_output_line',
                filters: [['custrecord_sust_output_processing', 'anyof', processingId]],
                columns: ['internalid']
            }).run().each(result => {
                try {
                    record.delete({ type: 'customrecord_sust_processing_output_line', id: result.id });
                } catch (e) {
                    log.error('saveOutputLines', 'Error deleting existing line: ' + e.message);
                }
                return true;
            });

            (outputRows || []).forEach(function(row, i) {
                if (!row.itemId || !row.weightLbs) return;
                try {
                    const outputLine = record.create({ type: 'customrecord_sust_processing_output_line' });
                    outputLine.setValue({ fieldId: 'custrecord_sust_output_processing', value: processingId });
                    outputLine.setValue({ fieldId: 'custrecord_sust_output_line_number', value: i + 1 });
                    outputLine.setValue({ fieldId: 'custrecord_sust_output_item', value: row.itemId });
                    if (row.typeId) outputLine.setValue({ fieldId: 'custrecord_sust_output_type', value: row.typeId });
                    outputLine.setValue({ fieldId: 'custrecord_sust_output_weight', value: row.weightLbs });
                    if (inputWeightLbs > 0) {
                        outputLine.setValue({ fieldId: 'custrecord_sust_output_percentage', value: (row.weightLbs / inputWeightLbs) * 100 });
                    }
                    if (row.disposition) {
                        outputLine.setValue({ fieldId: 'custrecord_sust_output_disposition', value: row.disposition });
                    }
                    const lineId = outputLine.save();
                    log.audit('saveOutputLines', 'Created output line: ' + lineId);
                } catch (e) {
                    log.error('saveOutputLines', { error: e.message, line: i });
                }
            });
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

                return {
                    item: String(itemId),
                    lot: lotId ? String(lotId) : '',
                    tons: quantity > 0 ? units.toTons(quantity) : 0
                };

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
