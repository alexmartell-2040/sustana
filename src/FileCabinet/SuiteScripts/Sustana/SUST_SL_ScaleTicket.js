/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */

/**
 * SUST_SL_ScaleTicket.js
 *
 * The scale kiosk — this Suitelet IS the scale system for the demo
 * (7:00 manual receiving / 7:30 "integrated scale" moments).
 *
 * GET  ?          : blank kiosk form (next TRK-nnn suggested, timestamps default now)
 * GET  ?ticket=id : edit an existing ticket (corrections / re-sync weights to the IR)
 * POST            : create (or update) the scale ticket; when an open PO is selected,
 *                   transform PO -> Item Receipt with:
 *                     - line quantity = net lbs
 *                     - gross/net weight columns populated
 *                     - lot number = the ticket number (scale ticket = the lot)
 *                     - custbody_sust_scale_ticket = the ticket
 *                   The existing UE chain (landed cost -> auto line settlement ->
 *                   vendor-lot bridge) fires on the IR save untouched: ticket in,
 *                   AP-ready receipt out, zero re-keying.
 *
 * Duplicate guard: a second submit with the same ticket number is blocked with a
 * link to the existing ticket (Sustana's duplicate-ticket requirement).
 * Outage fallback: the Phase-1 manual Item Receipt path is unchanged.
 *
 * Author: MHI
 * Date: July 2026
 */

