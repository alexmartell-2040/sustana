/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */

/**
 * SUST_UE_ItemReceipt_CreateSettlement.js
 *
 * v2.3 (June 2026): LINE-SCOPED, CONDITIONAL settlement auto-creation.
 *
 * Behavior change from v1/v2 (which created ONE settlement per IR aggregating all
 * scrap lines, always):
 *   - One settlement record PER scrap line (line-level model).
 *   - CONDITIONAL: a line auto-creates a settlement only when its pricing timing is
 *     "known by receipt" (Known at PO / Determined on Arrival). Lines priced
 *     "Determined After Processing" (recovered) are DEFERRED — the user creates the
 *     settlement on demand via the Manage Line Settlements button once outputs are
 *     known (operator-discretion requirement from design).
 *   - Per-line pricing timing read from custcol_sust_pricing_timing, falling back to the
 *     header custbody_sust_pricing_timing.
 *   - Creation delegated to SUST_Lib_SettlementCreate (shared with the line-picker Suitelet).
 *
 * Dedup: skips a line that already has a settlement; skips the whole IR if its source
 * PO already carries settlements (i.e. the user pre-settled from the PO) to avoid
 * duplicates with the settle-before-receipt path.
 *
 * NOTE (cross-document line identity): source line key is the IR line's lineuniquekey.
 * PO-created and IR-created settlements for the same physical line are deduped at the
 * PO level (coarse) in v2.3; precise cross-document line pairing is a follow-up that
 * needs runtime validation of orderline/lineuniquekey behavior on this account.
 */

