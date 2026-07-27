/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */

/**
 * SUST_SL_RegradeLot.js
 *
 * Inspection & Regrade (demo script 5.3, 8:00 AM): reclassify received
 * material to a different grade ITEM (e.g. White Ledger -> Mixed Office
 * Paper) while preserving the transaction history.
 *
 * Why an item change and not a flag: in recovered fiber the grade IS the
 * commodity — different market index, settlement schedule, valuation, and
 * demand. A lot-level flag would leave the GL, the supplier payable, and the
 * position report all telling the WL story for MOP material.
 *
 * What one submission does:
 *   1. Inventory Adjustment: OUT old-grade lot / IN new-grade item under the
 *      SAME lot number, unit cost carried (item average cost) — valuation
 *      moves, history preserved (the receipt is untouched).
 *   2. New lot initialized: quality attributes copied from the original,
 *      regrade audit line (user / date-time / old -> new grade / reason).
 *   3. Old lot annotated with the same audit line; genealogy row (Grade
 *      Transformation) links original lot -> regraded lot.
 *   4. Supplier settlement re-priced against the vendor + NEW grade schedule
 *      when still Draft/Completed (before/after noted). Provisional Paid /
 *      Final Settled settlements are NOT touched — an audit note flags that
 *      a vendor credit / true-up is required.
 *
 * GET params: ir=<item receipt id> (lists that receipt's lots) or lot=<id>.
 *
 * Author: MHI
 * Date: July 2026
 */

