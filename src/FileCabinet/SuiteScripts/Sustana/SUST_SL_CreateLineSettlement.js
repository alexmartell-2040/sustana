/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */

/**
 * SUST_SL_CreateLineSettlement.js
 *
 * v2.3 (June 2026): On-demand, line-scoped settlement creation.
 *
 * Launched from the "Create / Manage Line Settlements" button on a PO or Item Receipt
 * (SUST_UE_LineSettlementLinks). Lists the scrap lines of the source transaction with their
 * pricing timing and any settlement already created, and lets the user create settlements
 * for the lines they choose — including:
 *   - recovery-priced lines deferred by the IR auto-create UE, and
 *   - settle-before-receipt creation directly from a PO line (no IR yet).
 *
 * Creation is delegated to SUST_Lib_SettlementCreate (shared with the IR auto-create UE).
 *
 * URL params: ?txn=<internalId>&type=po|ir
 */

define(['N/ui/serverWidget', 'N/record', 'N/search', 'N/redirect', 'N/log', './SUST_Lib_SettlementCreate'],
    function(serverWidget, record, search, redirect, log, settlementLib) {

        const SUBLIST_ID = 'custpage_lines';

        function onRequest(context) {
            if (context.request.method === 'GET') {
                renderForm(context);
            } else {
                handlePost(context);
            }
        }

        /**
         * Resolve URL/body 'type' token to a record type + label.
         */
        function resolveType(typeToken) {
            const t = (typeToken || '').toLowerCase();
            if (t === 'po' || t === 'purchaseorder') {
                return { recordType: record.Type.PURCHASE_ORDER, isPO: true, label: 'Purchase Order' };
            }
            return { recordType: record.Type.ITEM_RECEIPT, isPO: false, label: 'Item Receipt' };
        }

        function renderForm(context) {
            const txnId = context.request.parameters.txn;
            const typeInfo = resolveType(context.request.parameters.type);

            const form = serverWidget.createForm({ title: 'Create / Manage Line Settlements' });

            if (!txnId) {
                form.addField({ id: 'custpage_msg', type: serverWidget.FieldType.INLINEHTML, label: ' ' })
                    .defaultValue = '<p style="color:#c0392b;">No source transaction provided.</p>';
                context.response.writePage(form);
                return;
            }

            const txn = record.load({ type: typeInfo.recordType, id: txnId, isDynamic: false });
            const vendorId = txn.getValue({ fieldId: 'entity' });
            const vendorName = txn.getText({ fieldId: 'entity' });
            const poId = typeInfo.isPO ? txnId : (txn.getValue({ fieldId: 'createdfrom' }) || null);
            const headerTiming = txn.getText({ fieldId: 'custbody_sust_pricing_timing' }) || '';

            // Carry context through POST (body hidden fields round-trip reliably)
            addHidden(form, 'custpage_txnid', txnId);
            addHidden(form, 'custpage_txntype', typeInfo.isPO ? 'po' : 'ir');

            form.addField({
                id: 'custpage_header', type: serverWidget.FieldType.INLINEHTML, label: ' '
            }).defaultValue =
                `<div style="padding:8px 12px;background:#f4f7fb;border-left:4px solid #2976F3;margin-bottom:8px;">
                   <b>${typeInfo.label} #${escapeHtml(String(txnId))}</b> &nbsp;·&nbsp; Vendor: ${escapeHtml(vendorName || '')}<br>
                   Check the material lines to create a settlement for, then Submit. Lines already settled are shown for reference.
                 </div>`;

            const sublist = form.addSublist({
                id: SUBLIST_ID, type: serverWidget.SublistType.LIST, label: 'Material Lines'
            });
            sublist.addField({ id: 'custpage_create', type: serverWidget.FieldType.CHECKBOX, label: 'Create' });
            addColumn(sublist, 'custpage_linenum', 'Line');
            addColumn(sublist, 'custpage_linekey', 'Key');
            addColumn(sublist, 'custpage_item', 'Item');
            addColumn(sublist, 'custpage_itemid', 'Item ID');
            addColumn(sublist, 'custpage_qty', 'Qty (lbs)');
            addColumn(sublist, 'custpage_timing', 'Pricing Timing');
            addColumn(sublist, 'custpage_existing', 'Existing Settlement');

            const lineCount = txn.getLineCount({ sublistId: 'item' });
            let row = 0;
            for (let i = 0; i < lineCount; i++) {
                const itemId = txn.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
                const isScrap = settlementLib.lookupItemField(itemId, 'custitem_sust_is_scrap_material');
                if (isScrap !== true && isScrap !== 'T') continue;

                const lineKey = i + 1; // 1-based sublist index — consistent with the auto-create UE + links panel (v2.3 fix)

                const itemText = txn.getSublistText({ sublistId: 'item', fieldId: 'item', line: i }) || '';
                const qty = txn.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i }) || 0;
                let timing = txn.getSublistText({ sublistId: 'item', fieldId: 'custcol_sust_pricing_timing', line: i }) || '';
                if (!timing) timing = headerTiming;

                const existing = settlementLib.findExistingLineSettlement({
                    itemReceiptId: typeInfo.isPO ? null : txnId,
                    poId: poId,
                    sourceLine: lineKey
                });

                sublist.setSublistValue({ id: 'custpage_create', line: row, value: 'F' });
                sublist.setSublistValue({ id: 'custpage_linenum', line: row, value: String(i + 1) });
                sublist.setSublistValue({ id: 'custpage_linekey', line: row, value: String(lineKey) });
                sublist.setSublistValue({ id: 'custpage_item', line: row, value: itemText || ' ' });
                sublist.setSublistValue({ id: 'custpage_itemid', line: row, value: String(itemId) });
                sublist.setSublistValue({ id: 'custpage_qty', line: row, value: String(qty) });
                sublist.setSublistValue({ id: 'custpage_timing', line: row, value: timing || ' ' });
                sublist.setSublistValue({
                    id: 'custpage_existing', line: row,
                    value: existing ? ('Settlement #' + existing) : '—'
                });
                row++;
            }

            if (row === 0) {
                form.addField({ id: 'custpage_none', type: serverWidget.FieldType.INLINEHTML, label: ' ' })
                    .defaultValue = '<p>No recovered-material lines found on this transaction.</p>';
            } else {
                form.addSubmitButton({ label: 'Create Selected Settlements' });
            }

            context.response.writePage(form);
        }

        function handlePost(context) {
            const req = context.request;
            const txnId = req.parameters.custpage_txnid;
            const typeInfo = resolveType(req.parameters.custpage_txntype);

            const txn = record.load({ type: typeInfo.recordType, id: txnId, isDynamic: false });
            const vendorId = txn.getValue({ fieldId: 'entity' });
            const tranDate = txn.getValue({ fieldId: 'trandate' });
            const poId = typeInfo.isPO ? txnId : (txn.getValue({ fieldId: 'createdfrom' }) || null);

            // Map lineKey -> sublist index on the source txn (for fresh data gathering)
            const keyToIndex = {};
            const itemLineCount = txn.getLineCount({ sublistId: 'item' });
            for (let i = 0; i < itemLineCount; i++) {
                keyToIndex[i + 1] = i; // 1-based sublist index (v2.3 fix — matches render + create side)
            }

            const rows = req.getLineCount({ group: SUBLIST_ID });
            let created = 0;
            for (let r = 0; r < rows; r++) {
                const checked = req.getSublistValue({ group: SUBLIST_ID, name: 'custpage_create', line: r });
                if (checked !== 'T' && checked !== true) continue;

                const lineKey = parseInt(req.getSublistValue({ group: SUBLIST_ID, name: 'custpage_linekey', line: r }), 10);
                const itemId = req.getSublistValue({ group: SUBLIST_ID, name: 'custpage_itemid', line: r });

                // Skip if a settlement already exists for this line (race / double-submit guard)
                const existing = settlementLib.findExistingLineSettlement({
                    itemReceiptId: typeInfo.isPO ? null : txnId, poId: poId, sourceLine: lineKey
                });
                if (existing) {
                    log.audit('Skip (already settled)', `Line key ${lineKey} already has settlement ${existing}`);
                    continue;
                }

                // Gather fresh line data from the source txn
                const idx = keyToIndex[lineKey];
                let grossWeight = 0;
                let lotDetails = [];
                let recoveryPct = 100;
                let lotInternalId = null;

                if (idx !== undefined) {
                    grossWeight = parseFloat(txn.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: idx }) || 0);
                    if (!typeInfo.isPO) {
                        const lineInfo = getIRLineLots(txn, idx);
                        if (lineInfo.lotDetails.length) {
                            lotDetails = lineInfo.lotDetails;
                            if (lineInfo.grossWeight > 0) grossWeight = lineInfo.grossWeight;
                            lotInternalId = settlementLib.resolveLotInternalId(lotDetails[0].lotNumber);
                        }
                    }
                    const itemRecovery = settlementLib.lookupItemField(itemId, 'custitem_sust_typical_recovery');
                    if (itemRecovery) recoveryPct = parseFloat(itemRecovery) || 100;
                }

                settlementLib.createLineSettlement({
                    vendorId: vendorId,
                    tranDate: tranDate,
                    poId: poId,
                    itemReceiptId: typeInfo.isPO ? null : txnId,
                    sourceLine: lineKey,
                    itemId: itemId,
                    grossWeight: grossWeight,
                    recoveryPct: recoveryPct,
                    lotInternalId: lotInternalId,
                    lotDetails: lotDetails,
                    sourceTag: `${typeInfo.label} #${txnId} line ${idx !== undefined ? (idx + 1) : '?'} (on-demand)`
                });
                created++;
            }

            log.audit('On-Demand Settlements Created', `${created} settlement(s) for ${typeInfo.label} ${txnId}`);

            // Back to the source transaction
            redirect.toRecord({ type: typeInfo.recordType, id: txnId });
        }

        /**
         * Collect lot detail + gross weight for a single IR item line.
         */
        function getIRLineLots(txn, lineIndex) {
            const lotDetails = [];
            let grossWeight = 0;
            try {
                const itemId = txn.getSublistValue({ sublistId: 'item', fieldId: 'item', line: lineIndex });
                const invDetail = txn.getSublistSubrecord({ sublistId: 'item', fieldId: 'inventorydetail', line: lineIndex });
                if (invDetail) {
                    const n = invDetail.getLineCount({ sublistId: 'inventoryassignment' });
                    for (let j = 0; j < n; j++) {
                        let lotNumber = invDetail.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'receiptinventorynumber', line: j });
                        if (!lotNumber) {
                            const invNumId = invDetail.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'inventorynumber', line: j });
                            if (invNumId) {
                                const lk = search.lookupFields({ type: 'inventorynumber', id: invNumId, columns: ['inventorynumber'] });
                                lotNumber = lk.inventorynumber;
                            }
                        }
                        const lotQty = invDetail.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', line: j });
                        if (lotNumber && lotQty) {
                            grossWeight += parseFloat(lotQty);
                            lotDetails.push({ itemId: itemId, lotNumber: lotNumber, quantity: lotQty });
                        }
                    }
                }
            } catch (e) {
                log.error('getIRLineLots', `Line ${lineIndex}: ${e.toString()}`);
            }
            return { lotDetails: lotDetails, grossWeight: grossWeight };
        }

        function addColumn(sublist, id, label) {
            const f = sublist.addField({ id: id, type: serverWidget.FieldType.TEXT, label: label });
            f.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            return f;
        }

        function addHidden(form, id, value) {
            const f = form.addField({ id: id, type: serverWidget.FieldType.TEXT, label: id });
            f.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            f.defaultValue = value;
            return f;
        }

        function escapeHtml(s) {
            return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        return { onRequest: onRequest };

    });