define(['N/ui/serverWidget', 'N/record', 'N/search', 'N/runtime', 'N/url', 'N/log', './SUST_Lib_Units', './SUST_Lib_LotAttributes'],
    function(serverWidget, record, search, runtime, url, log, units, lotAttr) {

        const TICKET_TYPE = 'customrecord_sust_scale_ticket';
        const F = Object.freeze({
            NUMBER: 'custrecord_sust_st_ticket_number',
            TRUCK: 'custrecord_sust_st_truck',
            VENDOR: 'custrecord_sust_st_vendor',
            PO: 'custrecord_sust_st_po',
            GROSS: 'custrecord_sust_st_gross_lbs',
            TARE: 'custrecord_sust_st_tare_lbs',
            NET: 'custrecord_sust_st_net_lbs',
            WEIGH_IN: 'custrecord_sust_st_weigh_in',
            WEIGH_OUT: 'custrecord_sust_st_weigh_out',
            LOCATION: 'custrecord_sust_st_location',
            IR: 'custrecord_sust_st_item_receipt',
            STATUS: 'custrecord_sust_st_status',
            NOTES: 'custrecord_sust_st_notes'
        });

        function onRequest(context) {
            try {
                if (context.request.method === 'GET') {
                    renderForm(context);
                } else {
                    handlePost(context);
                }
            } catch (e) {
                log.error('SUST_SL_ScaleTicket failed', e.message + '\n' + (e.stack || ''));
                context.response.write('<h2>Scale Ticket error</h2><pre>' +
                    String(e.message).replace(/[<>]/g, '') + '</pre>');
            }
        }

        // ───────────────────────────────────────────────────────────────────
        // GET — kiosk form
        // ───────────────────────────────────────────────────────────────────

        function renderForm(context) {
            const editTicketId = context.request.parameters.ticket || '';
            let existing = null;
            if (editTicketId) {
                existing = record.load({ type: TICKET_TYPE, id: editTicketId });
            }

            const form = serverWidget.createForm({
                title: existing
                    ? 'Sustana Recovery — Scale Ticket ' + existing.getValue({ fieldId: F.NUMBER }) + ' (Correction)'
                    : 'Sustana Recovery — Scale Kiosk'
            });
            form.clientScriptModulePath = './SUST_CS_ScaleTicket.js';

            // Round-trip context (DISABLED, not HIDDEN — hidden fields don't reliably POST)
            const idField = form.addField({
                id: 'custpage_ticket_id', type: serverWidget.FieldType.TEXT, label: 'Ticket Internal ID'
            });
            idField.defaultValue = editTicketId;
            idField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });

            const gate = form.addFieldGroup({ id: 'grp_gate', label: 'Gate / Truck' });
            const weights = form.addFieldGroup({ id: 'grp_weights', label: 'Weights' });
            const receiving = form.addFieldGroup({ id: 'grp_receiving', label: 'Receiving' });

            const ticketField = form.addField({
                id: 'custpage_ticket_number', type: serverWidget.FieldType.TEXT,
                label: 'Ticket Number', container: 'grp_gate'
            });
            ticketField.isMandatory = true;
            ticketField.defaultValue = existing
                ? existing.getValue({ fieldId: F.NUMBER })
                : suggestNextTicketNumber();
            if (existing) {
                ticketField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            }

            const truckField = form.addField({
                id: 'custpage_truck', type: serverWidget.FieldType.TEXT,
                label: 'Truck #', container: 'grp_gate'
            });
            if (existing) truckField.defaultValue = existing.getValue({ fieldId: F.TRUCK });

            const vendorField = form.addField({
                id: 'custpage_vendor', type: serverWidget.FieldType.SELECT,
                label: 'Supplier', source: 'vendor', container: 'grp_gate'
            });
            vendorField.isMandatory = true;
            if (existing) vendorField.defaultValue = existing.getValue({ fieldId: F.VENDOR });

            // Open-PO dropdown: populated server-side for the selected vendor; the
            // client script reloads the page with ?vendor= when the supplier changes.
            const vendorParam = context.request.parameters.vendor ||
                (existing ? existing.getValue({ fieldId: F.VENDOR }) : '');
            if (vendorParam && !existing) vendorField.defaultValue = vendorParam;

            const poField = form.addField({
                id: 'custpage_po', type: serverWidget.FieldType.SELECT,
                label: 'Open Purchase Order', container: 'grp_gate'
            });
            poField.addSelectOption({ value: '', text: '' });
            if (vendorParam) {
                findOpenPOs(vendorParam).forEach(function(po) {
                    poField.addSelectOption({ value: po.id, text: po.text });
                });
            }
            if (existing) poField.defaultValue = existing.getValue({ fieldId: F.PO });
            poField.setHelpText({
                help: 'Open POs for the selected supplier. Leave blank for a ticket-only weigh (manual Item Receipt later — the outage fallback).'
            });

            const grossField = form.addField({
                id: 'custpage_gross', type: serverWidget.FieldType.FLOAT,
                label: 'Gross Weight (lbs)', container: 'grp_weights'
            });
            grossField.isMandatory = true;
            const tareField = form.addField({
                id: 'custpage_tare', type: serverWidget.FieldType.FLOAT,
                label: 'Tare Weight (lbs)', container: 'grp_weights'
            });
            tareField.isMandatory = true;
            const netField = form.addField({
                id: 'custpage_net', type: serverWidget.FieldType.FLOAT,
                label: 'Net Weight (lbs)', container: 'grp_weights'
            });
            netField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            if (existing) {
                grossField.defaultValue = existing.getValue({ fieldId: F.GROSS });
                tareField.defaultValue = existing.getValue({ fieldId: F.TARE });
                netField.defaultValue = existing.getValue({ fieldId: F.NET });
            }

            const weighIn = form.addField({
                id: 'custpage_weigh_in', type: serverWidget.FieldType.DATETIMETZ,
                label: 'Weigh-In Time', container: 'grp_weights'
            });
            const weighOut = form.addField({
                id: 'custpage_weigh_out', type: serverWidget.FieldType.DATETIMETZ,
                label: 'Weigh-Out Time', container: 'grp_weights'
            });
            if (existing) {
                weighIn.defaultValue = existing.getValue({ fieldId: F.WEIGH_IN });
                weighOut.defaultValue = existing.getValue({ fieldId: F.WEIGH_OUT });
            } else {
                weighIn.defaultValue = new Date();
                weighOut.defaultValue = new Date();
            }

            const locField = form.addField({
                id: 'custpage_location', type: serverWidget.FieldType.SELECT,
                label: 'Receiving Location', source: 'location', container: 'grp_receiving'
            });
            if (existing) locField.defaultValue = existing.getValue({ fieldId: F.LOCATION });

            const notesField = form.addField({
                id: 'custpage_notes', type: serverWidget.FieldType.TEXTAREA,
                label: 'Gate Notes', container: 'grp_receiving'
            });
            if (existing) notesField.defaultValue = existing.getValue({ fieldId: F.NOTES });

            // ── Lot Quality (captured at the scale, pushed to the lot record on save) ──
            // Lot number = ticket number, so these write straight onto that lot via
            // SUST_Lib_LotAttributes. Pre-populated from the lot on the correction path.
            const quality = form.addFieldGroup({ id: 'grp_quality', label: 'Lot Quality (pushed to the lot record)' });
            const existingQuality = existing
                ? lotAttr.readLotQuality(existing.getValue({ fieldId: F.NUMBER }))
                : {};
            const moistureField = form.addField({
                id: 'custpage_moisture', type: serverWidget.FieldType.FLOAT,
                label: 'Moisture %', container: 'grp_quality'
            });
            const contaminationField = form.addField({
                id: 'custpage_contamination', type: serverWidget.FieldType.FLOAT,
                label: 'Contamination %', container: 'grp_quality'
            });
            const fiberField = form.addField({
                id: 'custpage_fiber', type: serverWidget.FieldType.FLOAT,
                label: 'Fiber Content %', container: 'grp_quality'
            });
            const baleField = form.addField({
                id: 'custpage_bales', type: serverWidget.FieldType.INTEGER,
                label: 'Bale Count', container: 'grp_quality'
            });
            const vendorLotField = form.addField({
                id: 'custpage_vendor_lot', type: serverWidget.FieldType.TEXT,
                label: 'Vendor Lot #', container: 'grp_quality'
            });
            const lotNotesField = form.addField({
                id: 'custpage_lot_notes', type: serverWidget.FieldType.TEXTAREA,
                label: 'Lot Quality Notes', container: 'grp_quality'
            });
            moistureField.setHelpText({ help: 'Optional. Captured at the scale and written to the lot; high moisture/contamination drive supplier settlement penalties and the yard exception flags.' });
            baleField.setHelpText({ help: 'Best practice: leave blank to auto-derive (net lbs / grade standard bale weight). A keyed count more than 20% off the derived value is flagged on the lot for verification.' });
            if (existingQuality.moisture !== undefined) moistureField.defaultValue = existingQuality.moisture;
            if (existingQuality.contamination !== undefined) contaminationField.defaultValue = existingQuality.contamination;
            if (existingQuality.fiber !== undefined) fiberField.defaultValue = existingQuality.fiber;
            if (existingQuality.baleCount !== undefined) baleField.defaultValue = existingQuality.baleCount;
            if (existingQuality.vendorLot !== undefined) vendorLotField.defaultValue = existingQuality.vendorLot;

            if (existing && existing.getValue({ fieldId: F.IR })) {
                const note = form.addField({
                    id: 'custpage_resync_note', type: serverWidget.FieldType.INLINEHTML, label: ' '
                });
                note.defaultValue =
                    '<div style="padding:8px 12px;background:#fef9c3;border-left:4px solid #ca8a04;font-family:Arial;font-size:12px;">' +
                    'This ticket already created Item Receipt #' + escapeHtml(String(existing.getValue({ fieldId: F.IR }))) +
                    '. Saving corrections re-syncs the weights to the receipt, and the settlement recalculates from the receipt automation.' +
                    '</div>';
            }

            form.addSubmitButton({
                label: existing ? 'Update Ticket & Re-sync Receipt' : 'Create Ticket & Receive'
            });
            context.response.writePage(form);
        }

        /** Next TRK-nnn based on the highest existing ticket number. */
        function suggestNextTicketNumber() {
            try {
                let maxNum = 0;
                search.create({
                    type: TICKET_TYPE,
                    filters: [[F.NUMBER, 'startswith', 'TRK-']],
                    columns: [F.NUMBER]
                }).run().each(function(r) {
                    const m = String(r.getValue(F.NUMBER)).match(/^TRK-(\d+)$/);
                    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
                    return true;
                });
                return 'TRK-' + String(maxNum + 1).padStart(3, '0');
            } catch (e) {
                return 'TRK-001';
            }
        }

        /** Open (receivable) POs for a vendor. */
        function findOpenPOs(vendorId) {
            const out = [];
            try {
                search.create({
                    type: search.Type.PURCHASE_ORDER,
                    filters: [
                        ['entity', 'anyof', vendorId],
                        'AND', ['mainline', 'is', 'T'],
                        'AND', ['status', 'anyof', 'PurchOrd:B', 'PurchOrd:D', 'PurchOrd:E']
                        // B=Pending Receipt, D=Partially Received, E=Pending Billing/Partially Received
                    ],
                    columns: ['tranid', 'trandate']
                }).run().each(function(r) {
                    out.push({ id: r.id, text: 'PO #' + r.getValue('tranid') + ' (' + r.getValue('trandate') + ')' });
                    return true;
                });
            } catch (e) {
                log.error('findOpenPOs', e.message);
            }
            return out;
        }

        // ───────────────────────────────────────────────────────────────────
        // POST — create/update ticket, transform PO -> IR
        // ───────────────────────────────────────────────────────────────────

        function handlePost(context) {
            const p = context.request.parameters;
            const ticketId = p.custpage_ticket_id || '';
            const ticketNumber = (p.custpage_ticket_number || '').trim();
            const gross = parseFloat(p.custpage_gross || 0);
            const tare = parseFloat(p.custpage_tare || 0);
            const net = Math.round((gross - tare) * 100) / 100;

            if (!ticketNumber) return renderMessage(context, 'error', 'Ticket number is required.', null);
            if (!(gross > 0) || !(tare >= 0) || !(net > 0)) {
                return renderMessage(context, 'error',
                    'Weights invalid: gross must exceed tare (gross ' + gross + ' / tare ' + tare + ').', null);
            }

            // Duplicate-ticket guard (create only)
            if (!ticketId) {
                const dupId = findTicketByNumber(ticketNumber);
                if (dupId) {
                    return renderMessage(context, 'warning',
                        'Duplicate ticket: "' + escapeHtml(ticketNumber) + '" already exists. ' +
                        'No new ticket was created and nothing was received.',
                        [{ label: 'Open existing ticket ' + escapeHtml(ticketNumber), href: recordUrl(TICKET_TYPE, dupId) },
                         { label: 'Back to kiosk', href: kioskUrl() }]);
                }
            }

            // Create or load the ticket
            const ticket = ticketId
                ? record.load({ type: TICKET_TYPE, id: ticketId })
                : record.create({ type: TICKET_TYPE });

            ticket.setValue({ fieldId: 'name', value: ticketNumber });
            ticket.setValue({ fieldId: F.NUMBER, value: ticketNumber });
            ticket.setValue({ fieldId: F.TRUCK, value: p.custpage_truck || '' });
            if (p.custpage_vendor) ticket.setValue({ fieldId: F.VENDOR, value: parseInt(p.custpage_vendor) });
            if (p.custpage_po) ticket.setValue({ fieldId: F.PO, value: parseInt(p.custpage_po) });
            ticket.setValue({ fieldId: F.GROSS, value: gross });
            ticket.setValue({ fieldId: F.TARE, value: tare });
            ticket.setValue({ fieldId: F.NET, value: net });
            if (p.custpage_weigh_in) ticket.setValue({ fieldId: F.WEIGH_IN, value: new Date(p.custpage_weigh_in) });
            if (p.custpage_weigh_out) ticket.setValue({ fieldId: F.WEIGH_OUT, value: new Date(p.custpage_weigh_out) });
            if (p.custpage_location) ticket.setValue({ fieldId: F.LOCATION, value: parseInt(p.custpage_location) });
            ticket.setValue({ fieldId: F.NOTES, value: p.custpage_notes || '' });

            const existingIrId = ticketId ? ticket.getValue({ fieldId: F.IR }) : null;
            if (!existingIrId) ticket.setText({ fieldId: F.STATUS, text: p.custpage_po ? 'Open' : 'Weighed Out' });
            const savedTicketId = ticket.save();

            const links = [{ label: 'Scale Ticket ' + escapeHtml(ticketNumber), href: recordUrl(TICKET_TYPE, savedTicketId) }];

            let irId = existingIrId;
            try {
                if (existingIrId) {
                    // Correction path: re-sync weights to the existing IR
                    resyncWeightsToIR(existingIrId, gross, net);
                    links.push({ label: 'Item Receipt (weights re-synced)', href: '/app/accounting/transactions/itemrcpt.nl?id=' + existingIrId });
                } else if (p.custpage_po) {
                    // Receive: transform PO -> IR with weights + lot = ticket number
                    irId = receiveAgainstPO(p.custpage_po, {
                        ticketId: savedTicketId,
                        ticketNumber: ticketNumber,
                        gross: gross,
                        net: net,
                        locationId: p.custpage_location ? parseInt(p.custpage_location) : null
                    });
                    record.submitFields({
                        type: TICKET_TYPE, id: savedTicketId,
                        values: (function() {
                            const v = {}; v[F.IR] = irId; return v;
                        })()
                    });
                    const t2 = record.load({ type: TICKET_TYPE, id: savedTicketId });
                    t2.setText({ fieldId: F.STATUS, text: 'Received' });
                    t2.save();
                    links.push({ label: 'Item Receipt (auto-created)', href: '/app/accounting/transactions/itemrcpt.nl?id=' + irId });
                }
            } catch (irErr) {
                log.error('Scale ticket receive failed', irErr.message + '\n' + (irErr.stack || ''));
                return renderMessage(context, 'error',
                    'Ticket ' + escapeHtml(ticketNumber) + ' was saved, but receiving failed: ' + escapeHtml(irErr.message) +
                    '. Use the manual Item Receipt path (outage fallback), or correct the ticket and retry.',
                    links.concat([{ label: 'Back to kiosk', href: kioskUrl() }]));
            }

            // Push captured lot-quality onto the lot record (lot number = ticket number).
            // Only when the operator actually entered quality, so an empty capture doesn't
            // silently advance the lot's status.
            const capturedQuality = [p.custpage_moisture, p.custpage_contamination, p.custpage_fiber,
                p.custpage_bales, p.custpage_vendor_lot, p.custpage_lot_notes]
                .some(function(v) { return v !== undefined && v !== null && String(v).trim() !== ''; });
            if (irId && capturedQuality) {
                const notes = (p.custpage_lot_notes || '').trim();
                // Bale-count best practice: bales = net lbs / grade standard bale weight.
                // Blank -> auto-derived; keyed count >20% off the derived value -> variance note.
                const baleInfo = deriveBaleCount(ticketNumber, net, p.custpage_bales);
                let notesLine = notes ? ('[Kiosk ' + new Date().toISOString().substring(0, 10) + ', ticket ' + ticketNumber + '] ' + notes) : '';
                if (baleInfo.note) notesLine = notesLine ? (notesLine + '\n' + baleInfo.note) : baleInfo.note;
                const lotWrite = lotAttr.writeLotQuality(ticketNumber, {
                    moisture: p.custpage_moisture,
                    contamination: p.custpage_contamination,
                    fiber: p.custpage_fiber,
                    baleCount: baleInfo.baleCount,
                    vendorLot: p.custpage_vendor_lot,
                    notesAppend: notesLine || null
                });
                if (lotWrite && lotWrite.ok) {
                    links.push({
                        label: 'Lot ' + escapeHtml(ticketNumber) + ' quality captured (' + escapeHtml((lotWrite.applied || []).join(', ') || 'status → Yard') + ')',
                        href: '/app/common/search/searchresults.nl?searchtype=InvtNumber&IT_Number=' + encodeURIComponent(ticketNumber)
                    });
                } else if (lotWrite && !lotWrite.ok) {
                    log.error('Kiosk lot-quality write failed', ticketNumber + ': ' + lotWrite.error);
                }
            }

            // Settlement created by the IR UE chain (if any)
            if (irId) {
                const settlementId = findSettlementForIR(irId);
                if (settlementId) {
                    links.push({
                        label: 'Supplier Settlement (auto-created by the receipt)',
                        href: recordUrl('customrecord_sust_settlement_record', settlementId)
                    });
                }
                links.push({
                    label: 'Lot ' + escapeHtml(ticketNumber) + ' (scale ticket = the lot)',
                    href: '/app/common/search/searchresults.nl?searchtype=InvtNumber&IT_Number=' + encodeURIComponent(ticketNumber)
                });
            }
            links.push({ label: 'New ticket', href: kioskUrl() });

            const summary = irId
                ? 'Ticket in, AP-ready receipt out — zero re-keying. Net ' + net.toLocaleString() + ' lbs (' + units.formatTons(net) + ') received.'
                : 'Ticket recorded (' + net.toLocaleString() + ' lbs / ' + units.formatTons(net) + '). No PO selected — receive manually when ready (outage fallback).';

            renderMessage(context, 'success',
                (existingIrId ? 'Ticket corrected. ' : 'Scale ticket ' + escapeHtml(ticketNumber) + ' saved. ') + summary,
                links);
        }

        /**
         * Transform PO -> Item Receipt: quantity = net lbs on the first receivable
         * line, weight columns + scale-ticket link set, lot number = ticket number.
         * The IR save fires the receipt UE chain (landed cost, settlement, bridge).
         */
        function receiveAgainstPO(poId, opts) {
            const ir = record.transform({
                fromType: record.Type.PURCHASE_ORDER,
                fromId: parseInt(poId),
                toType: record.Type.ITEM_RECEIPT,
                isDynamic: false
            });

            ir.setValue({ fieldId: 'custbody_sust_scale_ticket', value: opts.ticketId });

            const lineCount = ir.getLineCount({ sublistId: 'item' });
            let receivedLine = -1;
            for (let i = 0; i < lineCount; i++) {
                if (receivedLine === -1) {
                    receivedLine = i;
                    ir.setSublistValue({ sublistId: 'item', fieldId: 'itemreceive', line: i, value: true });
                    ir.setSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i, value: opts.net });
                    if (opts.locationId) {
                        ir.setSublistValue({ sublistId: 'item', fieldId: 'location', line: i, value: opts.locationId });
                    }
                    ir.setSublistValue({ sublistId: 'item', fieldId: 'custcol_sust_scrap_gross_weight', line: i, value: opts.gross });
                    ir.setSublistValue({ sublistId: 'item', fieldId: 'custcol_sust_scrap_net_weight', line: i, value: opts.net });

                    // Lot-numbered item: lot number = the scale ticket number
                    try {
                        const detail = ir.getSublistSubrecord({ sublistId: 'item', fieldId: 'inventorydetail', line: i });
                        detail.setSublistValue({
                            sublistId: 'inventoryassignment', fieldId: 'receiptinventorynumber',
                            line: 0, value: opts.ticketNumber
                        });
                        detail.setSublistValue({
                            sublistId: 'inventoryassignment', fieldId: 'quantity',
                            line: 0, value: opts.net
                        });
                    } catch (lotErr) {
                        // Non-lot item — fine, receive without inventory detail
                        log.debug('No inventory detail on line', lotErr.message);
                    }
                } else {
                    ir.setSublistValue({ sublistId: 'item', fieldId: 'itemreceive', line: i, value: false });
                }
            }
            if (receivedLine === -1) throw new Error('The selected PO has no receivable lines.');

            return ir.save();
        }

        /** Correction path: push corrected weights to the linked IR (UE chain recalculates). */
        function resyncWeightsToIR(irId, gross, net) {
            const ir = record.load({ type: record.Type.ITEM_RECEIPT, id: irId, isDynamic: false });
            const lineCount = ir.getLineCount({ sublistId: 'item' });
            for (let i = 0; i < lineCount; i++) {
                const hasWeights = ir.getSublistValue({ sublistId: 'item', fieldId: 'custcol_sust_scrap_net_weight', line: i });
                if (!hasWeights && lineCount > 1) continue; // only touch the weighed line on multi-line IRs
                ir.setSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i, value: net });
                ir.setSublistValue({ sublistId: 'item', fieldId: 'custcol_sust_scrap_gross_weight', line: i, value: gross });
                ir.setSublistValue({ sublistId: 'item', fieldId: 'custcol_sust_scrap_net_weight', line: i, value: net });
                try {
                    const detail = ir.getSublistSubrecord({ sublistId: 'item', fieldId: 'inventorydetail', line: i });
                    detail.setSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', line: 0, value: net });
                } catch (lotErr) {
                    log.debug('Re-sync: no inventory detail on line ' + (i + 1), lotErr.message);
                }
                break;
            }
            ir.save();
        }

        function findTicketByNumber(ticketNumber) {
            let found = null;
            try {
                search.create({
                    type: TICKET_TYPE,
                    filters: [[F.NUMBER, 'is', ticketNumber]],
                    columns: ['internalid']
                }).run().each(function(r) { found = r.id; return false; });
            } catch (e) {
                log.error('findTicketByNumber', e.message);
            }
            return found;
        }

        function findSettlementForIR(irId) {
            let found = null;
            try {
                search.create({
                    type: 'customrecord_sust_settlement_record',
                    filters: [['custrecord_sust_settlement_item_receipt', 'anyof', irId]],
                    columns: ['internalid']
                }).run().each(function(r) { found = r.id; return false; });
            } catch (e) {
                log.debug('findSettlementForIR', e.message);
            }
            return found;
        }

        // ───────────────────────────────────────────────────────────────────
        // Rendering helpers
        // ───────────────────────────────────────────────────────────────────

        function kioskUrl() {
            return url.resolveScript({
                scriptId: runtime.getCurrentScript().id,
                deploymentId: runtime.getCurrentScript().deploymentId
            });
        }

        function recordUrl(type, id) {
            try {
                return url.resolveRecord({ recordType: type, recordId: id });
            } catch (e) {
                return '#';
            }
        }

        function renderMessage(context, kind, messageHtml, links) {
            const colors = {
                success: ['#059669', '#d1fae5', '✓'],
                warning: ['#ca8a04', '#fef9c3', '⚠'],
                error: ['#dc2626', '#fee2e2', '✗']
            }[kind] || ['#334155', '#f1f5f9', 'ℹ'];
            let html = ''
                + '<div style="font-family: Arial, sans-serif; padding: 24px; max-width: 680px; margin: 32px auto;">'
                + '  <div style="border: 2px solid ' + colors[0] + '; background: ' + colors[1] + '; padding: 16px 20px; border-radius: 6px;">'
                + '    <div style="font-size: 18px; font-weight: bold; color: ' + colors[0] + ';">' + colors[2] + ' Scale Kiosk</div>'
                + '    <div style="font-size: 14px; color: #1f2937; margin-top: 8px;">' + messageHtml + '</div>'
                + '  </div>';
            if (links && links.length) {
                html += '<ul style="margin-top: 16px; font-size: 14px;">';
                links.forEach(function(l) {
                    html += '<li style="margin: 6px 0;"><a href="' + l.href + '">' + l.label + '</a></li>';
                });
                html += '</ul>';
            }
            html += '</div>';
            context.response.write(html);
        }

        /**
         * Bale-count best practice: bales = net lbs / grade standard bale weight
         * (custitem_sust_std_bale_lbs). Blank entry auto-derives; a keyed count
         * deviating >20% from the derived value gets a variance audit note.
         * @returns {Object} { baleCount, note|null }
         */
        function deriveBaleCount(lotNumber, netLbs, entered) {
            const out = { baleCount: entered, note: null };
            try {
                const lotId = lotAttr.resolveLotId(lotNumber);
                if (!lotId || !(netLbs > 0)) return out;
                const lk = search.lookupFields({ type: 'inventorynumber', id: lotId, columns: ['item'] });
                const itemId = Array.isArray(lk.item) && lk.item.length ? lk.item[0].value : null;
                if (!itemId) return out;
                const itemLk = search.lookupFields({ type: search.Type.ITEM, id: itemId, columns: ['custitem_sust_std_bale_lbs'] });
                const std = parseFloat(itemLk.custitem_sust_std_bale_lbs) || 0;
                if (!(std > 0)) return out;
                const derived = Math.max(1, Math.round(netLbs / std));
                const enteredNum = parseInt(entered, 10);
                if (!enteredNum || isNaN(enteredNum)) {
                    out.baleCount = derived;
                    out.note = '[Bale count auto-derived] ' + derived + ' bales = ' + Math.round(netLbs)
                        + ' net lbs / ' + std + ' lbs std bale.';
                } else if (Math.abs(enteredNum - derived) / derived > 0.2) {
                    out.note = '[BALE VARIANCE] keyed ' + enteredNum + ' vs derived ' + derived
                        + ' (' + Math.round(netLbs) + ' lbs / ' + std + ' std) — verify count or grade.';
                }
            } catch (e) {
                log.debug('deriveBaleCount skipped', e.message);
            }
            return out;
        }

        function escapeHtml(s) {
            return String(s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        return { onRequest: onRequest };
    });