define(['N/ui/serverWidget', 'N/record', 'N/search', 'N/runtime', 'N/url', 'N/redirect', 'N/log',
        './SUST_Lib_Config', './SUST_Lib_LotAttributes', './SUST_Lib_SettlementCreate'],
    function(serverWidget, record, search, runtime, url, redirect, log, configLib, lotAttr, settlementLib) {

        const BRAND = '#2976F3';

        function onRequest(context) {
            try {
                if (context.request.method === 'GET') {
                    renderForm(context);
                } else {
                    processRegrade(context);
                }
            } catch (e) {
                log.error('SUST_SL_RegradeLot failed', e.message + '\n' + (e.stack || ''));
                context.response.write(resultPage('&#9888; Regrade failed', esc(e.message), [], '#dc2626'));
            }
        }

        // ───────────────────────────────────────────────────────────────────────
        // GET — the regrade form
        // ───────────────────────────────────────────────────────────────────────

        function renderForm(context) {
            const irId = context.request.parameters.ir || context.request.parameters.itemreceiptid || '';
            const lotParam = context.request.parameters.lot || '';

            const form = serverWidget.createForm({ title: 'Sustana Recovery — Inspection & Regrade' });

            const banner = form.addField({ id: 'custpage_banner', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            banner.defaultValue = ''
                + '<div style="border:2px solid ' + BRAND + '; background:#eaf2ff; color:#0d2a52; padding:14px 16px;'
                + ' margin:8px 0; border-radius:6px; font-family:Arial,sans-serif; font-size:13px; line-height:1.5;">'
                + '<b>Controlled regrade.</b> Reclassifies the selected lot to a different grade item under the same lot number: '
                + 'inventory + valuation move via an Inventory Adjustment, quality attributes carry over, genealogy links back to the '
                + 'original receipt, and the supplier settlement is re-priced on the new grade\'s schedule (or flagged for a vendor '
                + 'credit if already paid). The original receipt transaction is never modified.</div>';

            // Lot picker — from the IR when given, else all on-hand lots
            const lotField = form.addField({
                id: 'custpage_lot', type: serverWidget.FieldType.SELECT, label: 'Lot to Regrade'
            });
            lotField.isMandatory = true;
            const lots = candidateLots(irId);
            lotField.addSelectOption({ value: '', text: '' });
            lots.forEach(function(l) {
                lotField.addSelectOption({
                    value: String(l.id),
                    text: l.number + ' — ' + l.itemName + ' (' + commas(l.qty) + ' lbs on hand)',
                    isSelected: String(l.id) === String(lotParam)
                });
            });

            // New grade — scrap material items
            const gradeField = form.addField({
                id: 'custpage_new_item', type: serverWidget.FieldType.SELECT, label: 'New Grade (item)'
            });
            gradeField.isMandatory = true;
            gradeField.addSelectOption({ value: '', text: '' });
            scrapItems().forEach(function(it) {
                gradeField.addSelectOption({ value: String(it.id), text: it.name });
            });
            gradeField.setHelpText({
                help: 'The grade the inspector determined the material actually is. The lot moves to this item; '
                    + 'pricing, valuation, and reporting follow the new grade.'
            });

            const reasonField = form.addField({
                id: 'custpage_reason', type: serverWidget.FieldType.TEXTAREA, label: 'Regrade Reason'
            });
            reasonField.isMandatory = true;
            reasonField.setHelpText({ help: 'Recorded with your name and timestamp on both lots — this is the inspection audit trail.' });

            const irField = form.addField({
                id: 'custpage_ir', type: serverWidget.FieldType.TEXT, label: 'Item Receipt ID'
            });
            irField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            irField.defaultValue = String(irId || '');

            form.addSubmitButton({ label: 'Regrade Lot' });
            context.response.writePage(form);
        }

        /** Lots to offer: the IR's lots (qty > 0) when ir given, else all on-hand. */
        function candidateLots(irId) {
            const numbers = irId ? lotNumbersOnReceipt(irId) : null;
            const rows = [];
            try {
                const filters = [['quantityonhand', 'greaterthan', 0]];
                search.create({
                    type: 'inventorynumber',
                    filters: filters,
                    columns: ['inventorynumber', 'item', 'quantityonhand', 'location']
                }).run().each(function(r) {
                    const num = r.getValue({ name: 'inventorynumber' });
                    if (numbers && numbers.indexOf(num) === -1) return true;
                    rows.push({
                        id: r.id,
                        number: num,
                        itemId: r.getValue({ name: 'item' }),
                        itemName: r.getText({ name: 'item' }) || '',
                        qty: parseFloat(r.getValue({ name: 'quantityonhand' })) || 0,
                        locationId: r.getValue({ name: 'location' }) || null
                    });
                    return true;
                });
            } catch (e) {
                log.error('candidateLots', e.message);
            }
            rows.sort(function(a, b) { return a.number < b.number ? -1 : 1; });
            return rows;
        }

        /** Lot numbers present on an Item Receipt's inventory details. */
        function lotNumbersOnReceipt(irId) {
            const numbers = [];
            try {
                const ir = record.load({ type: record.Type.ITEM_RECEIPT, id: parseInt(irId, 10) });
                const lineCount = ir.getLineCount({ sublistId: 'item' });
                for (let i = 0; i < lineCount; i++) {
                    try {
                        const detail = ir.getSublistSubrecord({ sublistId: 'item', fieldId: 'inventorydetail', line: i });
                        const rows = detail.getLineCount({ sublistId: 'inventoryassignment' });
                        for (let j = 0; j < rows; j++) {
                            const num = detail.getSublistText({ sublistId: 'inventoryassignment', fieldId: 'receiptinventorynumber', line: j })
                                || detail.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'receiptinventorynumber', line: j });
                            if (num && numbers.indexOf(String(num)) === -1) numbers.push(String(num));
                        }
                    } catch (eLine) { /* line without detail */ }
                }
            } catch (e) {
                log.error('lotNumbersOnReceipt', irId + ': ' + e.message);
            }
            return numbers;
        }

        /** Active scrap-material items (the grade universe). */
        function scrapItems() {
            const rows = [];
            try {
                search.create({
                    type: 'item',
                    filters: [
                        ['custitem_sust_is_scrap_material', 'is', 'T'], 'AND',
                        ['isinactive', 'is', 'F']
                    ],
                    columns: ['itemid']
                }).run().each(function(r) {
                    rows.push({ id: r.id, name: r.getValue({ name: 'itemid' }) });
                    return true;
                });
            } catch (e) {
                log.error('scrapItems', e.message);
            }
            return rows;
        }

        // ───────────────────────────────────────────────────────────────────────
        // POST — perform the regrade
        // ───────────────────────────────────────────────────────────────────────

        function processRegrade(context) {
            const p = context.request.parameters;
            const lotId = parseInt(p.custpage_lot, 10);
            const newItemId = parseInt(p.custpage_new_item, 10);
            const reason = (p.custpage_reason || '').trim();
            const irId = p.custpage_ir ? parseInt(p.custpage_ir, 10) : null;

            if (!lotId || !newItemId || !reason) {
                throw new Error('Lot, new grade, and reason are all required.');
            }

            // 1. Old lot facts
            const lot = lotFacts(lotId);
            if (!lot) throw new Error('Lot ' + lotId + ' not found.');
            if (String(lot.itemId) === String(newItemId)) {
                throw new Error('Lot ' + lot.number + ' is already ' + lot.itemName + ' — pick a different grade.');
            }
            if (!(lot.qty > 0)) throw new Error('Lot ' + lot.number + ' has no on-hand quantity to regrade.');

            const newItemName = itemName(newItemId);
            const who = runtime.getCurrentUser().name || ('user ' + runtime.getCurrentUser().id);
            const stamp = new Date().toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
            const auditLine = '[REGRADE ' + stamp + ' by ' + who + '] ' + lot.itemName + ' -> ' + newItemName
                + ' (' + commas(lot.qty) + ' lbs, lot ' + lot.number + '). Reason: ' + reason;

            // Capture quality BEFORE the IA — after it, two lots share the number
            // and a number-based lookup would be ambiguous.
            const oldQuality = lotAttr.readLotQuality(lot.number);

            // 2. Inventory Adjustment — OUT old grade, IN new grade, same lot number
            const links = [];
            const unitCost = itemAvgCost(lot.itemId);
            const iaId = createRegradeIA(lot, newItemId, unitCost);
            links.push({ label: 'Inventory Adjustment (valuation move)', recordType: 'inventoryadjustment', id: iaId });

            // 3. New lot: copy quality + audit; old lot: audit note
            const newLotId = resolveLotIdForItem(lot.number, newItemId);
            if (newLotId) {
                lotAttr.writeLotQuality(newLotId, Object.assign({}, oldQuality, {
                    vendorLot: oldQuality.vendorLot,
                    notesAppend: auditLine + ' [Original receipt preserved' + (irId ? (': IR ' + irId) : '') + ']'
                }));
                links.push({ label: 'Regraded lot ' + lot.number + ' (' + newItemName + ')', recordType: 'inventorynumber', id: newLotId });
            }
            try {
                const oldNotes = search.lookupFields({
                    type: 'inventorynumber', id: lot.id, columns: ['custitemnumber_sust_lot_notes']
                }).custitemnumber_sust_lot_notes || '';
                record.submitFields({
                    type: 'inventorynumber', id: lot.id,
                    values: { custitemnumber_sust_lot_notes: (oldNotes ? oldNotes + '\n' : '') + auditLine }
                });
            } catch (eNote) { log.debug('old lot note skipped', eNote.message); }
            links.push({ label: 'Original lot ' + lot.number + ' (' + lot.itemName + ', consumed)', recordType: 'inventorynumber', id: lot.id });

            // 4. Genealogy: original lot -> regraded lot
            if (newLotId) {
                try {
                    const gen = record.create({ type: 'customrecord_sust_lot_relationship' });
                    gen.setValue({ fieldId: 'custrecord_sust_parent_lot', value: lot.id });
                    gen.setValue({ fieldId: 'custrecord_sust_child_lot', value: newLotId });
                    gen.setText({ fieldId: 'custrecord_sust_relationship_type', text: 'Grade Transformation' });
                    gen.setValue({ fieldId: 'custrecord_sust_qty_consumed', value: lot.qty });
                    gen.setValue({ fieldId: 'custrecord_sust_contribution_pct', value: 100 });
                    gen.save();
                } catch (eGen) { log.error('regrade genealogy', eGen.message); }
            }

            // 5. Settlement impact
            const settleNote = repriceSettlement(lot, newItemId, newItemName, auditLine, links);

            const summary = ''
                + '<p><b>' + esc(lot.itemName) + ' &rarr; ' + esc(newItemName) + '</b> — '
                + commas(lot.qty) + ' lbs under lot <b>' + esc(lot.number) + '</b>.</p>'
                + '<p>Quality attributes carried over; audit line stamped on both lots (user, date/time, reason); '
                + 'genealogy links the regraded lot to the original receipt.</p>'
                + (settleNote ? '<p>' + settleNote + '</p>' : '');
            context.response.write(resultPage('&#9989; Regrade complete', summary, links, '#16a34a', irId));
        }

        function lotFacts(lotId) {
            try {
                const res = search.create({
                    type: 'inventorynumber',
                    filters: [['internalid', 'anyof', lotId]],
                    columns: ['inventorynumber', 'item', 'quantityonhand', 'location']
                }).run().getRange({ start: 0, end: 1 });
                if (!res.length) return null;
                const r = res[0];
                return {
                    id: parseInt(r.id, 10),
                    number: r.getValue({ name: 'inventorynumber' }),
                    itemId: r.getValue({ name: 'item' }),
                    itemName: r.getText({ name: 'item' }) || ('Item ' + r.getValue({ name: 'item' })),
                    qty: parseFloat(r.getValue({ name: 'quantityonhand' })) || 0,
                    locationId: r.getValue({ name: 'location' }) || null
                };
            } catch (e) {
                log.error('lotFacts', e.message);
                return null;
            }
        }

        function itemName(itemId) {
            try {
                const lk = search.lookupFields({ type: search.Type.ITEM, id: itemId, columns: ['itemid'] });
                return lk.itemid || ('Item ' + itemId);
            } catch (e) { return 'Item ' + itemId; }
        }

        function itemAvgCost(itemId) {
            try {
                const lk = search.lookupFields({ type: search.Type.ITEM, id: itemId, columns: ['averagecost'] });
                return parseFloat(lk.averagecost) || 0;
            } catch (e) { return 0; }
        }

        /**
         * IA: line 0 consumes the old-grade lot; line 1 creates the same lot
         * number on the new grade item at the carried unit cost. Mirrors the
         * Processing IA pattern (header field order matters).
         */
        function createRegradeIA(lot, newItemId, unitCost) {
            const cfg = configLib.getConfig();
            const acctId = cfg.invAdjAccount;
            const subId = cfg.usSubsidiary;
            if (!acctId || !subId) {
                throw new Error('Sustana Config is missing the Inventory Adjustment account or US subsidiary — run the demo seeder first.');
            }
            const location = lot.locationId || cfg.defaultLocation;
            if (!location) throw new Error('No location on lot ' + lot.number + ' and no default location configured.');

            const ia = record.create({ type: record.Type.INVENTORY_ADJUSTMENT, isDynamic: false });
            ia.setValue({ fieldId: 'trandate', value: new Date() });
            ia.setValue({ fieldId: 'subsidiary', value: parseInt(subId, 10) });
            ia.setValue({ fieldId: 'adjlocation', value: parseInt(location, 10) });
            ia.setValue({ fieldId: 'account', value: parseInt(acctId, 10) });
            ia.setValue({ fieldId: 'memo', value: 'Regrade: ' + lot.itemName + ' -> item ' + newItemId + ', lot ' + lot.number });

            // OUT — old grade
            ia.setSublistValue({ sublistId: 'inventory', fieldId: 'item', line: 0, value: lot.itemId });
            ia.setSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', line: 0, value: -lot.qty });
            ia.setSublistValue({ sublistId: 'inventory', fieldId: 'location', line: 0, value: parseInt(location, 10) });
            const outDetail = ia.getSublistSubrecord({ sublistId: 'inventory', fieldId: 'inventorydetail', line: 0 });
            outDetail.setSublistValue({ sublistId: 'inventoryassignment', fieldId: 'issueinventorynumber', line: 0, value: lot.id });
            outDetail.setSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', line: 0, value: -Math.abs(lot.qty) });

            // IN — new grade, same lot number, carried cost
            ia.setSublistValue({ sublistId: 'inventory', fieldId: 'item', line: 1, value: newItemId });
            ia.setSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', line: 1, value: lot.qty });
            ia.setSublistValue({ sublistId: 'inventory', fieldId: 'location', line: 1, value: parseInt(location, 10) });
            if (unitCost > 0) {
                try { ia.setSublistValue({ sublistId: 'inventory', fieldId: 'unitcost', line: 1, value: unitCost }); }
                catch (eCost) { log.debug('unitcost skipped', eCost.message); }
            }
            const inDetail = ia.getSublistSubrecord({ sublistId: 'inventory', fieldId: 'inventorydetail', line: 1 });
            inDetail.setSublistValue({ sublistId: 'inventoryassignment', fieldId: 'receiptinventorynumber', line: 0, value: lot.number });
            inDetail.setSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', line: 0, value: lot.qty });

            const iaId = ia.save();
            log.audit('Regrade IA', 'IA ' + iaId + ': ' + lot.qty + ' lbs lot ' + lot.number
                + ' item ' + lot.itemId + ' -> ' + newItemId + ' @ $' + unitCost.toFixed(4) + '/lb');
            return iaId;
        }

        /** The regraded lot: same number, new item (created by the IA). */
        function resolveLotIdForItem(lotNumber, itemId) {
            try {
                const res = search.create({
                    type: 'inventorynumber',
                    filters: [
                        ['inventorynumber', 'is', lotNumber], 'AND',
                        ['item', 'anyof', itemId]
                    ],
                    columns: ['internalid']
                }).run().getRange({ start: 0, end: 1 });
                return res.length ? parseInt(res[0].id, 10) : null;
            } catch (e) {
                log.error('resolveLotIdForItem', e.message);
                return null;
            }
        }

        /**
         * Re-price the settlement linked to this lot against the vendor + new
         * grade schedule — but only while still Draft/Completed. Paid
         * settlements get an audit note demanding a vendor credit instead.
         * @returns {string} HTML note for the result page
         */
        function repriceSettlement(lot, newItemId, newItemName, auditLine, links) {
            try {
                const res = search.create({
                    type: 'customrecord_sust_settlement_record',
                    filters: [['custrecord_sust_settlement_lot', 'anyof', lot.id]],
                    columns: ['custrecord_sust_settlement_status', 'custrecord_sust_settlement_vendor',
                        'custrecord_sust_settlement_net_lbs', 'custrecord_sust_settlement_recovery_pct',
                        'custrecord_sust_settlement_net_value']
                }).run().getRange({ start: 0, end: 1 });
                if (!res.length) return 'No supplier settlement is linked to this lot — nothing to re-price.';

                const s = res[0];
                const settleId = parseInt(s.id, 10);
                const status = s.getText({ name: 'custrecord_sust_settlement_status' }) || '';
                const vendorId = s.getValue({ name: 'custrecord_sust_settlement_vendor' });
                const netLbs = parseFloat(s.getValue({ name: 'custrecord_sust_settlement_net_lbs' })) || 0;
                const recovery = parseFloat(s.getValue({ name: 'custrecord_sust_settlement_recovery_pct' })) || 100;
                const oldValue = parseFloat(s.getValue({ name: 'custrecord_sust_settlement_net_value' })) || 0;
                links.push({ label: 'Supplier settlement (' + status + ')', recordType: 'customrecord_sust_settlement_record', id: settleId });

                if (status !== 'Draft' && status !== 'Completed') {
                    appendSettlementNote(settleId, auditLine
                        + ' — SETTLEMENT ALREADY ' + status.toUpperCase()
                        + ': re-pricing NOT applied. Issue a vendor credit / true-up for the grade difference.');
                    return '&#9888; Settlement is already <b>' + esc(status) + '</b> — it was NOT re-priced. '
                        + 'An audit note was added; issue a vendor credit for the grade difference.';
                }

                const schedule = settlementLib.findSettlementSchedule(vendorId, newItemId);
                if (!schedule) {
                    appendSettlementNote(settleId, auditLine + ' — no settlement schedule found for the new grade; re-price manually.');
                    return '&#9888; No settlement schedule exists for this vendor + ' + esc(newItemName)
                        + ' — settlement left unchanged with an audit note. Create the schedule and use Calculate Settlement.';
                }

                const calc = settlementLib.computeScheduleValue(schedule, netLbs, recovery);
                const values = {
                    custrecord_sust_settlement_net_value: calc.netValue,
                    custrecord_sust_settlement_balance_due: calc.netValue
                };
                if (schedule.scheduleId) values.custrecord_sust_settlement_schedule = parseInt(schedule.scheduleId, 10);
                if (calc.marketPrice !== null) values.custrecord_sust_settlement_market_price = calc.marketPrice;
                if (calc.marketRefId !== null) values.custrecord_sust_settlement_market_source = calc.marketRefId;
                record.submitFields({ type: 'customrecord_sust_settlement_record', id: settleId, values: values });
                appendSettlementNote(settleId, auditLine
                    + ' — re-priced on the ' + newItemName + ' schedule: $' + oldValue.toFixed(2)
                    + ' -> $' + calc.netValue.toFixed(2) + '.');

                return 'Settlement re-priced on the <b>' + esc(newItemName) + '</b> schedule: '
                    + '<b>$' + oldValue.toFixed(2) + ' &rarr; $' + calc.netValue.toFixed(2) + '</b> (before/after noted on the record).';
            } catch (e) {
                log.error('repriceSettlement', e.message);
                return '&#9888; Settlement re-pricing failed (' + esc(e.message) + ') — re-price manually via Calculate Settlement.';
            }
        }

        function appendSettlementNote(settleId, line) {
            try {
                const notes = search.lookupFields({
                    type: 'customrecord_sust_settlement_record', id: settleId,
                    columns: ['custrecord_sust_settlement_notes']
                }).custrecord_sust_settlement_notes || '';
                record.submitFields({
                    type: 'customrecord_sust_settlement_record', id: settleId,
                    values: { custrecord_sust_settlement_notes: (notes ? notes + '\n' : '') + line }
                });
            } catch (e) { log.debug('appendSettlementNote skipped', e.message); }
        }

        // ───────────────────────────────────────────────────────────────────────
        // Result page
        // ───────────────────────────────────────────────────────────────────────

        function resultPage(title, bodyHtml, links, color, irId) {
            const linkRows = (links || []).map(function(l) {
                let href = '#';
                try { href = url.resolveRecord({ recordType: l.recordType, recordId: l.id }); } catch (e) { /* keep # */ }
                return '<li style="margin:4px 0;"><a href="' + href + '" style="color:' + BRAND + ';">' + l.label + '</a></li>';
            }).join('');
            let backIr = '';
            if (irId) {
                try {
                    backIr = '<a href="' + url.resolveRecord({ recordType: 'itemreceipt', recordId: irId }) + '"'
                        + ' style="display:inline-block;margin-top:14px;padding:8px 16px;background:' + BRAND + ';color:#fff;'
                        + 'text-decoration:none;border-radius:4px;font-weight:600;">&#8592; Back to Item Receipt</a>';
                } catch (e) { /* no link */ }
            }
            return '<html><body style="font-family:Arial,sans-serif;max-width:680px;margin:60px auto;color:#111827;">'
                + '<div style="border:2px solid ' + color + ';border-radius:8px;padding:20px 24px;">'
                + '<h2 style="margin:0 0 10px;color:' + color + ';font-size:18px;">' + title + '</h2>'
                + '<div style="font-size:14px;line-height:1.6;">' + bodyHtml + '</div>'
                + (linkRows ? '<div style="font-weight:bold;margin-top:10px;">Records:</div><ul style="margin:4px 0 0 18px;padding:0;">' + linkRows + '</ul>' : '')
                + backIr
                + '</div></body></html>';
        }

        function commas(n) {
            return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        }

        function esc(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
        }

        return { onRequest: onRequest };
    });
