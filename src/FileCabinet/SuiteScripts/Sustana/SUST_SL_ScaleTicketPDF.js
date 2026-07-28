/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */

/**
 * SUST_SL_ScaleTicketPDF.js
 *
 * Printable scale ticket (BFO PDF via N/render.xmlToPdf) — the classic
 * driver-facing weighmaster document: ticket #, vendor/truck, weigh-in/out,
 * GROSS − TARE = NET (lbs + tons), bale count + quality reads from the lot,
 * PO / Item Receipt references, and signature lines.
 *
 * Usage: ...scriptlet.nl?script=customscript_sust_sl_ticket_pdf
 *        &deploy=customdeploy_sust_sl_ticket_pdf&ticket=<internal id>
 *
 * Author: MHI
 * Date: July 2026
 */

define(['N/record', 'N/search', 'N/render', 'N/log', './SUST_Lib_Units'],
    function(record, search, render, log, units) {

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
                const ticketId = context.request.parameters.ticket;
                if (!ticketId) {
                    context.response.write({ output: '<h2>Missing ticket parameter</h2><p>Pass ?ticket=&lt;id&gt;.</p>' });
                    return;
                }
                const data = loadTicket(ticketId);
                const pdfFile = render.xmlToPdf({ xmlString: buildXml(data) });
                pdfFile.name = 'ScaleTicket_' + (data.number || ticketId) + '.pdf';
                context.response.writeFile({ file: pdfFile, isInline: true });
            } catch (e) {
                log.error('SUST_SL_ScaleTicketPDF failed', e.message + '\n' + (e.stack || ''));
                context.response.write({
                    output: '<h2 style="color:#dc2626;">Scale Ticket PDF Error</h2><pre>'
                        + String(e.message).replace(/[<>]/g, '') + '</pre>'
                });
            }
        }

        function loadTicket(ticketId) {
            const t = record.load({ type: TICKET_TYPE, id: ticketId });
            const d = {
                number: t.getValue({ fieldId: F.NUMBER }) || '',
                truck: t.getValue({ fieldId: F.TRUCK }) || '',
                vendor: t.getText({ fieldId: F.VENDOR }) || '',
                po: t.getText({ fieldId: F.PO }) || '',
                grossLbs: parseFloat(t.getValue({ fieldId: F.GROSS })) || 0,
                tareLbs: parseFloat(t.getValue({ fieldId: F.TARE })) || 0,
                netLbs: parseFloat(t.getValue({ fieldId: F.NET })) || 0,
                weighIn: String(t.getValue({ fieldId: F.WEIGH_IN }) || ''),
                weighOut: String(t.getValue({ fieldId: F.WEIGH_OUT }) || ''),
                location: t.getText({ fieldId: F.LOCATION }) || '',
                irText: t.getText({ fieldId: F.IR }) || '',
                status: t.getText({ fieldId: F.STATUS }) || '',
                notes: t.getValue({ fieldId: F.NOTES }) || '',
                lot: {}
            };
            // Lot = ticket number: pull quality reads for the ticket footer
            try {
                const res = search.create({
                    type: 'inventorynumber',
                    filters: [['inventorynumber', 'is', d.number]],
                    columns: ['custitemnumber_sust_moisture_pct', 'custitemnumber_sust_contamination_pct',
                        'custitemnumber_sust_bale_count', 'custitemnumber_sust_vendor_lot_number',
                        'custitemnumber_sust_lot_status', 'item']
                }).run().getRange({ start: 0, end: 1 });
                if (res.length) {
                    const r = res[0];
                    d.lot = {
                        item: r.getText({ name: 'item' }) || '',
                        moisture: r.getValue({ name: 'custitemnumber_sust_moisture_pct' }),
                        contamination: r.getValue({ name: 'custitemnumber_sust_contamination_pct' }),
                        bales: r.getValue({ name: 'custitemnumber_sust_bale_count' }),
                        vendorLot: r.getValue({ name: 'custitemnumber_sust_vendor_lot_number' }),
                        status: r.getText({ name: 'custitemnumber_sust_lot_status' }) || ''
                    };
                }
            } catch (e) { log.debug('ticket lot lookup', e.message); }
            return d;
        }

        function buildXml(d) {
            const wRow = function(label, lbs, bold) {
                const w = bold ? 'bold' : 'normal';
                return '<tr>'
                    + '<td style="font-weight:' + w + ';">' + esc(label) + '</td>'
                    + '<td align="right" style="font-weight:' + w + ';">' + commas(lbs) + ' lbs</td>'
                    + '<td align="right" style="font-weight:' + w + ';">' + esc(units.formatTons(lbs)) + ' tons</td>'
                    + '</tr>';
            };
            const q = d.lot || {};
            const qualityRows = []
                .concat(q.item ? ['<tr><td>Grade</td><td align="right" colspan="2">' + esc(q.item) + '</td></tr>'] : [])
                .concat(q.bales ? ['<tr><td>Bale Count</td><td align="right" colspan="2">' + esc(q.bales) + '</td></tr>'] : [])
                .concat(q.moisture ? ['<tr><td>Moisture</td><td align="right" colspan="2">' + esc(q.moisture) + '%</td></tr>'] : [])
                .concat(q.contamination ? ['<tr><td>Contamination</td><td align="right" colspan="2">' + esc(q.contamination) + '%</td></tr>'] : [])
                .concat(q.vendorLot ? ['<tr><td>Vendor Lot #</td><td align="right" colspan="2">' + esc(q.vendorLot) + '</td></tr>'] : [])
                .join('');

            return '<?xml version="1.0"?><!DOCTYPE pdf PUBLIC "-//big.faceless.org//report" "report-1.1.dtd">'
                + '<pdf><head>'
                + '<style type="text/css">'
                + 'body { font-family: Helvetica; font-size: 10pt; color: #1a1a1a; }'
                + 'table { width: 100%; border-collapse: collapse; }'
                + 'td, th { padding: 5pt 8pt; }'
                + '.box { border: 1pt solid #94a3b8; margin-bottom: 10pt; }'
                + '.hd { background-color: #2976F3; color: #ffffff; font-weight: bold; font-size: 10pt; }'
                + '</style>'
                + '</head><body size="Letter" padding="0.5in">'

                + '<table><tr>'
                + '<td style="font-size:18pt; font-weight:bold; color:#1F5FCC;">SUSTANA RECOVERY</td>'
                + '<td align="right"><span style="font-size:16pt; font-weight:bold;">SCALE TICKET</span><br/>'
                + '<span style="font-size:12pt; font-weight:bold;">' + esc(d.number) + '</span><br/>'
                + '<span style="color:#64748b;">' + esc(d.status) + '</span></td>'
                + '</tr></table>'

                + '<table class="box"><tr class="hd"><td colspan="2">Load</td></tr>'
                + '<tr><td>Supplier</td><td align="right">' + esc(d.vendor || '—') + '</td></tr>'
                + '<tr><td>Truck / Trailer</td><td align="right">' + esc(d.truck || '—') + '</td></tr>'
                + '<tr><td>Purchase Order</td><td align="right">' + esc(d.po || '— (no-PO fallback)') + '</td></tr>'
                + '<tr><td>Site</td><td align="right">' + esc(d.location || '—') + '</td></tr>'
                + '<tr><td>Weigh In</td><td align="right">' + esc(d.weighIn || '—') + '</td></tr>'
                + '<tr><td>Weigh Out</td><td align="right">' + esc(d.weighOut || '—') + '</td></tr>'
                + '</table>'

                + '<table class="box"><tr class="hd"><td>Weighment</td><td align="right">Pounds</td><td align="right">Tons</td></tr>'
                + wRow('GROSS (loaded)', d.grossLbs, false)
                + wRow('TARE (empty truck)', d.tareLbs, false)
                + wRow('NET = GROSS − TARE', d.netLbs, true)
                + '</table>'

                + (qualityRows
                    ? '<table class="box"><tr class="hd"><td colspan="3">Lot &amp; Quality (lot ' + esc(d.number) + ')</td></tr>' + qualityRows + '</table>'
                    : '')

                + (d.irText
                    ? '<p style="color:#64748b;">Received into NetSuite as ' + esc(d.irText) + ' — lot number = ticket number for end-to-end traceability.</p>'
                    : '')
                + (d.notes ? '<p><b>Notes:</b> ' + esc(d.notes) + '</p>' : '')

                + '<table style="margin-top:26pt;"><tr>'
                + '<td style="border-top:1pt solid #1a1a1a; width:45%;">Driver Signature</td>'
                + '<td style="width:10%;"></td>'
                + '<td style="border-top:1pt solid #1a1a1a; width:45%;">Weighmaster Signature</td>'
                + '</tr></table>'
                + '<p style="font-size:8pt; color:#94a3b8; margin-top:12pt;">Weights certified at time of weighment. '
                + 'Net weight is the settlement basis; quality deductions per the supplier settlement schedule apply after grading.</p>'

                + '</body></pdf>';
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
