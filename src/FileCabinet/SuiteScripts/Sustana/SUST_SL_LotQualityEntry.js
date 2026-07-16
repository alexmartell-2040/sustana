/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */

/**
 * SUST_SL_LotQualityEntry.js
 *
 * Suitelet for entering lot quality & grade data from an Item Receipt.
 * Displays all lots from the IR and allows editing the four quality fields
 * (Moisture %, Contamination %, Fiber Content %, Bale Count) plus Yield %
 * and Vendor Lot Number.
 *
 * On save:
 *   - Revised values on a previously graded lot append a quality-audit line
 *     to the lot notes (original vs revised values).
 *   - The lot status moves Received -> Yard (quality check clears the lot
 *     into the yard); later statuses are never regressed.
 *
 * Author: Sustana Dev Team
 * Date: July 2026
 */

define(['N/ui/serverWidget', 'N/record', 'N/search', 'N/redirect', 'N/log'],
    function(serverWidget, record, search, redirect, log) {

        // The four lot quality fields (custitemnumber_sust_* on inventorynumber)
        const QUALITY_FIELDS = [
            { id: 'moisture',      fieldId: 'custitemnumber_sust_moisture_pct',      label: 'Moisture %',      type: 'percent' },
            { id: 'contamination', fieldId: 'custitemnumber_sust_contamination_pct', label: 'Contamination %', type: 'percent' },
            { id: 'fiber_content', fieldId: 'custitemnumber_sust_fiber_content_pct', label: 'Fiber Content %', type: 'percent' },
            { id: 'bale_count',    fieldId: 'custitemnumber_sust_bale_count',        label: 'Bale Count',      type: 'integer' }
        ];

        const NOTES_MAX = 3999;

        /**
         * Main entry point
         */
        function onRequest(context) {
            try {
                if (context.request.method === 'GET') {
                    displayForm(context);
                } else {
                    processSubmission(context);
                }
            } catch (e) {
                log.error('onRequest', e.toString() + '\n' + (e.stack || ''));
                context.response.write(`<html><body><h1>Error</h1><p>${e.message}</p></body></html>`);
            }
        }

        /**
         * Display the lot quality editing form
         */
        function displayForm(context) {
            const itemReceiptId = context.request.parameters.itemreceiptid;

            if (!itemReceiptId) {
                context.response.write('<html><body><h1>Error</h1><p>Item Receipt ID is required.</p></body></html>');
                return;
            }

            // Load the Item Receipt
            const itemReceipt = record.load({
                type: record.Type.ITEM_RECEIPT,
                id: itemReceiptId,
                isDynamic: false
            });

            const tranId = itemReceipt.getValue({ fieldId: 'tranid' });

            const form = serverWidget.createForm({
                title: `Lot Quality & Grade Entry - Item Receipt ${tranId || itemReceiptId}`
            });

            // Attach client script
            form.clientScriptModulePath = './SUST_CS_LotQualityEntry.js';

            // Hidden field for Item Receipt ID
            const hiddenIR = form.addField({
                id: 'custpage_item_receipt_id',
                type: serverWidget.FieldType.TEXT,
                label: 'Item Receipt ID'
            });
            hiddenIR.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            hiddenIR.defaultValue = itemReceiptId;

            // Create lot lines sublist
            const sublist = form.addSublist({
                id: 'custpage_lot_lines',
                type: serverWidget.SublistType.INLINEEDITOR,
                label: 'Lot Quality'
            });

            // Lot Number (display only)
            sublist.addField({
                id: 'custpage_lot_number',
                type: serverWidget.FieldType.TEXT,
                label: 'Lot Number'
            }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });

            // Lot Internal ID (disabled - must not be HIDDEN; hidden sublist fields
            // are not reliably submitted in POST data for INLINEEDITOR sublists)
            const lotIdField = sublist.addField({
                id: 'custpage_lot_id',
                type: serverWidget.FieldType.TEXT,
                label: 'Lot ID'
            });
            lotIdField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });

            // Item (display only)
            sublist.addField({
                id: 'custpage_lot_item',
                type: serverWidget.FieldType.TEXT,
                label: 'Item'
            }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });

            // Quantity (display only)
            sublist.addField({
                id: 'custpage_lot_qty',
                type: serverWidget.FieldType.FLOAT,
                label: 'Quantity'
            }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });

            // Quality fields (editable)
            QUALITY_FIELDS.forEach(function(q) {
                sublist.addField({
                    id: 'custpage_quality_' + q.id,
                    type: q.type === 'integer' ? serverWidget.FieldType.INTEGER : serverWidget.FieldType.PERCENT,
                    label: q.label
                });
            });

            // Yield %
            sublist.addField({
                id: 'custpage_yield_pct',
                type: serverWidget.FieldType.PERCENT,
                label: 'Yield %'
            });

            // Vendor Lot Number
            sublist.addField({
                id: 'custpage_vendor_lot',
                type: serverWidget.FieldType.TEXT,
                label: 'Vendor Lot Number'
            });

            // Extract lots from Item Receipt and populate sublist
            const lots = extractLotsFromItemReceipt(itemReceipt);
            log.debug('displayForm', `Found ${lots.length} lots on Item Receipt ${itemReceiptId}`);

            lots.forEach(function(lot, lineNum) {
                sublist.setSublistValue({
                    id: 'custpage_lot_number',
                    line: lineNum,
                    value: lot.lotNumber
                });
                sublist.setSublistValue({
                    id: 'custpage_lot_id',
                    line: lineNum,
                    value: String(lot.lotId)
                });
                sublist.setSublistValue({
                    id: 'custpage_lot_item',
                    line: lineNum,
                    value: lot.itemName || String(lot.itemId)
                });
                sublist.setSublistValue({
                    id: 'custpage_lot_qty',
                    line: lineNum,
                    value: lot.quantity
                });

                // Populate current quality values
                QUALITY_FIELDS.forEach(function(q) {
                    const val = lot.quality[q.id];
                    if (val !== null && val !== undefined) {
                        sublist.setSublistValue({
                            id: 'custpage_quality_' + q.id,
                            line: lineNum,
                            value: String(val)
                        });
                    }
                });

                if (lot.yieldPct) {
                    sublist.setSublistValue({
                        id: 'custpage_yield_pct',
                        line: lineNum,
                        value: String(lot.yieldPct)
                    });
                }

                if (lot.vendorLotNumber) {
                    sublist.setSublistValue({
                        id: 'custpage_vendor_lot',
                        line: lineNum,
                        value: lot.vendorLotNumber
                    });
                }
            });

            // Submit button
            form.addSubmitButton({ label: 'Save Lot Quality' });

            // Cancel button to go back to IR
            form.addButton({
                id: 'custpage_btn_cancel',
                label: 'Cancel',
                functionName: 'cancelForm'
            });

            context.response.writePage(form);
        }

        /**
         * Extract lots from an Item Receipt record
         * @param {Record} itemReceipt
         * @returns {Array} Array of lot objects
         */
        function extractLotsFromItemReceipt(itemReceipt) {
            const lots = [];
            const lineCount = itemReceipt.getLineCount({ sublistId: 'item' });

            for (let i = 0; i < lineCount; i++) {
                const itemId = itemReceipt.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                });

                const itemName = itemReceipt.getSublistText({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                });

                // Get inventory detail subrecord
                let lineInventoryDetail;
                try {
                    lineInventoryDetail = itemReceipt.getSublistSubrecord({
                        sublistId: 'item',
                        fieldId: 'inventorydetail',
                        line: i
                    });
                } catch (e) {
                    // Item may not be lot-tracked
                    continue;
                }

                if (!lineInventoryDetail) continue;

                const invLineCount = lineInventoryDetail.getLineCount({
                    sublistId: 'inventoryassignment'
                });

                for (let j = 0; j < invLineCount; j++) {
                    // Try new lot number first
                    let lotNumber = lineInventoryDetail.getSublistValue({
                        sublistId: 'inventoryassignment',
                        fieldId: 'receiptinventorynumber',
                        line: j
                    });

                    let lotId = null;

                    // If not a new lot, get the lot already on file
                    if (!lotNumber) {
                        const inventoryNumberId = lineInventoryDetail.getSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'inventorynumber',
                            line: j
                        });

                        if (inventoryNumberId) {
                            lotId = parseInt(inventoryNumberId, 10);
                            const lotLookup = search.lookupFields({
                                type: 'inventorynumber',
                                id: inventoryNumberId,
                                columns: ['inventorynumber']
                            });
                            lotNumber = lotLookup.inventorynumber;
                        }
                    }

                    // If we have a lot number but no ID, look it up
                    if (lotNumber && !lotId) {
                        lotId = findLotInternalId(lotNumber);
                    }

                    const lotQty = lineInventoryDetail.getSublistValue({
                        sublistId: 'inventoryassignment',
                        fieldId: 'quantity',
                        line: j
                    });

                    if (lotNumber && lotId) {
                        // Look up current quality values for this lot
                        const quality = lookupLotQuality(lotId);

                        lots.push({
                            lotNumber: lotNumber,
                            lotId: lotId,
                            itemId: itemId,
                            itemName: itemName,
                            quantity: parseFloat(lotQty) || 0,
                            quality: quality.values,
                            yieldPct: quality.yieldPct,
                            vendorLotNumber: quality.vendorLotNumber
                        });
                    }
                }
            }

            return lots;
        }

        /**
         * Find lot internal ID by lot number string
         * @param {string} lotNumber
         * @returns {number|null}
         */
        function findLotInternalId(lotNumber) {
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
                log.error('findLotInternalId', `Error finding lot ${lotNumber}: ${e.message}`);
            }
            return null;
        }

        /**
         * Look up current quality values for a lot
         * @param {number} lotId
         * @returns {Object} { values: {}, yieldPct, vendorLotNumber }
         */
        function lookupLotQuality(lotId) {
            try {
                const columns = QUALITY_FIELDS.map(function(q) { return q.fieldId; });
                columns.push('custitemnumber_sust_recovery_percentage');
                columns.push('custitemnumber_sust_vendor_lot_number');

                const lotFields = search.lookupFields({
                    type: 'inventorynumber',
                    id: lotId,
                    columns: columns
                });

                const values = {};
                QUALITY_FIELDS.forEach(function(q) {
                    values[q.id] = parseNumeric(lotFields[q.fieldId]);
                });

                return {
                    values: values,
                    yieldPct: parseNumeric(lotFields.custitemnumber_sust_recovery_percentage) || 0,
                    vendorLotNumber: lotFields.custitemnumber_sust_vendor_lot_number || ''
                };
            } catch (e) {
                log.error('lookupLotQuality', `Error looking up lot ${lotId}: ${e.message}`);
                return { values: {}, yieldPct: 0, vendorLotNumber: '' };
            }
        }

        /**
         * Process form submission - save quality values to lot records
         */
        function processSubmission(context) {
            const itemReceiptId = context.request.parameters.custpage_item_receipt_id;
            const lineCount = context.request.getLineCount({ group: 'custpage_lot_lines' });

            log.audit('processSubmission', `Processing ${lineCount} lot lines for Item Receipt ${itemReceiptId}`);

            let successCount = 0;
            let errorCount = 0;

            for (let i = 0; i < lineCount; i++) {
                const lotId = context.request.getSublistValue({
                    group: 'custpage_lot_lines',
                    name: 'custpage_lot_id',
                    line: i
                });

                const lotNumber = context.request.getSublistValue({
                    group: 'custpage_lot_lines',
                    name: 'custpage_lot_number',
                    line: i
                });

                log.debug('processSubmission', `Line ${i}: lotId="${lotId}", lotNumber="${lotNumber}"`);

                if (!lotId) {
                    log.debug('processSubmission', `Skipping line ${i} - no lot ID`);
                    continue;
                }

                try {
                    const invNumber = record.load({
                        type: record.Type.INVENTORY_NUMBER,
                        id: parseInt(lotId, 10)
                    });

                    // Ensure required Source Type is set (default to Purchased for IR lots)
                    const existingSourceType = invNumber.getValue({ fieldId: 'custitemnumber_sust_lot_source_type' });
                    if (!existingSourceType) {
                        invNumber.setText({
                            fieldId: 'custitemnumber_sust_lot_source_type',
                            text: 'Purchased'
                        });
                    }

                    // Capture original values before applying revisions (for the
                    // quality-audit note on regrades)
                    const originals = {};
                    QUALITY_FIELDS.forEach(function(q) {
                        originals[q.id] = parseNumeric(invNumber.getValue({ fieldId: q.fieldId }));
                    });

                    // Set quality values. NOTE: PERCENT form values arrive on POST
                    // with a '%' suffix (e.g. "65.0%") — parseFloat handles it.
                    // Allow explicit zeroes (val !== '').
                    const changes = [];
                    QUALITY_FIELDS.forEach(function(q) {
                        const raw = context.request.getSublistValue({
                            group: 'custpage_lot_lines',
                            name: 'custpage_quality_' + q.id,
                            line: i
                        });

                        if (raw === null || raw === undefined || raw === '') return;

                        const num = q.type === 'integer' ? parseInt(raw, 10) : parseFloat(raw);
                        if (isNaN(num)) return;

                        invNumber.setValue({ fieldId: q.fieldId, value: num });

                        if (originals[q.id] !== num) {
                            changes.push(q.label + ': ' + fmtOriginal(originals[q.id]) + ' -> ' + num);
                        }
                    });

                    // Regrade audit: when a previously graded lot is revised, append
                    // an audit line to the lot notes recording original vs revised.
                    const hadPriorValues = QUALITY_FIELDS.some(function(q) { return originals[q.id] !== null; });
                    if (hadPriorValues && changes.length > 0) {
                        appendQualityAuditNote(invNumber, itemReceiptId, changes);
                    }

                    // Set Yield % (PERCENT — '%' suffix on POST, parseFloat first)
                    const yieldPct = context.request.getSublistValue({
                        group: 'custpage_lot_lines',
                        name: 'custpage_yield_pct',
                        line: i
                    });
                    if (yieldPct !== null && yieldPct !== '') {
                        const yieldNum = parseFloat(yieldPct);
                        if (!isNaN(yieldNum)) {
                            invNumber.setValue({
                                fieldId: 'custitemnumber_sust_recovery_percentage',
                                value: yieldNum
                            });
                        }
                    }

                    // Set vendor lot number
                    const vendorLot = context.request.getSublistValue({
                        group: 'custpage_lot_lines',
                        name: 'custpage_vendor_lot',
                        line: i
                    });
                    if (vendorLot) {
                        invNumber.setValue({
                            fieldId: 'custitemnumber_sust_vendor_lot_number',
                            value: vendorLot
                        });
                    }

                    // Quality check moves the lot Received -> Yard. Only advance from
                    // Received (or empty) — never regress later statuses.
                    const statusText = invNumber.getText({ fieldId: 'custitemnumber_sust_lot_status' }) || '';
                    if (statusText === '' || statusText === 'Received') {
                        invNumber.setText({
                            fieldId: 'custitemnumber_sust_lot_status',
                            text: 'Yard'
                        });
                    }

                    invNumber.save();
                    successCount++;
                    log.audit('processSubmission', `Updated quality for lot ${lotId} (${lotNumber})`);

                } catch (e) {
                    errorCount++;
                    log.error('processSubmission', `Error updating lot ${lotId}: ${e.message}\n${e.stack || ''}`);
                }
            }

            log.audit('processSubmission', `Complete: ${successCount} updated, ${errorCount} errors`);

            // Redirect back to Item Receipt
            redirect.toRecord({
                type: record.Type.ITEM_RECEIPT,
                id: itemReceiptId
            });
        }

        /**
         * Append a quality-audit line (original vs revised values) to the lot notes.
         * @param {Record} invNumber  loaded inventorynumber record (not yet saved)
         * @param {string} itemReceiptId
         * @param {Array} changes  e.g. ['Moisture %: 12 -> 9', ...]
         */
        function appendQualityAuditNote(invNumber, itemReceiptId, changes) {
            try {
                const existingNotes = invNumber.getValue({ fieldId: 'custitemnumber_sust_lot_notes' }) || '';
                const newNote = '[Quality Regrade ' + new Date().toISOString().substring(0, 10)
                    + ', IR ' + itemReceiptId + '] ' + changes.join('; ') + '.';
                const merged = existingNotes ? existingNotes + '\n' + newNote : newNote;
                invNumber.setValue({
                    fieldId: 'custitemnumber_sust_lot_notes',
                    value: merged.substring(0, NOTES_MAX)
                });
            } catch (e) {
                log.error('appendQualityAuditNote', e.message);
            }
        }

        /**
         * Parse a numeric field value that may arrive as a number, '' or a
         * percent-formatted string ("65.0%"). Returns null when unset.
         */
        function parseNumeric(v) {
            if (v === null || v === undefined || v === '') return null;
            const n = parseFloat(v);
            return isNaN(n) ? null : n;
        }

        /** Display helper for audit lines: null originals render as '(none)'. */
        function fmtOriginal(v) {
            return (v === null || v === undefined) ? '(none)' : String(v);
        }

        return {
            onRequest: onRequest
        };

    });
