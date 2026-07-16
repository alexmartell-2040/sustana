/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 * @description Shipping Matrix Suitelet — consolidated shipment management, multi-pallet weight capture, BOL generation
 */
define(['N/ui/serverWidget', 'N/record', 'N/search', 'N/log', 'N/runtime', 'N/url', 'N/redirect', 'N/render', './SUST_Lib_Units'],
    (serverWidget, record, search, log, runtime, url, redirect, render, units) => {

        // ── Entry Point ────────────────────────────────────────────────────

        const onRequest = (context) => {
            try {
                if (context.request.method === 'GET') {
                    handleGet(context);
                } else {
                    handlePost(context);
                }
            } catch (e) {
                log.error('onRequest', { error: e.message, stack: e.stack });
                context.response.write(`<html><body><h2>Error</h2><p>${e.message}</p></body></html>`);
            }
        };

        // ── GET Handler ────────────────────────────────────────────────────

        const handleGet = (context) => {
            const params = context.request.parameters;
            const mode = params.mode || 'list';

            if (mode === 'detail' && params.csid) {
                renderDetailMode(context, parseInt(params.csid, 10), params.msg || '');
            } else if (mode === 'new') {
                renderNewShipmentForm(context);
            } else if (mode === 'bol' && params.csid) {
                renderBOL(context, parseInt(params.csid, 10));
            } else {
                renderListMode(context, params.msg || '');
            }
        };

        // ── POST Handler ───────────────────────────────────────────────────

        const handlePost = (context) => {
            const params = context.request.parameters;
            const action = params.custpage_action;

            log.debug('handlePost', { action, params: JSON.stringify(params) });

            switch (action) {
                case 'create_shipment':
                    handleCreateShipment(context, params);
                    return;
                case 'save_pallets':
                    handleSavePallets(context, params);
                    return;
                case 'mark_shipped':
                    handleMarkShipped(context, params);
                    return;
                case 'cancel_shipment':
                    handleCancelShipment(context, params);
                    return;
                default:
                    log.audit('handlePost', 'Unknown action: ' + action);
                    redirectToList(context, '');
            }
        };

        // ── LIST MODE — All Consolidated Shipments ─────────────────────────

        const renderListMode = (context, message) => {
            const form = serverWidget.createForm({
                title: 'Sustana Recovery — Shipping Matrix'
            });
            form.clientScriptModulePath = './SUST_CS_ShippingMatrix.js';

            addResponsiveStyles(form);

            // Success/info message
            if (message) {
                const msgField = form.addField({
                    id: 'custpage_message',
                    type: serverWidget.FieldType.INLINEHTML,
                    label: ' '
                });
                msgField.defaultValue = `<div style="background:#d4edda;border:1px solid #c3e6cb;color:#155724;padding:12px;border-radius:4px;margin-bottom:16px;font-size:14px;">${message}</div>`;
            }

            // New Shipment button
            form.addButton({
                id: 'custpage_btn_new',
                label: 'New Consolidated Shipment',
                functionName: 'doAction_newShipment'
            });

            // Shipment list
            const sublist = form.addSublist({
                id: 'custpage_shipments',
                type: serverWidget.SublistType.LIST,
                label: 'Consolidated Shipments'
            });

            sublist.addField({ id: 'custpage_cs_date',     type: serverWidget.FieldType.TEXT,     label: 'Ship Date' });
            sublist.addField({ id: 'custpage_cs_bol',      type: serverWidget.FieldType.TEXT,     label: 'BOL #' });
            sublist.addField({ id: 'custpage_cs_carrier',   type: serverWidget.FieldType.TEXT,     label: 'Carrier' });
            sublist.addField({ id: 'custpage_cs_pallets',   type: serverWidget.FieldType.TEXT,     label: 'Pallets' });
            sublist.addField({ id: 'custpage_cs_weight',    type: serverWidget.FieldType.TEXT,     label: 'Total Weight (lbs)' });
            sublist.addField({ id: 'custpage_cs_fulfills',  type: serverWidget.FieldType.TEXT,     label: 'Fulfillments' });
            sublist.addField({ id: 'custpage_cs_status',    type: serverWidget.FieldType.TEXT,     label: 'Status' });
            sublist.addField({ id: 'custpage_cs_actions',   type: serverWidget.FieldType.TEXTAREA, label: 'Actions' });

            const shipments = searchConsolidatedShipments();

            shipments.forEach((cs, i) => {
                sublist.setSublistValue({ id: 'custpage_cs_date',     line: i, value: cs.shipDate || '-' });
                sublist.setSublistValue({ id: 'custpage_cs_bol',      line: i, value: cs.bolNumber || '-' });
                sublist.setSublistValue({ id: 'custpage_cs_carrier',  line: i, value: cs.carrier || '-' });
                sublist.setSublistValue({ id: 'custpage_cs_pallets',  line: i, value: String(cs.totalPallets || 0) });
                // Weight is stored in lbs; tons shown alongside for readability
                const weightLbs = parseFloat(cs.totalWeight) || 0;
                sublist.setSublistValue({ id: 'custpage_cs_weight',   line: i, value: `${weightLbs} (${units.formatTons(weightLbs)})` });
                sublist.setSublistValue({ id: 'custpage_cs_fulfills', line: i, value: String(cs.fulfillmentCount || 0) });
                sublist.setSublistValue({ id: 'custpage_cs_status',   line: i, value: cs.status });

                const detailUrl = buildSuiteletUrl({ mode: 'detail', csid: cs.id });
                const bolUrl = buildSuiteletUrl({ mode: 'bol', csid: cs.id });
                let actions = `<a href="${detailUrl}" style="padding:6px 12px;background:#0073e6;color:#fff;border-radius:4px;text-decoration:none;font-weight:bold;margin-right:8px;">Edit Pallets</a>`;
                if (cs.status !== 'Cancelled') {
                    actions += `<a href="${bolUrl}" target="_blank" style="padding:6px 12px;background:#28a745;color:#fff;border-radius:4px;text-decoration:none;font-weight:bold;">Print BOL</a>`;
                }
                sublist.setSublistValue({ id: 'custpage_cs_actions', line: i, value: actions });
            });

            context.response.writePage(form);
        };

        // ── NEW SHIPMENT FORM ──────────────────────────────────────────────

        const renderNewShipmentForm = (context) => {
            const form = serverWidget.createForm({
                title: 'Sustana Recovery — New Consolidated Shipment'
            });
            form.clientScriptModulePath = './SUST_CS_ShippingMatrix.js';

            addResponsiveStyles(form);

            // Hidden action
            const actionField = form.addField({ id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action' });
            actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            actionField.defaultValue = 'create_shipment';

            // Header fields
            const headerGroup = form.addFieldGroup({ id: 'grp_header', label: 'Shipment Details' });

            const shipDate = form.addField({
                id: 'custpage_ship_date',
                type: serverWidget.FieldType.DATE,
                label: 'Ship Date',
                container: 'grp_header'
            });
            shipDate.isMandatory = true;
            shipDate.defaultValue = new Date();

            const carrier = form.addField({
                id: 'custpage_carrier',
                type: serverWidget.FieldType.TEXT,
                label: 'Carrier',
                container: 'grp_header'
            });

            const bolNumber = form.addField({
                id: 'custpage_bol_number',
                type: serverWidget.FieldType.TEXT,
                label: 'BOL Number',
                container: 'grp_header'
            });

            const notes = form.addField({
                id: 'custpage_notes',
                type: serverWidget.FieldType.TEXTAREA,
                label: 'Notes',
                container: 'grp_header'
            });

            // Available fulfillments to link
            const ffGroup = form.addFieldGroup({ id: 'grp_fulfillments', label: 'Link Item Fulfillments' });

            const fulfillments = searchUnlinkedFulfillments();
            const ffSublist = form.addSublist({
                id: 'custpage_avail_ff',
                type: serverWidget.SublistType.INLINEEDITOR,
                label: 'Available Fulfillments'
            });

            ffSublist.addField({ id: 'custpage_ff_select', type: serverWidget.FieldType.CHECKBOX, label: 'Select' });
            const ffIdField = ffSublist.addField({ id: 'custpage_ff_id', type: serverWidget.FieldType.TEXT, label: 'IF ID' });
            ffIdField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            const ffDocField = ffSublist.addField({ id: 'custpage_ff_doc', type: serverWidget.FieldType.TEXT, label: 'Document #' });
            ffDocField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            const ffCustField = ffSublist.addField({ id: 'custpage_ff_customer', type: serverWidget.FieldType.TEXT, label: 'Customer' });
            ffCustField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            const ffDateField = ffSublist.addField({ id: 'custpage_ff_date', type: serverWidget.FieldType.TEXT, label: 'Ship Date' });
            ffDateField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            const ffItemsField = ffSublist.addField({ id: 'custpage_ff_items', type: serverWidget.FieldType.TEXT, label: 'Items' });
            ffItemsField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });

            fulfillments.forEach((ff, i) => {
                ffSublist.setSublistValue({ id: 'custpage_ff_select',   line: i, value: 'F' });
                ffSublist.setSublistValue({ id: 'custpage_ff_id',       line: i, value: String(ff.id) });
                ffSublist.setSublistValue({ id: 'custpage_ff_doc',      line: i, value: ff.docNumber });
                ffSublist.setSublistValue({ id: 'custpage_ff_customer', line: i, value: ff.customer });
                ffSublist.setSublistValue({ id: 'custpage_ff_date',     line: i, value: ff.shipDate });
                ffSublist.setSublistValue({ id: 'custpage_ff_items',    line: i, value: ff.items });
            });

            form.addSubmitButton({ label: 'Create Consolidated Shipment' });
            form.addButton({ id: 'custpage_btn_cancel', label: 'Cancel', functionName: 'doAction_backToList' });

            context.response.writePage(form);
        };

        // ── DETAIL MODE — Pallet Entry Grid ────────────────────────────────

        const renderDetailMode = (context, csId, message) => {
            const csRec = record.load({ type: 'customrecord_sust_consol_ship', id: csId });
            const bolNumber = csRec.getValue('custrecord_sust_cs_bol_number') || '';
            const carrier = csRec.getValue('custrecord_sust_cs_carrier') || '';
            const shipDate = csRec.getValue('custrecord_sust_cs_ship_date');
            const status = csRec.getText('custrecord_sust_cs_status');
            const isOpen = (status === 'Open');

            const form = serverWidget.createForm({
                title: `Sustana Recovery — Shipping Matrix — BOL: ${bolNumber || '(No BOL)'}`
            });
            form.clientScriptModulePath = './SUST_CS_ShippingMatrix.js';

            addResponsiveStyles(form);

            // Message
            if (message) {
                const msgField = form.addField({
                    id: 'custpage_message',
                    type: serverWidget.FieldType.INLINEHTML,
                    label: ' '
                });
                msgField.defaultValue = `<div style="background:#d4edda;border:1px solid #c3e6cb;color:#155724;padding:12px;border-radius:4px;margin-bottom:16px;font-size:14px;">${message}</div>`;
            }

            // Hidden fields
            const hiddenCsId = form.addField({ id: 'custpage_cs_id', type: serverWidget.FieldType.TEXT, label: 'CS ID' });
            hiddenCsId.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            hiddenCsId.defaultValue = String(csId);

            const hiddenAction = form.addField({ id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action' });
            hiddenAction.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            hiddenAction.defaultValue = 'save_pallets';

            // ── Shipment Header ─────────────────────────────────────────
            const headerGroup = form.addFieldGroup({ id: 'grp_header', label: 'Consolidated Shipment' });

            addDisplayField(form, 'custpage_disp_bol',     'BOL Number',  bolNumber || '-',     'grp_header');
            addDisplayField(form, 'custpage_disp_carrier',  'Carrier',     carrier || '-',       'grp_header');
            addDisplayField(form, 'custpage_disp_date',     'Ship Date',   shipDate ? String(shipDate).substring(0, 10) : '-', 'grp_header');
            addDisplayField(form, 'custpage_disp_status',   'Status',      status,               'grp_header');

            // ── Linked Fulfillments ─────────────────────────────────────
            const linkedFFs = searchLinkedFulfillments(csId);
            if (linkedFFs.length > 0) {
                const ffSub = form.addSublist({
                    id: 'custpage_linked_ff',
                    type: serverWidget.SublistType.LIST,
                    label: 'Linked Item Fulfillments'
                });
                ffSub.addField({ id: 'custpage_lff_doc',      type: serverWidget.FieldType.TEXT, label: 'Document #' });
                ffSub.addField({ id: 'custpage_lff_customer', type: serverWidget.FieldType.TEXT, label: 'Customer' });
                ffSub.addField({ id: 'custpage_lff_date',     type: serverWidget.FieldType.TEXT, label: 'Ship Date' });
                ffSub.addField({ id: 'custpage_lff_items',    type: serverWidget.FieldType.TEXT, label: 'Items' });

                linkedFFs.forEach((ff, i) => {
                    ffSub.setSublistValue({ id: 'custpage_lff_doc',      line: i, value: ff.docNumber });
                    ffSub.setSublistValue({ id: 'custpage_lff_customer', line: i, value: ff.customer });
                    ffSub.setSublistValue({ id: 'custpage_lff_date',     line: i, value: ff.shipDate });
                    ffSub.setSublistValue({ id: 'custpage_lff_items',    line: i, value: ff.items });
                });
            }

            // ── Pallet Grid ─────────────────────────────────────────────
            const palletSublist = form.addSublist({
                id: 'custpage_pallets',
                type: serverWidget.SublistType.INLINEEDITOR,
                label: 'Pallet Details'
            });

            // Pallet record ID (hidden for updates)
            const palletIdField = palletSublist.addField({ id: 'custpage_pal_id', type: serverWidget.FieldType.TEXT, label: 'Pallet Rec ID' });
            palletIdField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });

            palletSublist.addField({ id: 'custpage_pal_num',        type: serverWidget.FieldType.INTEGER, label: 'Pallet #' });

            // Fulfillment select — use text to show doc number
            const palFfField = palletSublist.addField({ id: 'custpage_pal_ff_id', type: serverWidget.FieldType.TEXT, label: 'Fulfillment ID' });
            palFfField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.DISABLED });
            palletSublist.addField({ id: 'custpage_pal_ff_doc',     type: serverWidget.FieldType.TEXT,    label: 'Fulfillment #' });

            palletSublist.addField({ id: 'custpage_pal_item',       type: serverWidget.FieldType.TEXT,    label: 'Item' });
            palletSublist.addField({ id: 'custpage_pal_net_wt',     type: serverWidget.FieldType.FLOAT,   label: 'Net Weight (lbs)' });
            palletSublist.addField({ id: 'custpage_pal_gross_wt',   type: serverWidget.FieldType.FLOAT,   label: 'Gross Weight (lbs)' });
            palletSublist.addField({ id: 'custpage_pal_tare_wt',    type: serverWidget.FieldType.FLOAT,   label: 'Tare Weight (lbs)' });
            palletSublist.addField({ id: 'custpage_pal_type',       type: serverWidget.FieldType.TEXT,     label: 'Pallet Type' });
            palletSublist.addField({ id: 'custpage_pal_notes',      type: serverWidget.FieldType.TEXT,     label: 'Notes' });

            // Load existing pallets
            const existingPallets = searchPalletsForShipment(csId);
            existingPallets.forEach((p, i) => {
                palletSublist.setSublistValue({ id: 'custpage_pal_id',       line: i, value: String(p.id) });
                palletSublist.setSublistValue({ id: 'custpage_pal_num',      line: i, value: String(p.palletNum) });
                palletSublist.setSublistValue({ id: 'custpage_pal_ff_id',    line: i, value: String(p.fulfillmentId || '') });
                palletSublist.setSublistValue({ id: 'custpage_pal_ff_doc',   line: i, value: p.fulfillmentDoc || '' });
                palletSublist.setSublistValue({ id: 'custpage_pal_item',     line: i, value: p.item || '' });
                if (p.netWeight) palletSublist.setSublistValue({ id: 'custpage_pal_net_wt',    line: i, value: String(p.netWeight) });
                if (p.grossWeight) palletSublist.setSublistValue({ id: 'custpage_pal_gross_wt',  line: i, value: String(p.grossWeight) });
                if (p.tareWeight) palletSublist.setSublistValue({ id: 'custpage_pal_tare_wt',   line: i, value: String(p.tareWeight) });
                palletSublist.setSublistValue({ id: 'custpage_pal_type',     line: i, value: p.palletType || '' });
                palletSublist.setSublistValue({ id: 'custpage_pal_notes',    line: i, value: p.notes || '' });
            });

            // ── Totals Display ──────────────────────────────────────────
            // Read-only summary: values stay in lbs, tons appended for display
            const totalsGroup = form.addFieldGroup({ id: 'grp_totals', label: 'Totals' });
            const totalNet = existingPallets.reduce((sum, p) => sum + (p.netWeight || 0), 0);
            const totalGross = existingPallets.reduce((sum, p) => sum + (p.grossWeight || 0), 0);
            addDisplayField(form, 'custpage_disp_total_pallets', 'Total Pallets', String(existingPallets.length), 'grp_totals');
            addDisplayField(form, 'custpage_disp_total_net',     'Total Net Weight (lbs)',
                `${Math.round(totalNet * 100) / 100} (${units.formatTons(totalNet)})`, 'grp_totals');
            addDisplayField(form, 'custpage_disp_total_gross',   'Total Gross Weight (lbs)',
                `${Math.round(totalGross * 100) / 100} (${units.formatTons(totalGross)})`, 'grp_totals');

            // ── Buttons ─────────────────────────────────────────────────
            if (isOpen) {
                form.addSubmitButton({ label: 'Save Pallets' });
                form.addButton({ id: 'custpage_btn_ship',   label: 'Mark as Shipped', functionName: 'doAction_markShipped' });
                form.addButton({ id: 'custpage_btn_cancel_ship', label: 'Cancel Shipment', functionName: 'doAction_cancelShipment' });
            }

            const bolUrl = buildSuiteletUrl({ mode: 'bol', csid: csId });
            form.addButton({ id: 'custpage_btn_bol', label: 'Print BOL', functionName: `doAction_printBOL` });
            form.addButton({ id: 'custpage_btn_back', label: 'Back to List', functionName: 'doAction_backToList' });

            // Store BOL URL for client script
            const hiddenBolUrl = form.addField({ id: 'custpage_bol_url', type: serverWidget.FieldType.TEXT, label: 'BOL URL' });
            hiddenBolUrl.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            hiddenBolUrl.defaultValue = bolUrl;

            context.response.writePage(form);
        };

        // ── BOL PDF RENDER ─────────────────────────────────────────────────

        const renderBOL = (context, csId) => {
            const csRec = record.load({ type: 'customrecord_sust_consol_ship', id: csId });
            const bolNumber = csRec.getValue('custrecord_sust_cs_bol_number') || 'N/A';
            const carrier = csRec.getValue('custrecord_sust_cs_carrier') || '';
            const shipDate = csRec.getValue('custrecord_sust_cs_ship_date');
            const notes = csRec.getValue('custrecord_sust_cs_notes') || '';

            // Get fulfillments and pallets
            const fulfillments = searchLinkedFulfillments(csId);
            const pallets = searchPalletsForShipment(csId);

            // Get customer info from first fulfillment
            let shipToName = '';
            let shipToAddress = '';
            if (fulfillments.length > 0) {
                shipToName = fulfillments[0].customer;
                try {
                    const ffRec = record.load({ type: record.Type.ITEM_FULFILLMENT, id: fulfillments[0].id });
                    shipToAddress = ffRec.getValue('shipaddress') || '';
                } catch (e) {
                    log.debug('renderBOL', 'Could not load fulfillment address: ' + e.message);
                }
            }

            const totalNet = pallets.reduce((sum, p) => sum + (p.netWeight || 0), 0);
            const totalGross = pallets.reduce((sum, p) => sum + (p.grossWeight || 0), 0);
            const soNumbers = fulfillments.map(ff => ff.docNumber).join(', ');

            // Build XML for PDF
            let palletRows = '';
            pallets.forEach(p => {
                palletRows += `<tr>
                    <td align="center">${escapeXml(String(p.palletNum))}</td>
                    <td>${escapeXml(p.fulfillmentDoc || '')}</td>
                    <td>${escapeXml(p.item || '')}</td>
                    <td align="right">${p.netWeight ? p.netWeight.toFixed(2) : ''}</td>
                    <td align="right">${p.grossWeight ? p.grossWeight.toFixed(2) : ''}</td>
                    <td align="right">${p.tareWeight ? p.tareWeight.toFixed(2) : ''}</td>
                    <td>${escapeXml(p.palletType || '')}</td>
                </tr>`;
            });

            const xml = `<?xml version="1.0"?>
<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report" "report-1.1.dtd">
<pdf>
<head>
<style type="text/css">
    body { font-family: Helvetica, sans-serif; font-size: 10pt; }
    h1 { font-size: 18pt; text-align: center; margin-bottom: 4px; }
    h2 { font-size: 12pt; margin-bottom: 8px; }
    .header-table { width: 100%; margin-bottom: 16px; }
    .header-table td { vertical-align: top; padding: 4px; }
    .label { font-weight: bold; color: #333; }
    .pallet-table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    .pallet-table th { background-color: #2c3e50; color: #fff; padding: 6px; font-size: 9pt; text-align: left; }
    .pallet-table td { border: 1px solid #ccc; padding: 4px; font-size: 9pt; }
    .totals td { font-weight: bold; border-top: 2px solid #333; }
    .signature-line { border-top: 1px solid #333; width: 250px; margin-top: 40px; }
    .footer { margin-top: 30px; }
</style>
</head>
<body>
    <h1>BILL OF LADING</h1>
    <p style="text-align:center;font-size:12pt;color:#666;">Sustana Recovery</p>

    <table class="header-table">
        <tr>
            <td width="50%">
                <span class="label">Ship From:</span><br/>
                Sustana Recovery<br/>
                (Facility Address)
            </td>
            <td width="50%">
                <span class="label">Ship To:</span><br/>
                ${escapeXml(shipToName)}<br/>
                ${escapeXml(shipToAddress.replace(/\n/g, '<br/>'))}
            </td>
        </tr>
        <tr>
            <td>
                <span class="label">BOL Number:</span> ${escapeXml(bolNumber)}<br/>
                <span class="label">Carrier:</span> ${escapeXml(carrier)}<br/>
                <span class="label">Ship Date:</span> ${shipDate ? String(shipDate).substring(0, 10) : ''}
            </td>
            <td>
                <span class="label">Fulfillment(s):</span> ${escapeXml(soNumbers)}<br/>
                <span class="label">Total Pallets:</span> ${pallets.length}<br/>
                <span class="label">Total Gross Weight:</span> ${totalGross.toFixed(2)} lbs (${units.formatTons(totalGross)})
            </td>
        </tr>
    </table>

    <h2>Pallet Details</h2>
    <table class="pallet-table">
        <tr>
            <th align="center" width="8%">Pallet #</th>
            <th width="14%">Fulfillment</th>
            <th width="22%">Item</th>
            <th align="right" width="14%">Net Wt (lbs)</th>
            <th align="right" width="14%">Gross Wt (lbs)</th>
            <th align="right" width="14%">Tare Wt (lbs)</th>
            <th width="14%">Type</th>
        </tr>
        ${palletRows}
        <tr class="totals">
            <td colspan="3" align="right">TOTALS:</td>
            <td align="right">${totalNet.toFixed(2)}</td>
            <td align="right">${totalGross.toFixed(2)}</td>
            <td></td>
            <td></td>
        </tr>
    </table>

    ${notes ? '<p><span class="label">Notes:</span> ' + escapeXml(notes) + '</p>' : ''}

    <div class="footer">
        <table width="100%">
            <tr>
                <td width="50%">
                    <p class="label">Shipper Signature:</p>
                    <div class="signature-line">&nbsp;</div>
                    <p>Date: _______________</p>
                </td>
                <td width="50%">
                    <p class="label">Carrier Signature:</p>
                    <div class="signature-line">&nbsp;</div>
                    <p>Date: _______________</p>
                </td>
            </tr>
        </table>
    </div>
</body>
</pdf>`;

            const pdfFile = render.xmlToPdf({ xmlString: xml });
            context.response.writeFile({
                file: pdfFile,
                isInline: true
            });
        };

        // ── POST Action Handlers ───────────────────────────────────────────

        const handleCreateShipment = (context, params) => {
            const shipDate = params.custpage_ship_date;
            const carrier = params.custpage_carrier || '';
            const bolNumber = params.custpage_bol_number || '';
            const notes = params.custpage_notes || '';

            // Create the consolidated shipment record
            const csRec = record.create({ type: 'customrecord_sust_consol_ship' });
            if (shipDate) csRec.setValue({ fieldId: 'custrecord_sust_cs_ship_date', value: new Date(shipDate) });
            csRec.setValue({ fieldId: 'custrecord_sust_cs_carrier', value: carrier });
            csRec.setValue({ fieldId: 'custrecord_sust_cs_bol_number', value: bolNumber });
            csRec.setValue({ fieldId: 'custrecord_sust_cs_notes', value: notes });
            csRec.setText({ fieldId: 'custrecord_sust_cs_status', text: 'Open' });
            csRec.setValue({ fieldId: 'custrecord_sust_cs_total_pallets', value: 0 });
            csRec.setValue({ fieldId: 'custrecord_sust_cs_total_weight', value: 0 });

            const csId = csRec.save();
            log.audit('handleCreateShipment', { csId });

            // Link selected fulfillments
            const lineCount = context.request.getLineCount({ group: 'custpage_avail_ff' });
            let linkedCount = 0;

            for (let i = 0; i < lineCount; i++) {
                const selected = context.request.getSublistValue({ group: 'custpage_avail_ff', name: 'custpage_ff_select', line: i });
                if (selected === 'T') {
                    const ffId = context.request.getSublistValue({ group: 'custpage_avail_ff', name: 'custpage_ff_id', line: i });
                    if (ffId) {
                        try {
                            record.submitFields({
                                type: record.Type.ITEM_FULFILLMENT,
                                id: parseInt(ffId, 10),
                                values: { custbody_sust_consol_shipment: csId }
                            });
                            linkedCount++;
                        } catch (e) {
                            log.error('handleCreateShipment', 'Failed to link FF ' + ffId + ': ' + e.message);
                        }
                    }
                }
            }

            log.audit('handleCreateShipment', { csId, linkedFulfillments: linkedCount });

            redirectToDetail(context, csId, `Consolidated shipment created. ${linkedCount} fulfillment(s) linked.`);
        };

        const handleSavePallets = (context, params) => {
            const csId = parseInt(params.custpage_cs_id, 10);
            const lineCount = context.request.getLineCount({ group: 'custpage_pallets' });

            // Track which existing pallet IDs we see — delete any that were removed
            const existingPalletIds = searchPalletsForShipment(csId).map(p => String(p.id));
            const seenPalletIds = [];
            let totalNetWt = 0;
            let totalGrossWt = 0;
            let palletCount = 0;

            for (let i = 0; i < lineCount; i++) {
                const palletNum = context.request.getSublistValue({ group: 'custpage_pallets', name: 'custpage_pal_num', line: i });
                if (!palletNum) continue;

                const palletRecId = context.request.getSublistValue({ group: 'custpage_pallets', name: 'custpage_pal_id', line: i });
                const ffId = context.request.getSublistValue({ group: 'custpage_pallets', name: 'custpage_pal_ff_id', line: i });
                const item = context.request.getSublistValue({ group: 'custpage_pallets', name: 'custpage_pal_item', line: i });
                const netWt = parseFloat(context.request.getSublistValue({ group: 'custpage_pallets', name: 'custpage_pal_net_wt', line: i })) || 0;
                const grossWt = parseFloat(context.request.getSublistValue({ group: 'custpage_pallets', name: 'custpage_pal_gross_wt', line: i })) || 0;
                const tareWt = parseFloat(context.request.getSublistValue({ group: 'custpage_pallets', name: 'custpage_pal_tare_wt', line: i })) || 0;
                const palletType = context.request.getSublistValue({ group: 'custpage_pallets', name: 'custpage_pal_type', line: i });
                const notes = context.request.getSublistValue({ group: 'custpage_pallets', name: 'custpage_pal_notes', line: i });

                let palRec;
                if (palletRecId) {
                    // Update existing
                    palRec = record.load({ type: 'customrecord_sust_ship_pallet', id: parseInt(palletRecId, 10) });
                    seenPalletIds.push(palletRecId);
                } else {
                    // Create new
                    palRec = record.create({ type: 'customrecord_sust_ship_pallet' });
                }

                palRec.setValue({ fieldId: 'custrecord_sust_sp_pallet_num', value: parseInt(palletNum, 10) });
                if (ffId) palRec.setValue({ fieldId: 'custrecord_sust_sp_fulfillment', value: parseInt(ffId, 10) });
                palRec.setValue({ fieldId: 'custrecord_sust_sp_net_weight', value: netWt });
                palRec.setValue({ fieldId: 'custrecord_sust_sp_gross_weight', value: grossWt });
                palRec.setValue({ fieldId: 'custrecord_sust_sp_tare_weight', value: tareWt });
                if (palletType) palRec.setText({ fieldId: 'custrecord_sust_sp_pallet_type', text: palletType });
                if (notes) palRec.setValue({ fieldId: 'custrecord_sust_sp_notes', value: notes });
                if (item) {
                    // Item is text — try to find by name. For now store as note if not a select.
                    // The sp_item field is a SELECT; we'd need the internal ID.
                    // Skip setting item if it's just text — user can use the NS UI for this.
                }

                palRec.save();
                totalNetWt += netWt;
                totalGrossWt += grossWt;
                palletCount++;
            }

            // Delete removed pallets
            existingPalletIds.forEach(pid => {
                if (!seenPalletIds.includes(pid)) {
                    try {
                        record.delete({ type: 'customrecord_sust_ship_pallet', id: parseInt(pid, 10) });
                    } catch (e) {
                        log.error('handleSavePallets', 'Failed to delete pallet ' + pid + ': ' + e.message);
                    }
                }
            });

            // Update totals on consolidated shipment
            record.submitFields({
                type: 'customrecord_sust_consol_ship',
                id: csId,
                values: {
                    custrecord_sust_cs_total_pallets: palletCount,
                    custrecord_sust_cs_total_weight: Math.round(totalGrossWt * 100) / 100
                }
            });

            // Also update linked fulfillments' custbody totals
            updateFulfillmentTotals(csId, palletCount, totalNetWt, totalGrossWt);

            log.audit('handleSavePallets', { csId, palletCount, totalNetWt, totalGrossWt });
            redirectToDetail(context, csId, `Saved ${palletCount} pallet(s). Totals updated.`);
        };

        const handleMarkShipped = (context, params) => {
            const csId = parseInt(params.custpage_cs_id, 10);
            record.submitFields({
                type: 'customrecord_sust_consol_ship',
                id: csId,
                values: {}
            });
            // Use setText for custom list field
            const csRec = record.load({ type: 'customrecord_sust_consol_ship', id: csId });
            csRec.setText({ fieldId: 'custrecord_sust_cs_status', text: 'Shipped' });
            csRec.save();

            log.audit('handleMarkShipped', { csId });
            redirectToDetail(context, csId, 'Shipment marked as Shipped.');
        };

        const handleCancelShipment = (context, params) => {
            const csId = parseInt(params.custpage_cs_id, 10);
            const csRec = record.load({ type: 'customrecord_sust_consol_ship', id: csId });
            csRec.setText({ fieldId: 'custrecord_sust_cs_status', text: 'Cancelled' });
            csRec.save();

            log.audit('handleCancelShipment', { csId });
            redirectToList(context, 'Shipment cancelled.');
        };

        // ── Search Helpers ─────────────────────────────────────────────────

        const searchConsolidatedShipments = () => {
            const results = [];
            search.create({
                type: 'customrecord_sust_consol_ship',
                filters: [],
                columns: [
                    search.createColumn({ name: 'custrecord_sust_cs_ship_date', sort: search.Sort.DESC }),
                    'custrecord_sust_cs_bol_number',
                    'custrecord_sust_cs_carrier',
                    'custrecord_sust_cs_total_pallets',
                    'custrecord_sust_cs_total_weight',
                    'custrecord_sust_cs_status'
                ]
            }).run().each(r => {
                // Count linked fulfillments
                let ffCount = 0;
                try {
                    const ffSearch = search.create({
                        type: search.Type.ITEM_FULFILLMENT,
                        filters: [
                            ['custbody_sust_consol_shipment', 'is', r.id],
                            'AND',
                            ['mainline', 'is', 'T']
                        ],
                        columns: ['internalid']
                    });
                    ffSearch.run().each(() => { ffCount++; return true; });
                } catch (e) { /* ignore */ }

                results.push({
                    id:             r.id,
                    shipDate:       r.getValue('custrecord_sust_cs_ship_date'),
                    bolNumber:      r.getValue('custrecord_sust_cs_bol_number'),
                    carrier:        r.getValue('custrecord_sust_cs_carrier'),
                    totalPallets:   r.getValue('custrecord_sust_cs_total_pallets'),
                    totalWeight:    r.getValue('custrecord_sust_cs_total_weight'),
                    status:         r.getText('custrecord_sust_cs_status'),
                    fulfillmentCount: ffCount
                });
                return true;
            });
            return results;
        };

        const searchUnlinkedFulfillments = () => {
            const results = [];
            try {
                search.create({
                    type: search.Type.ITEM_FULFILLMENT,
                    filters: [
                        ['custbody_sust_consol_shipment', 'anyof', '@NONE@'],
                        'AND',
                        ['mainline', 'is', 'T'],
                        'AND',
                        ['status', 'anyof', ['ItemShip:C']]  // Shipped
                    ],
                    columns: [
                        search.createColumn({ name: 'trandate', sort: search.Sort.DESC }),
                        'tranid',
                        'entity',
                        'item'
                    ]
                }).run().each(r => {
                    results.push({
                        id:        r.id,
                        docNumber: r.getValue('tranid'),
                        customer:  r.getText('entity'),
                        shipDate:  r.getValue('trandate'),
                        items:     r.getText('item')
                    });
                    return true;
                });
            } catch (e) {
                log.debug('searchUnlinkedFulfillments', e.message);
            }
            return results;
        };

        const searchLinkedFulfillments = (csId) => {
            const results = [];
            try {
                search.create({
                    type: search.Type.ITEM_FULFILLMENT,
                    filters: [
                        ['custbody_sust_consol_shipment', 'is', csId],
                        'AND',
                        ['mainline', 'is', 'T']
                    ],
                    columns: [
                        'tranid',
                        'entity',
                        'trandate',
                        'item'
                    ]
                }).run().each(r => {
                    results.push({
                        id:        r.id,
                        docNumber: r.getValue('tranid'),
                        customer:  r.getText('entity'),
                        shipDate:  r.getValue('trandate'),
                        items:     r.getText('item')
                    });
                    return true;
                });
            } catch (e) {
                log.debug('searchLinkedFulfillments', e.message);
            }
            return results;
        };

        const searchPalletsForShipment = (csId) => {
            // Search pallets linked to fulfillments that are linked to this consolidated shipment
            const ffIds = searchLinkedFulfillments(csId).map(ff => ff.id);
            if (ffIds.length === 0) return [];

            const results = [];
            try {
                search.create({
                    type: 'customrecord_sust_ship_pallet',
                    filters: [
                        ['custrecord_sust_sp_fulfillment', 'anyof', ffIds]
                    ],
                    columns: [
                        search.createColumn({ name: 'custrecord_sust_sp_pallet_num', sort: search.Sort.ASC }),
                        'custrecord_sust_sp_fulfillment',
                        'custrecord_sust_sp_item',
                        'custrecord_sust_sp_net_weight',
                        'custrecord_sust_sp_gross_weight',
                        'custrecord_sust_sp_tare_weight',
                        'custrecord_sust_sp_pallet_type',
                        'custrecord_sust_sp_notes'
                    ]
                }).run().each(r => {
                    results.push({
                        id:              r.id,
                        palletNum:       r.getValue('custrecord_sust_sp_pallet_num'),
                        fulfillmentId:   r.getValue('custrecord_sust_sp_fulfillment'),
                        fulfillmentDoc:  r.getText('custrecord_sust_sp_fulfillment'),
                        item:            r.getText('custrecord_sust_sp_item'),
                        netWeight:       parseFloat(r.getValue('custrecord_sust_sp_net_weight')) || 0,
                        grossWeight:     parseFloat(r.getValue('custrecord_sust_sp_gross_weight')) || 0,
                        tareWeight:      parseFloat(r.getValue('custrecord_sust_sp_tare_weight')) || 0,
                        palletType:      r.getText('custrecord_sust_sp_pallet_type'),
                        notes:           r.getValue('custrecord_sust_sp_notes')
                    });
                    return true;
                });
            } catch (e) {
                log.debug('searchPalletsForShipment', e.message);
            }
            return results;
        };

        const updateFulfillmentTotals = (csId, totalPallets, totalNetWt, totalGrossWt) => {
            const ffIds = searchLinkedFulfillments(csId).map(ff => ff.id);
            ffIds.forEach(ffId => {
                try {
                    record.submitFields({
                        type: record.Type.ITEM_FULFILLMENT,
                        id: ffId,
                        values: {
                            custbody_sust_total_pallets: totalPallets,
                            custbody_sust_total_net_wt: Math.round(totalNetWt * 100) / 100,
                            custbody_sust_total_gross_wt: Math.round(totalGrossWt * 100) / 100
                        }
                    });
                } catch (e) {
                    log.error('updateFulfillmentTotals', 'Failed to update FF ' + ffId + ': ' + e.message);
                }
            });
        };

        // ── Navigation Helpers ─────────────────────────────────────────────

        const buildSuiteletUrl = (params) => {
            return url.resolveScript({
                scriptId: runtime.getCurrentScript().id,
                deploymentId: runtime.getCurrentScript().deploymentId,
                params: params
            });
        };

        const redirectToList = (context, msg) => {
            redirect.toSuitelet({
                scriptId: runtime.getCurrentScript().id,
                deploymentId: runtime.getCurrentScript().deploymentId,
                parameters: { msg: msg }
            });
        };

        const redirectToDetail = (context, csId, msg) => {
            redirect.toSuitelet({
                scriptId: runtime.getCurrentScript().id,
                deploymentId: runtime.getCurrentScript().deploymentId,
                parameters: { mode: 'detail', csid: csId, msg: msg }
            });
        };

        // ── UI Helpers ─────────────────────────────────────────────────────

        const addDisplayField = (form, id, label, value, container) => {
            const fld = form.addField({
                id: id,
                type: serverWidget.FieldType.TEXT,
                label: label,
                container: container
            });
            fld.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
            if (value !== null && value !== '') {
                fld.defaultValue = String(value);
            }
            return fld;
        };

        const addResponsiveStyles = (form) => {
            const cssField = form.addField({
                id: 'custpage_css',
                type: serverWidget.FieldType.INLINEHTML,
                label: ' '
            });
            cssField.defaultValue = `<style>
                .uir-machine-table-container { max-width: 100%; overflow-x: auto; }
                .uir-machine-table { width: 100%; }
                .uir-button { min-height: 44px; min-width: 120px; font-size: 14px; margin: 4px; }
                @media (max-width: 768px) {
                    .uir-field { width: 100% !important; }
                    .uir-button { width: 100%; font-size: 16px; padding: 12px; }
                }
            </style>`;
        };

        const escapeXml = (str) => {
            if (!str) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&apos;');
        };

        return { onRequest };
    }
);
