/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */

/**
 * SUST_UE_ItemReceipt_BridgeVendorLot.js
 *
 * v2 (June 2026): Dual lot identification bridge.
 *
 * On Item Receipt afterSubmit, reads custcol_sust_vendor_lot_number from each IR
 * line and copies it to the corresponding inventory lot record's
 * custitemnumber_sust_vendor_lot_number field.
 *
 * This implements the dual-lot identity model from CROSS-001:
 *   - RL number = system-generated, NetSuite-controlled (inventory number ID)
 *   - Vendor lot = supplier-stamped on the physical bales, captured at receipt
 * Both must travel together for life of the lot for traceability.
 *
 * Also initializes new-lot defaults: a lot with no status yet is set to
 * 'Received' (first step of the yard flow) — statuses already set are never
 * touched.
 *
 * Operates only on the configured Sustana Recovery subsidiary (parameter).
 *
 * Author: Sustana Dev Team
 * Date: June 2026 (v2)
 */

define(['N/record', 'N/search', 'N/runtime', 'N/log', './SUST_Lib_Config', './SUST_Lib_LotAttributes'],
    function(record, search, runtime, log, configLib, lotAttr) {
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


        /**
         * afterSubmit - Bridge vendor lot custcol values to lot records.
         */
        function afterSubmit(context) {
            try {
                // Only run on create or edit
                if (context.type !== context.UserEventType.CREATE &&
                    context.type !== context.UserEventType.EDIT) {
                    return;
                }

                const irId = context.newRecord.id;

                // Check subsidiary (script param or configured demo subsidiaries)
                const subsidiaryId = context.newRecord.getValue({ fieldId: 'subsidiary' });
                if (!subsidiaryAllowed(subsidiaryId, 'custscript_sust_sub_id_bridge')) {
                    log.debug('Skip Bridge',
                        `Subsidiary ${subsidiaryId} is not a configured Sustana subsidiary - skipping vendor lot bridge`);
                    return;
                }

                // Reload IR in non-dynamic mode to access inventory detail subrecords cleanly
                const ir = record.load({
                    type: record.Type.ITEM_RECEIPT,
                    id: irId,
                    isDynamic: false
                });

                const lineCount = ir.getLineCount({ sublistId: 'item' });
                let bridgedCount = 0;
                let skippedCount = 0;

                for (let i = 0; i < lineCount; i++) {
                    // Read the vendor lot number from the custcol
                    const vendorLotNumber = ir.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_sust_vendor_lot_number',
                        line: i
                    });

                    // Quality graded at receipt entry (line columns) — bridged to
                    // the lot alongside the vendor lot number.
                    const colVal = function(fieldId) {
                        const v = ir.getSublistValue({ sublistId: 'item', fieldId: fieldId, line: i });
                        return (v === null || v === undefined || v === '') ? null : v;
                    };
                    const lineQuality = {
                        moisture: colVal('custcol_sust_lot_moisture'),
                        contamination: colVal('custcol_sust_lot_contamination'),
                        fiber: colVal('custcol_sust_lot_fiber'),
                        baleCount: colVal('custcol_sust_lot_bales')
                    };
                    const hasQuality = Object.keys(lineQuality).some(function(k) { return lineQuality[k] !== null; });

                    if ((!vendorLotNumber || vendorLotNumber.toString().trim() === '') && !hasQuality) {
                        skippedCount++;
                        continue;
                    }

                    // Get the inventory detail subrecord on this line
                    let invDetail;
                    try {
                        invDetail = ir.getSublistSubrecord({
                            sublistId: 'item',
                            fieldId: 'inventorydetail',
                            line: i
                        });
                    } catch (subErr) {
                        log.audit('No Inventory Detail',
                            `Line ${i + 1}: no inventoryDetail subrecord (item probably not lot-tracked) — skipping`);
                        skippedCount++;
                        continue;
                    }

                    // Walk each inventory assignment (lot) on this line
                    const assignmentCount = invDetail.getLineCount({ sublistId: 'inventoryassignment' });
                    if (assignmentCount === 0) {
                        log.audit('Empty Inventory Detail',
                            `Line ${i + 1}: inventoryDetail exists but has no assignments — skipping`);
                        skippedCount++;
                        continue;
                    }

                    for (let j = 0; j < assignmentCount; j++) {
                        // Existing-lot path returns an integer internal ID;
                        // new-lot path returns the lot number STRING (e.g., "LOT-v2-100").
                        // We must resolve the string to an internal ID before submitFields().
                        const issueInvNumId = invDetail.getSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'issueinventorynumber',
                            line: j
                        });
                        const receiptInvNumString = invDetail.getSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'receiptinventorynumber',
                            line: j
                        });

                        let lotInternalId = null;

                        if (issueInvNumId) {
                            // Existing lot — already have the integer ID
                            lotInternalId = issueInvNumId;
                        } else if (receiptInvNumString) {
                            // New lot — look up internal ID by lot number string
                            try {
                                const lotSearch = search.create({
                                    type: 'inventorynumber',
                                    filters: [['inventorynumber', 'is', receiptInvNumString]],
                                    columns: ['internalid']
                                });
                                const lotResults = lotSearch.run().getRange({ start: 0, end: 1 });
                                if (lotResults.length > 0) {
                                    lotInternalId = lotResults[0].id;
                                    log.debug('Resolved New Lot ID',
                                        `Lot string "${receiptInvNumString}" → internal ID ${lotInternalId}`);
                                } else {
                                    log.error('New Lot Not Found',
                                        `IR Line ${i + 1}: created lot "${receiptInvNumString}" not yet searchable — bridge skipped for this assignment`);
                                    skippedCount++;
                                    continue;
                                }
                            } catch (lookupErr) {
                                log.error('Lot Lookup Failed',
                                    `IR Line ${i + 1}: error resolving lot "${receiptInvNumString}": ${lookupErr.message}`);
                                skippedCount++;
                                continue;
                            }
                        }

                        if (!lotInternalId) continue;

                        // Update the inventory number record: vendor lot field, plus
                        // new-lot default status 'Received' when no status is set yet.
                        // (record.load so the list status can be set by TEXT — never a
                        // hardcoded numeric list id.)
                        try {
                            const lotRec = record.load({
                                type: 'inventorynumber',
                                id: lotInternalId
                            });
                            if (vendorLotNumber && vendorLotNumber.toString().trim() !== '') {
                                lotRec.setValue({
                                    fieldId: 'custitemnumber_sust_vendor_lot_number',
                                    value: vendorLotNumber
                                });
                            }
                            const existingStatus = lotRec.getValue({ fieldId: 'custitemnumber_sust_lot_status' });
                            if (!existingStatus) {
                                lotRec.setText({
                                    fieldId: 'custitemnumber_sust_lot_status',
                                    text: 'Received'
                                });
                            }
                            // Form: received material is Loose until baled by processing
                            try {
                                if (!lotRec.getValue({ fieldId: 'custitemnumber_sust_lot_form' })) {
                                    lotRec.setText({ fieldId: 'custitemnumber_sust_lot_form', text: 'Loose' });
                                }
                            } catch (eForm) { log.debug('lot form default skipped', eForm.message); }
                            lotRec.save({ enableSourcing: false, ignoreMandatoryFields: true });
                            bridgedCount++;
                            log.debug('Vendor Lot Bridged',
                                `IR Line ${i + 1} → Lot ID ${lotInternalId} → "${vendorLotNumber || '(no vendor lot)'}"${existingStatus ? '' : ' (status initialized to Received)'}`);

                            // Quality-at-receipt: shared writer handles the fields,
                            // Received→Yard advance, and the audit trail — same
                            // semantics as the kiosk capture.
                            if (hasQuality) {
                                const qWrite = lotAttr.writeLotQuality(parseInt(lotInternalId, 10), {
                                    moisture: lineQuality.moisture,
                                    contamination: lineQuality.contamination,
                                    fiber: lineQuality.fiber,
                                    baleCount: lineQuality.baleCount,
                                    notesAppend: '[Graded at receipt entry ' + new Date().toISOString().substring(0, 10)
                                        + ', IR ' + irId + ' line ' + (i + 1) + ']'
                                });
                                if (qWrite && !qWrite.ok) {
                                    log.error('Receipt-entry quality write failed',
                                        `Lot ${lotInternalId}: ${qWrite.error}`);
                                }
                            }
                        } catch (subErr) {
                            log.error('Bridge Failed',
                                `Could not update vendor lot on Lot ID ${lotInternalId}: ${subErr.message}`);
                        }
                    }
                }

                log.audit('Vendor Lot Bridge Summary',
                    `IR ${irId}: ${bridgedCount} lot(s) updated, ${skippedCount} line(s) skipped (no vendor lot entered or no lot tracking).`);

            } catch (e) {
                log.error('SUST_UE_ItemReceipt_BridgeVendorLot Failed',
                    `Error: ${e.message}\nStack: ${e.stack}`);
            }
        }

        return {
            afterSubmit: afterSubmit
        };
    });
