/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 * @description User Event for Processing Record - Automatically creates Inventory Adjustment when status is set to Completed
 */
define(['N/record', 'N/search', 'N/runtime', 'N/log', './SUST_Lib_CostAllocation', './SUST_Lib_Config'],
    (record, search, runtime, log, costAllocation, configLib) => {

        const PROCESSING_STATUS = {
            DRAFT: '1',
            IN_PROCESS: '2',
            COMPLETED: '3'
        };

        // v2.2: status text values (compared via getText since custom list internal IDs vary)
        const STATUS_TEXT = {
            COMPLETED: 'Completed',
            AWAITING_COST: 'Awaiting Cost'
        };

        /**
         * After Submit event handler
         * @param {Object} context
         * @param {Record} context.newRecord
         * @param {Record} context.oldRecord
         * @param {string} context.type
         */
        const afterSubmit = (context) => {
            // Only process on create or edit
            if (context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT) {
                return;
            }

            try {
                const newRecord = context.newRecord;
                const oldRecord = context.oldRecord;

                const newStatusText = (newRecord.getText({ fieldId: 'custrecord_sust_processing_status' }) || '').trim();
                const oldStatusText = oldRecord ? (oldRecord.getText({ fieldId: 'custrecord_sust_processing_status' }) || '').trim() : '';

                log.debug('afterSubmit', {
                    contextType: context.type,
                    newStatus: newStatusText,
                    oldStatus: oldStatusText
                });

                // v2.2: act only when status is Completed and was not already Completed
                if (newStatusText !== STATUS_TEXT.COMPLETED) {
                    log.debug('afterSubmit', `Status "${newStatusText}" is not Completed — skipping IA creation`);
                    return;
                }
                if (oldStatusText === STATUS_TEXT.COMPLETED) {
                    log.debug('afterSubmit', 'Status was already Completed — skipping IA creation');
                    return;
                }

                // Check if inventory adjustment already exists
                const existingAdj = newRecord.getValue({ fieldId: 'custrecord_sust_processing_work_order' });
                if (existingAdj) {
                    log.debug('afterSubmit', 'Inventory Adjustment already exists: ' + existingAdj);
                    return;
                }

                // v2.2: detect deferred-pricing path — Total Input Cost = 0 means we cannot
                // create an IA with proper allocated costs yet. Defer to settlement close.
                // EXCEPTION: Brokered and Repackage paths skip IA entirely (handled later).
                // v2.3-E note: the input scrap may now carry a PROVISIONAL value at receipt (the PO
                // estimate) so it isn't on the books at $0. That provisional value lives on the lot,
                // independent of this record's Total Input Cost. We still defer when Total Input Cost
                // is 0 so the deferred IA (fired post-settlement) allocates the SETTLED value, not the
                // provisional one. The bill revalues the scrap to the settled value before the IA fires,
                // keeping the adjustment value-neutral (see V2.3_PLAN chunk F).
                const totalInputCostCheck = parseFloat(
                    newRecord.getValue({ fieldId: 'custrecord_sust_proc_total_input_cost' })
                ) || 0;
                const sourceTypeCheck = (newRecord.getText({ fieldId: 'custrecord_sust_proc_source_type' }) || '').trim();
                const skipsIA = sourceTypeCheck.indexOf('Brokered') !== -1 || sourceTypeCheck.indexOf('Repackage') !== -1;

                if (totalInputCostCheck === 0 && !skipsIA) {
                    // Deferred-pricing case: hold the record in "Awaiting Cost" state.
                    // The settlement flow-back will transition it back to Completed once cost is known.
                    log.audit('afterSubmit — Deferred IA',
                        `Processing ${newRecord.id}: Total Input Cost = $0 and not Brokered/Repackage. ` +
                        `Setting status to "Awaiting Cost" — IA will be created when settlement closes and cost flows back.`);
                    try {
                        record.submitFields({
                            type: 'customrecord_sust_processing_record',
                            id: newRecord.id,
                            values: {
                                custrecord_sust_processing_status: getStatusInternalId(STATUS_TEXT.AWAITING_COST),
                                custrecord_sust_proc_ia_pending: true
                            },
                            options: { enableSourcing: false, ignoreMandatoryFields: true }
                        });
                    } catch (transitionErr) {
                        log.error('Status transition to Awaiting Cost failed', transitionErr.message);
                    }
                    // Still try to link the settlement (non-blocking) so flow-back can find this processing record
                    linkSettlementToProcessing(newRecord.id);
                    return;
                }

                // Standard path — Total Input Cost is known (Pattern 1/2) OR Brokered/Repackage
                // Create Inventory Adjustment
                const invAdjustmentId = createInventoryAdjustmentFromProcessing(newRecord.id);

                // v2: honor source-type sentinels for Brokered + Repackage paths
                if (invAdjustmentId === 'BROKERED_NO_IA' || invAdjustmentId === 'REPACKAGE_NO_IA') {
                    log.audit('afterSubmit',
                        `${invAdjustmentId}: skipping IA + output-lot processing for processing record ${newRecord.id}. Settlement (if any) still linked.`);
                    linkSettlementToProcessing(newRecord.id);
                    return;
                }

                if (invAdjustmentId) {
                    // Update processing record with inventory adjustment link + clear ia_pending flag
                    record.submitFields({
                        type: 'customrecord_sust_processing_record',
                        id: newRecord.id,
                        values: {
                            custrecord_sust_processing_work_order: invAdjustmentId,
                            custrecord_sust_proc_ia_pending: false
                        }
                    });

                    log.audit('afterSubmit', {
                        action: 'Inventory Adjustment Created',
                        processingId: newRecord.id,
                        invAdjustmentId: invAdjustmentId
                    });

                    // Process output lots (set lot defaults, create genealogy)
                    processOutputLots(invAdjustmentId, newRecord.id);

                    // Link settlement to processing record (non-blocking)
                    linkSettlementToProcessing(newRecord.id);
                }

            } catch (e) {
                log.error('afterSubmit', {
                    error: e.message,
                    stack: e.stack,
                    processingId: context.newRecord.id
                });
                // Don't throw - allow processing record to save even if inventory adjustment creation fails
            }
        };

        /**
         * v2.2: Look up the internal ID of a processing-status custom list value by its display text.
         * Custom list internal IDs vary by account, so we resolve at runtime via search.
         */
        const _statusIdCache = {};
        const getStatusInternalId = (statusText) => {
            if (_statusIdCache[statusText]) return _statusIdCache[statusText];
            try {
                const ss = search.create({
                    type: 'customlist_sust_processing_status',
                    filters: [['name', 'is', statusText]],
                    columns: ['internalid']
                });
                const results = ss.run().getRange({ start: 0, end: 1 });
                if (results.length > 0) {
                    _statusIdCache[statusText] = results[0].id;
                    return results[0].id;
                }
            } catch (e) {
                log.error('getStatusInternalId failed', `${statusText}: ${e.message}`);
            }
            return null;
        };

        /**
         * Create an Inventory Adjustment from a Processing Record
         * @param {string|number} processingId - Processing record internal ID
         * @returns {number|null} Inventory Adjustment internal ID or null on failure
         */
        const createInventoryAdjustmentFromProcessing = (processingId) => {
            log.audit('createInventoryAdjustmentFromProcessing', 'Starting inventory adjustment creation for processing record: ' + processingId);

            // Load processing record
            const procRec = record.load({
                type: 'customrecord_sust_processing_record',
                id: processingId
            });

            // v2: honor Source Type — skip IA for Brokered and Repackage modes
            const sourceTypeText = (procRec.getText({ fieldId: 'custrecord_sust_proc_source_type' }) || '').trim();
            if (sourceTypeText) {
                if (sourceTypeText.indexOf('Brokered') !== -1) {
                    log.audit('Skip IA — Brokered (Pass-Through)',
                        `Processing ${processingId}: source type is Brokered. No IA created — receiver lot remains as-is for direct sale (PROC-014).`);
                    return 'BROKERED_NO_IA';
                }
                if (sourceTypeText.indexOf('Repackage') !== -1) {
                    log.audit('Skip IA — Repackage',
                        `Processing ${processingId}: source type is Repackage. Same lot retained; no inventory movement (PROC-015). If item-code change is desired, update the receiver lot's item association via NetSuite native UI.`);
                    return 'REPACKAGE_NO_IA';
                }
                log.debug('Source Type', `Processing ${processingId}: source type "${sourceTypeText}" — proceeding with standard IA creation.`);
            }

            const inputItem = parseInt(procRec.getValue({ fieldId: 'custrecord_sust_processing_input_item' }), 10);
            const inputLot = parseInt(procRec.getValue({ fieldId: 'custrecord_sust_processing_input_lot' }), 10);
            const inputWeight = parseFloat(procRec.getValue({ fieldId: 'custrecord_sust_processing_input_lbs' }));
            const location = parseInt(procRec.getValue({ fieldId: 'custrecord_sust_processing_location' }), 10);
            const procDate = procRec.getValue({ fieldId: 'custrecord_sust_processing_date' });
            const procNumber = procRec.getValue({ fieldId: 'name' });

            // v2: total input cost for weight-proportional allocation across outputs
            const totalInputCost = parseFloat(procRec.getValue({ fieldId: 'custrecord_sust_proc_total_input_cost' })) || 0;

            log.debug('createInventoryAdjustmentFromProcessing', {
                inputItem: inputItem,
                inputLot: inputLot,
                inputWeight: inputWeight,
                location: location,
                procDate: procDate,
                procNumber: procNumber
            });

            if (!inputItem || !inputLot || !inputWeight) {
                log.error('createInventoryAdjustmentFromProcessing', 'Missing required input fields');
                return null;
            }

            if (!location) {
                log.error('createInventoryAdjustmentFromProcessing', 'Location is required for inventory adjustment');
                return null;
            }

            // Get output lines
            const outputLines = getOutputLines(processingId);

            log.debug('createInventoryAdjustmentFromProcessing', `Retrieved ${outputLines.length} output lines`);

            if (outputLines.length === 0) {
                log.error('createInventoryAdjustmentFromProcessing', 'No output lines found for processing record');
                return null;
            }

            // Resolve account + subsidiary BEFORE creating the IA.
            // Pattern: script parameter (when the deployment defines one) || Sustana Config
            // record — never a hardcoded internal id. When both are empty, log and skip.

            // Subsidiary: script parameter custscript_sust_sub_id_proc_ia || config
            const sustSubsidiaryId = runtime.getCurrentScript().getParameter({
                name: 'custscript_sust_sub_id_proc_ia'
            }) || configLib.get('usSubsidiary');
            if (!sustSubsidiaryId) {
                log.error('Config missing',
                    'Sustana subsidiary not configured — set script parameter custscript_sust_sub_id_proc_ia or the Sustana Config record (run SUST_SL_SeedSustanaDemo). Inventory Adjustment not created.');
                return null;
            }

            // Account: no script parameter exists for this deployment — Sustana Config only
            const acctId = configLib.get('invAdjAccount');
            if (!acctId) {
                log.error('Config missing',
                    'Inventory Adjustment account not configured — set the Sustana Config record (run SUST_SL_SeedSustanaDemo)');
                return null;
            }

            // Create Inventory Adjustment in standard mode (not dynamic) for lot-tracked items
            const invAdj = record.create({
                type: record.Type.INVENTORY_ADJUSTMENT,
                isDynamic: false
            });

            // Set header fields IN ORDER: trandate → subsidiary → adjlocation → account → memo
            log.debug('createInventoryAdjustmentFromProcessing', 'Setting header fields in sequence');

            // 1. Transaction Date
            invAdj.setValue({ fieldId: 'trandate', value: new Date() });
            log.debug('createInventoryAdjustmentFromProcessing', '✓ Set trandate');

            // 2. Subsidiary (MUST precede adjlocation)
            invAdj.setValue({ fieldId: 'subsidiary', value: parseInt(sustSubsidiaryId, 10) });
            log.debug('createInventoryAdjustmentFromProcessing', `✓ Set subsidiary to ${sustSubsidiaryId} (script param || config)`);

            // 3. Adjustment Location
            invAdj.setValue({ fieldId: 'adjlocation', value: location });
            log.debug('createInventoryAdjustmentFromProcessing', `✓ Set adjlocation to ${location}`);

            // 4. Account
            invAdj.setValue({ fieldId: 'account', value: parseInt(acctId, 10) });
            log.debug('createInventoryAdjustmentFromProcessing', `✓ Set account to ${acctId} (from config)`);

            // 5. Memo
            invAdj.setValue({ fieldId: 'memo', value: `Grade Transformation: ${procNumber}` });
            log.debug('createInventoryAdjustmentFromProcessing', `✓ Set memo`);

            // Link to processing record (if custom field exists)
            // Note: You may need to create custbody_sust_processing_record field
            // invAdj.setValue({ fieldId: 'custbody_sust_processing_record', value: processingId });

            log.debug('createInventoryAdjustmentFromProcessing', '✓ Completed all header fields');

            // Add input consumption line FIRST (negative quantity to consume existing lot)
            log.debug('createInventoryAdjustmentFromProcessing', `Adding input consumption line: item=${inputItem}, lot=${inputLot}, qty=-${inputWeight}`);

            try {
                invAdj.setSublistValue({ sublistId: 'inventory', fieldId: 'item', line: 0, value: inputItem });
                log.debug('createInventoryAdjustmentFromProcessing', `✓ Set input item ${inputItem} on line 0`);

                invAdj.setSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', line: 0, value: -inputWeight });
                log.debug('createInventoryAdjustmentFromProcessing', `✓ Set input adjustqtyby -${inputWeight} on line 0`);

                invAdj.setSublistValue({ sublistId: 'inventory', fieldId: 'location', line: 0, value: location });
                log.debug('createInventoryAdjustmentFromProcessing', `✓ Set input location ${location} on line 0`);

                // Set inventory detail for consuming lot
                const invDetailSubrecord = invAdj.getSublistSubrecord({
                    sublistId: 'inventory',
                    fieldId: 'inventorydetail',
                    line: 0
                });
                log.debug('createInventoryAdjustmentFromProcessing', `✓ Got input inventory detail subrecord`);

                if (invDetailSubrecord) {
                    invDetailSubrecord.setSublistValue({
                        sublistId: 'inventoryassignment',
                        fieldId: 'issueinventorynumber',
                        line: 0,
                        value: inputLot
                    });
                    log.debug('createInventoryAdjustmentFromProcessing', `✓ Set issue lot number ${inputLot}`);

                    // For consumption (negative adjustment), quantity should be negative
                    invDetailSubrecord.setSublistValue({
                        sublistId: 'inventoryassignment',
                        fieldId: 'quantity',
                        line: 0,
                        value: -Math.abs(inputWeight)
                    });
                    log.debug('createInventoryAdjustmentFromProcessing', `✓ Set inventory detail quantity -${inputWeight}`);
                }

                log.debug('createInventoryAdjustmentFromProcessing', '✓ Completed input consumption line 0');
            } catch (inputError) {
                log.error('createInventoryAdjustmentFromProcessing', {
                    error: '❌ Error processing input line',
                    message: inputError.message,
                    stack: inputError.stack
                });
                throw inputError;
            }

            // v2.1: GAAP-aware cost allocation via shared engine.
            // Mode defaults to Byproduct (Southern Copper / Horngren-recommended) when not set
            // on the processing record. See V2_GAAP_Inventory_Costing_Analysis.pdf.
            const allocModeText = (procRec.getText({ fieldId: 'custrecord_sust_processing_alloc_mode' }) || '').trim();
            const allocMode = allocModeText || costAllocation.MODE.BYPRODUCT;

            // Build engine input — output lines with item + lbs (+ optional context fields)
            const engineOutputLines = outputLines.map(function(ol) {
                return {
                    itemId: ol.itemId,
                    lbs: ol.weight,
                    // recoveryPct + marketSourceText: engine pulls from item if not set on line
                    _ref: ol  // keep reference back to the original line so we can map cost back
                };
            });

            const allocResult = costAllocation.allocateInputCost({
                inputCost: totalInputCost,
                outputLines: engineOutputLines,
                mode: allocMode
            });

            log.audit('Cost Allocation Result', costAllocation.formatAuditString(allocResult));

            // Map allocated cost back to the original output lines for use in the IA loop
            allocResult.outputLines.forEach(function(engineLine) {
                if (engineLine._ref) {
                    engineLine._ref.allocatedCost = engineLine.allocatedCost || 0;
                    engineLine._ref.classification = engineLine.classification;
                    engineLine._ref.nrvPerLb = engineLine.nrvPerLb;
                    engineLine._ref.nrvSource = engineLine.nrvSource;
                }
            });

            // Add output creation lines (positive quantities) AFTER input line
            log.debug('createInventoryAdjustmentFromProcessing', 'Adding output creation lines');
            outputLines.forEach((outputLine, index) => {
                const lineNum = index + 1; // Line 0 is input, output lines start at 1
                log.debug('createInventoryAdjustmentFromProcessing', `Processing output line ${lineNum}: item=${outputLine.itemId}, weight=${outputLine.weight}`);

                try {
                    invAdj.setSublistValue({ sublistId: 'inventory', fieldId: 'item', line: lineNum, value: outputLine.itemId });
                    log.debug('createInventoryAdjustmentFromProcessing', `✓ Set output item ${outputLine.itemId} on line ${lineNum}`);

                    invAdj.setSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', line: lineNum, value: outputLine.weight });
                    log.debug('createInventoryAdjustmentFromProcessing', `✓ Set output adjustqtyby ${outputLine.weight} on line ${lineNum}`);

                    invAdj.setSublistValue({ sublistId: 'inventory', fieldId: 'location', line: lineNum, value: location });
                    log.debug('createInventoryAdjustmentFromProcessing', `✓ Set output location ${location} on line ${lineNum}`);

                    // v2.1: Per-line allocated cost from the engine (Byproduct / Relative NRV / Weight)
                    const lineAllocatedCost = parseFloat(outputLine.allocatedCost) || 0;
                    const lineUnitCost = (outputLine.weight > 0) ? (lineAllocatedCost / outputLine.weight) : 0;
                    if (lineUnitCost > 0) {
                        try {
                            invAdj.setSublistValue({ sublistId: 'inventory', fieldId: 'unitcost', line: lineNum, value: lineUnitCost });
                            log.debug('createInventoryAdjustmentFromProcessing',
                                `✓ Set unitcost $${lineUnitCost.toFixed(4)}/lb on line ${lineNum} ` +
                                `[${outputLine.classification || 'Primary'}] (allocated $${lineAllocatedCost.toFixed(2)} via ${allocMode} mode, NRV source: ${outputLine.nrvSource || 'n/a'})`);
                        } catch (costErr) {
                            log.error('Unitcost set failed', `Line ${lineNum}: ${costErr.message}. Output created at $0 — cost flow back from settlement (Post-Processing mode) will reconcile.`);
                        }
                    } else {
                        log.debug('Cost = 0',
                            `Line ${lineNum} [${outputLine.classification || 'Primary'}]: allocated $0 via ${allocMode} mode. ` +
                            `Either total_input_cost is 0 (Post-Processing deferred-pricing) or this is a Byproduct with zero NRV. Settlement Completed will trigger cost flow-back.`);
                    }

                    // Set inventory detail for creating new lot
                    const invDetailSubrecord = invAdj.getSublistSubrecord({
                        sublistId: 'inventory',
                        fieldId: 'inventorydetail',
                        line: lineNum
                    });
                    log.debug('createInventoryAdjustmentFromProcessing', `✓ Got inventory detail subrecord for line ${lineNum}`);

                    if (invDetailSubrecord) {
                        // Generate lot number for this output
                        const outputLotNumber = `PROC-${procNumber}-OUT${index + 1}`;
                        log.debug('createInventoryAdjustmentFromProcessing', `Creating new output lot: ${outputLotNumber}`);

                        invDetailSubrecord.setSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'receiptinventorynumber',
                            line: 0,
                            value: outputLotNumber
                        });
                        log.debug('createInventoryAdjustmentFromProcessing', `✓ Set new output lot number ${outputLotNumber}`);

                        invDetailSubrecord.setSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'quantity',
                            line: 0,
                            value: outputLine.weight
                        });
                        log.debug('createInventoryAdjustmentFromProcessing', `✓ Set output inventory detail quantity ${outputLine.weight}`);
                    }

                    log.debug('createInventoryAdjustmentFromProcessing', `✓ Completed output line ${lineNum}`);
                } catch (lineError) {
                    log.error('createInventoryAdjustmentFromProcessing', {
                        error: `❌ Error processing output line ${lineNum}`,
                        message: lineError.message,
                        stack: lineError.stack,
                        outputLine: outputLine
                    });
                    throw lineError;
                }
            });

            log.debug('createInventoryAdjustmentFromProcessing', '✓ Completed adding all inventory lines');
            log.debug('createInventoryAdjustmentFromProcessing', '==== SUMMARY ====');
            log.debug('createInventoryAdjustmentFromProcessing', `Total lines: ${outputLines.length + 1} (1 input + ${outputLines.length} outputs)`);
            log.debug('createInventoryAdjustmentFromProcessing', `Line 0: Input Consumption - Item ${inputItem}, Qty -${inputWeight}, Lot ${inputLot}`);
            outputLines.forEach((line, idx) => {
                log.debug('createInventoryAdjustmentFromProcessing', `Line ${idx + 1}: Output Creation - Item ${line.itemId}, Qty +${line.weight}`);
            });
            log.debug('createInventoryAdjustmentFromProcessing', '================');

            try {
                log.debug('createInventoryAdjustmentFromProcessing', '📝 Attempting to save Inventory Adjustment...');
                const invAdjId = invAdj.save();
                log.audit('createInventoryAdjustmentFromProcessing', `✅ SUCCESS: Inventory Adjustment created with ID: ${invAdjId}`);

                // v2.1: Append cost-allocation audit to processing record notes
                try {
                    const auditNote = '\n[Cost Allocation ' + new Date().toISOString().split('T')[0] + ']\n'
                        + costAllocation.formatAuditString(allocResult);
                    const existingNotes = procRec.getValue({ fieldId: 'custrecord_sust_processing_notes' }) || '';
                    record.submitFields({
                        type: 'customrecord_sust_processing_record',
                        id: processingId,
                        values: {
                            custrecord_sust_processing_notes: (existingNotes + auditNote).substring(0, 3900)
                        }
                    });
                } catch (auditErr) {
                    log.error('Audit note append failed', auditErr.message);
                }

                return invAdjId;
            } catch (e) {
                log.error('createInventoryAdjustmentFromProcessing', {
                    title: '❌ SAVE FAILED',
                    error: e.message,
                    stack: e.stack,
                    name: e.name,
                    processingId: processingId
                });
                return null;
            }
        };

        /**
         * Get output lines for a processing record
         * @param {string|number} processingId - Processing record internal ID
         * @returns {Object[]} Array of output line objects
         */
        const getOutputLines = (processingId) => {
            const outputLines = [];

            const outputSearch = search.create({
                type: 'customrecord_sust_processing_output_line',
                filters: [
                    ['custrecord_sust_output_processing', 'anyof', processingId]
                ],
                columns: [
                    'custrecord_sust_output_line_number',
                    'custrecord_sust_output_item',
                    'custrecord_sust_output_weight',
                    'custrecord_sust_output_type',
                    'custrecord_sust_output_disposition'
                ]
            });

            outputSearch.run().each(result => {
                outputLines.push({
                    lineNumber: parseInt(result.getValue('custrecord_sust_output_line_number'), 10),
                    itemId: parseInt(result.getValue('custrecord_sust_output_item'), 10),
                    weight: parseFloat(result.getValue('custrecord_sust_output_weight')),
                    outputType: result.getValue('custrecord_sust_output_type'),
                    disposition: result.getValue('custrecord_sust_output_disposition')
                });
                return true;
            });

            // Sort by line number
            outputLines.sort((a, b) => a.lineNumber - b.lineNumber);

            return outputLines;
        };

        /**
         * Process output lots after Inventory Adjustment creation
         * - Initialize output lot fields (source type, lot status)
         * - Create lot genealogy records
         * @param {number} invAdjustmentId
         * @param {number} processingId
         */
        const processOutputLots = (invAdjustmentId, processingId) => {
            try {
                log.audit('processOutputLots', `Processing output lots for Inventory Adjustment ${invAdjustmentId}`);

                // Load processing record to get input lot
                const procRec = record.load({
                    type: 'customrecord_sust_processing_record',
                    id: processingId
                });

                const inputLotId = procRec.getValue({ fieldId: 'custrecord_sust_processing_input_lot' });
                const inputWeight = parseFloat(procRec.getValue({ fieldId: 'custrecord_sust_processing_input_lbs' }));
                const procNumber = procRec.getValue({ fieldId: 'name' });

                // Get output lot numbers from inventory adjustment
                const outputLots = getCreatedOutputLots(invAdjustmentId, procNumber);
                log.audit('processOutputLots', `Found ${outputLots.length} created output lots`);

                // Initialize each output lot and create genealogy
                outputLots.forEach(outputLot => {
                    // Set output lot defaults (source type, status)
                    initializeOutputLot(outputLot.lotId);

                    // Create lot genealogy record
                    createLotGenealogy(inputLotId, outputLot.lotId, outputLot.weight, inputWeight, processingId);
                });

                log.audit('processOutputLots', 'Completed processing all output lots');
            } catch (e) {
                log.error('processOutputLots', {
                    error: e.message,
                    stack: e.stack,
                    invAdjustmentId: invAdjustmentId,
                    processingId: processingId
                });
            }
        };

        /**
         * Get created output lots from inventory adjustment
         * @param {number} invAdjustmentId
         * @param {string} procNumber
         * @returns {Array} Array of {lotId, lotNumber, weight, itemId}
         */
        const getCreatedOutputLots = (invAdjustmentId, procNumber) => {
            const outputLots = [];

            // Search for lots created by this inventory adjustment
            const lotSearch = search.create({
                type: search.Type.INVENTORY_NUMBER,
                filters: [
                    ['inventorynumber', 'startswith', `PROC-${procNumber}-OUT`]
                ],
                columns: [
                    'internalid',
                    'inventorynumber',
                    'item'
                ]
            });

            lotSearch.run().each(result => {
                outputLots.push({
                    lotId: parseInt(result.getValue('internalid'), 10),
                    lotNumber: result.getValue('inventorynumber'),
                    itemId: parseInt(result.getValue('item'), 10),
                    weight: 0 // Weight will be looked up separately if needed
                });
                return true;
            });

            return outputLots;
        };

        /**
         * Initialize a newly created output lot's custom fields
         * (source type + lot status; quality data is entered separately)
         * @param {number} lotId
         */
        const initializeOutputLot = (lotId) => {
            try {
                log.debug('initializeOutputLot', `Setting lot defaults for lot ${lotId}`);

                const invNumber = record.load({
                    type: record.Type.INVENTORY_NUMBER,
                    id: lotId
                });

                // Set lot metadata (custom list — set by display text, never internal id)
                invNumber.setText({ fieldId: 'custitemnumber_sust_lot_source_type', text: 'Processed' });

                // New output lots land in the Yard (custom list — set by display text)
                invNumber.setText({ fieldId: 'custitemnumber_sust_lot_status', text: 'Yard' });

                invNumber.setValue({ fieldId: 'custitemnumber_sust_lot_notes', value: 'Output lot created by processing' });

                invNumber.save();
                log.audit('initializeOutputLot', `Lot defaults set for lot ${lotId}`);
            } catch (e) {
                log.error('initializeOutputLot', {
                    error: e.message,
                    stack: e.stack,
                    lotId: lotId
                });
            }
        };

        /**
         * Create lot genealogy record linking input to output
         * @param {number} parentLotId
         * @param {number} childLotId
         * @param {number} qtyConsumed
         * @param {number} totalInput
         * @param {number} processingId
         */
        const createLotGenealogy = (parentLotId, childLotId, qtyConsumed, totalInput, processingId) => {
            try {
                const genealogy = record.create({
                    type: 'customrecord_sust_lot_relationship'
                });

                genealogy.setValue({ fieldId: 'custrecord_sust_parent_lot', value: parentLotId });
                genealogy.setValue({ fieldId: 'custrecord_sust_child_lot', value: childLotId });
                genealogy.setText({ fieldId: 'custrecord_sust_relationship_type', text: 'Grade Transformation' });
                genealogy.setValue({ fieldId: 'custrecord_sust_qty_consumed', value: qtyConsumed });

                if (totalInput > 0) {
                    const contributionPct = (qtyConsumed / totalInput) * 100;
                    genealogy.setValue({ fieldId: 'custrecord_sust_contribution_pct', value: contributionPct });
                }

                const genealogyId = genealogy.save();
                log.audit('createLotGenealogy', `Created genealogy record ${genealogyId} linking parent ${parentLotId} to child ${childLotId}`);
            } catch (e) {
                log.error('createLotGenealogy', {
                    error: e.message,
                    stack: e.stack,
                    parentLotId: parentLotId,
                    childLotId: childLotId
                });
            }
        };

        /**
         * Link a settlement record to a processing record via the input lot.
         * Sets bidirectional links: custrecord_sust_processing_settlement on Processing
         * and custrecord_sust_settlement_processing on Settlement.
         * Non-critical — failures are logged but never block the main flow.
         * @param {string|number} processingId
         */
        const linkSettlementToProcessing = (processingId) => {
            try {
                // Load processing record to get input lot
                const procRec = record.load({
                    type: 'customrecord_sust_processing_record',
                    id: processingId
                });

                // Skip if settlement already linked
                const existingSettlement = procRec.getValue({ fieldId: 'custrecord_sust_processing_settlement' });
                if (existingSettlement) {
                    log.debug('linkSettlementToProcessing', `Processing ${processingId} already linked to settlement ${existingSettlement}`);
                    return;
                }

                const inputLotId = procRec.getValue({ fieldId: 'custrecord_sust_processing_input_lot' });
                if (!inputLotId) {
                    log.debug('linkSettlementToProcessing', `No input lot on processing ${processingId}`);
                    return;
                }

                // Try to find settlement by lot field first
                let settlementId = findSettlementByLot(inputLotId);

                // Fallback: search settlement notes for the lot number string
                if (!settlementId) {
                    settlementId = findSettlementByLotNumber(inputLotId);
                }

                if (!settlementId) {
                    log.debug('linkSettlementToProcessing', `No settlement found for lot ${inputLotId}`);
                    return;
                }

                // Set bidirectional links
                record.submitFields({
                    type: 'customrecord_sust_processing_record',
                    id: processingId,
                    values: {
                        custrecord_sust_processing_settlement: settlementId
                    }
                });

                record.submitFields({
                    type: 'customrecord_sust_settlement_record',
                    id: settlementId,
                    values: {
                        custrecord_sust_settlement_processing: processingId
                    }
                });

                log.audit('linkSettlementToProcessing', {
                    processingId: processingId,
                    settlementId: settlementId,
                    lotId: inputLotId
                });

            } catch (e) {
                // Non-critical — log and continue
                log.error('linkSettlementToProcessing', {
                    error: e.message,
                    stack: e.stack,
                    processingId: processingId
                });
            }
        };

        /**
         * Find a settlement record by the custrecord_sust_settlement_lot field
         * @param {number} lotId
         * @returns {number|null}
         */
        const findSettlementByLot = (lotId) => {
            try {
                const settlementSearch = search.create({
                    type: 'customrecord_sust_settlement_record',
                    filters: [
                        ['custrecord_sust_settlement_lot', 'anyof', lotId]
                    ],
                    columns: ['internalid']
                });

                const results = settlementSearch.run().getRange({ start: 0, end: 1 });
                if (results.length > 0) {
                    log.debug('findSettlementByLot', `Found settlement ${results[0].id} for lot ${lotId}`);
                    return parseInt(results[0].id, 10);
                }
            } catch (e) {
                log.error('findSettlementByLot', `Error searching for lot ${lotId}: ${e.message}`);
            }
            return null;
        };

        /**
         * Fallback: find a settlement by searching notes for the lot number string.
         * Also backfills custrecord_sust_settlement_lot if found.
         * @param {number} lotId
         * @returns {number|null}
         */
        const findSettlementByLotNumber = (lotId) => {
            try {
                // Get the lot number string from the lot ID
                const lotLookup = search.lookupFields({
                    type: 'inventorynumber',
                    id: lotId,
                    columns: ['inventorynumber']
                });
                const lotNumber = lotLookup.inventorynumber;
                if (!lotNumber) return null;

                // Search settlement notes for lot number string
                const settlementSearch = search.create({
                    type: 'customrecord_sust_settlement_record',
                    filters: [
                        ['custrecord_sust_settlement_notes', 'contains', lotNumber]
                    ],
                    columns: ['internalid']
                });

                const results = settlementSearch.run().getRange({ start: 0, end: 1 });
                if (results.length > 0) {
                    const settlementId = parseInt(results[0].id, 10);
                    log.debug('findSettlementByLotNumber', `Found settlement ${settlementId} via notes for lot number ${lotNumber}`);

                    // Backfill custrecord_sust_settlement_lot for future lookups
                    try {
                        record.submitFields({
                            type: 'customrecord_sust_settlement_record',
                            id: settlementId,
                            values: {
                                custrecord_sust_settlement_lot: lotId
                            }
                        });
                        log.debug('findSettlementByLotNumber', `Backfilled settlement_lot on settlement ${settlementId}`);
                    } catch (backfillError) {
                        log.error('findSettlementByLotNumber', `Backfill failed: ${backfillError.message}`);
                    }

                    return settlementId;
                }
            } catch (e) {
                log.error('findSettlementByLotNumber', `Error: ${e.message}`);
            }
            return null;
        };

        return {
            afterSubmit: afterSubmit
        };
    });