define(['N/record', 'N/search', 'N/runtime', 'N/log', './SUST_Lib_SettlementCreate', './SUST_Lib_Config'],
    function(record, search, runtime, log, settlementLib, configLib) {
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


        function afterSubmit(context) {
            try {
                if (context.type !== context.UserEventType.CREATE &&
                    context.type !== context.UserEventType.EDIT) {
                    return;
                }

                const itemReceiptId = context.newRecord.id;
                const itemReceipt = record.load({
                    type: record.Type.ITEM_RECEIPT, id: itemReceiptId, isDynamic: false
                });

                // Subsidiary gate (script param or configured demo subsidiaries)
                const subsidiaryId = itemReceipt.getValue({ fieldId: 'subsidiary' });
                if (!subsidiaryAllowed(subsidiaryId, 'custscript_sust_subsidiary_id')) {
                    return;
                }

                const vendorId = itemReceipt.getValue({ fieldId: 'entity' });
                if (!vendorId) {
                    log.error('No Vendor', 'Item Receipt has no vendor - cannot create settlement');
                    return;
                }
                const tranDate = itemReceipt.getValue({ fieldId: 'trandate' });
                const poId = itemReceipt.getValue({ fieldId: 'createdfrom' }) || null;
                const headerTiming = itemReceipt.getText({ fieldId: 'custbody_sust_pricing_timing' }) || '';

                // Avoid duplicating settle-before-receipt: skip IR auto-create only when the
                // source PO carries a PRE-RECEIPT settlement (linked to the PO but to no Item
                // Receipt) — i.e. the user settled from the PO directly. Settlements created by
                // an EARLIER receipt against this PO are IR-linked and must NOT suppress
                // auto-create on a later partial receipt (each receipt settles its own lines).
                if (poId && poHasPreReceiptSettlements(poId)) {
                    log.audit('Skip IR Auto-Create',
                        `Source PO ${poId} has a settle-before-receipt settlement - deferring to that/on-demand creation to avoid duplicates.`);
                    return;
                }

                const lineCount = itemReceipt.getLineCount({ sublistId: 'item' });
                let created = 0, deferred = 0;

                for (let i = 0; i < lineCount; i++) {
                    const itemId = itemReceipt.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });

                    const isScrap = settlementLib.lookupItemField(itemId, 'custitem_sust_is_scrap_material');
                    if (isScrap !== true && isScrap !== 'T') {
                        continue;
                    }

                    // Per-line pricing timing (fallback to header)
                    let lineTiming = itemReceipt.getSublistText({ sublistId: 'item', fieldId: 'custcol_sust_pricing_timing', line: i }) || '';
                    if (!lineTiming) lineTiming = headerTiming;

                    // Recovered (price known only after processing) → defer to on-demand button
                    if (isRecoveredTiming(lineTiming)) {
                        deferred++;
                        log.audit('Settlement Deferred',
                            `IR ${itemReceiptId} line ${i + 1} (item ${itemId}) timing "${lineTiming}" is recovery-priced - settlement deferred to Manage Line Settlements.`);
                        continue;
                    }

                    // Stable, context-independent line key: the 1-based sublist index.
                    // lineuniquekey resolves inconsistently between afterSubmit-load and
                    // beforeLoad-view, so the display UE could never reliably match it (v2.3 fix).
                    const lineKey = i + 1;

                    // Per-line dedup
                    const existing = settlementLib.findExistingLineSettlement({
                        itemReceiptId: itemReceiptId, poId: poId, sourceLine: lineKey
                    });
                    if (existing) {
                        log.debug('Line Settlement Exists', `IR ${itemReceiptId} line ${i + 1} already has settlement ${existing}`);
                        continue;
                    }

                    // Gather this line's lots
                    const lineInfo = getLineLotDetails(itemReceipt, i);
                    if (!lineInfo.lotDetails.length || lineInfo.grossWeight <= 0) {
                        log.debug('No Lots On Line', `IR ${itemReceiptId} line ${i + 1} has no lot detail - skipping`);
                        continue;
                    }

                    // Yield from item; lot link from first lot
                    const firstLot = lineInfo.lotDetails[0];
                    let recoveryPct = 100;
                    const itemRecovery = settlementLib.lookupItemField(itemId, 'custitem_sust_typical_recovery');
                    if (itemRecovery) recoveryPct = parseFloat(itemRecovery) || 100;
                    const lotInternalId = settlementLib.resolveLotInternalId(firstLot.lotNumber);

                    // Cadence-aware: Per-Receipt vendors get a settlement per line;
                    // Weekly/Monthly vendors roll into one draft settlement per period.
                    const result = settlementLib.createOrAppendLineSettlement({
                        vendorId: vendorId,
                        tranDate: tranDate,
                        poId: poId,
                        itemReceiptId: itemReceiptId,
                        sourceLine: lineKey,
                        itemId: itemId,
                        grossWeight: lineInfo.grossWeight,
                        recoveryPct: recoveryPct,
                        lotInternalId: lotInternalId,
                        lotDetails: lineInfo.lotDetails,
                        sourceTag: `Item Receipt #${itemReceiptId} line ${i + 1}`
                    });
                    if (result.action !== 'skipped') created++;
                    if (result.periodKey) {
                        log.audit('Aggregated Settlement',
                            `IR ${itemReceiptId} line ${i + 1} ${result.action} on ${result.cadence} settlement ${result.id} (period ${result.periodKey})`);
                    }
                }

                log.audit('IR Settlement Auto-Create Complete',
                    `IR ${itemReceiptId}: ${created} settlement(s) created, ${deferred} deferred (recovery-priced).`);

            } catch (e) {
                log.error('Error in afterSubmit', e.toString() + '\n' + (e.stack || ''));
            }
        }

        /**
         * Is this pricing-timing recovery-based (price known only after processing)?
         */
        function isRecoveredTiming(timingText) {
            return !!timingText && timingText.indexOf('After Processing') !== -1;
        }

        /**
         * Does the source PO carry a PRE-RECEIPT settlement — one linked to the PO but to
         * no Item Receipt (the settle-before-receipt path)? Settlements created by an earlier
         * receipt against this PO are IR-linked and are intentionally excluded, so a later
         * partial receipt still auto-creates its own line settlements.
         */
        function poHasPreReceiptSettlements(poId) {
            try {
                const s = search.create({
                    type: 'customrecord_sust_settlement_record',
                    filters: [
                        ['custrecord_sust_settle_po', 'anyof', poId],
                        'AND', ['custrecord_sust_settlement_item_receipt', 'anyof', '@NONE@']
                    ],
                    columns: ['internalid']
                });
                return s.run().getRange({ start: 0, end: 1 }).length > 0;
            } catch (e) {
                log.error('poHasPreReceiptSettlements', e.toString());
                return false;
            }
        }

        /**
         * Collect lot detail + gross weight for a single IR item line.
         */
        function getLineLotDetails(itemReceipt, lineIndex) {
            const lotDetails = [];
            let grossWeight = 0;
            try {
                const itemId = itemReceipt.getSublistValue({ sublistId: 'item', fieldId: 'item', line: lineIndex });
                const invDetail = itemReceipt.getSublistSubrecord({
                    sublistId: 'item', fieldId: 'inventorydetail', line: lineIndex
                });
                if (invDetail) {
                    const invLineCount = invDetail.getLineCount({ sublistId: 'inventoryassignment' });
                    for (let j = 0; j < invLineCount; j++) {
                        let lotNumber = invDetail.getSublistValue({
                            sublistId: 'inventoryassignment', fieldId: 'receiptinventorynumber', line: j
                        });
                        if (!lotNumber) {
                            const invNumId = invDetail.getSublistValue({
                                sublistId: 'inventoryassignment', fieldId: 'inventorynumber', line: j
                            });
                            if (invNumId) {
                                const lk = search.lookupFields({ type: 'inventorynumber', id: invNumId, columns: ['inventorynumber'] });
                                lotNumber = lk.inventorynumber;
                            }
                        }
                        const lotQty = invDetail.getSublistValue({
                            sublistId: 'inventoryassignment', fieldId: 'quantity', line: j
                        });
                        if (lotNumber && lotQty) {
                            grossWeight += parseFloat(lotQty);
                            lotDetails.push({ itemId: itemId, lotNumber: lotNumber, quantity: lotQty });
                        }
                    }
                }
            } catch (e) {
                log.error('getLineLotDetails', `Line ${lineIndex}, Error: ${e.toString()}`);
            }
            return { lotDetails: lotDetails, grossWeight: grossWeight };
        }

        return { afterSubmit: afterSubmit };

    });
