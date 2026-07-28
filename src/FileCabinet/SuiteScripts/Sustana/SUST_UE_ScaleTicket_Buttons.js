/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */

/**
 * SUST_UE_ScaleTicket_Buttons.js
 *
 * Adds a "Print Scale Ticket (PDF)" action to the scale ticket record view
 * (and a link back to the kiosk correction page). Rendered as INLINEHTML so
 * no client script is needed.
 *
 * Author: MHI
 * Date: July 2026
 */

define(['N/ui/serverWidget', 'N/url', 'N/log'],
    function(serverWidget, url, log) {

        function beforeLoad(context) {
            try {
                if (context.type !== context.UserEventType.VIEW || !context.form || !context.newRecord.id) {
                    return;
                }
                const ticketId = context.newRecord.id;

                let pdfUrl = null;
                let kioskUrl = null;
                try {
                    pdfUrl = url.resolveScript({
                        scriptId: 'customscript_sust_sl_ticket_pdf',
                        deploymentId: 'customdeploy_sust_sl_ticket_pdf',
                        params: { ticket: ticketId }
                    });
                } catch (e) { log.debug('ticket pdf url', e.message); }
                try {
                    kioskUrl = url.resolveScript({
                        scriptId: 'customscript_sust_sl_scaleticket',
                        deploymentId: 'customdeploy_sust_sl_scaleticket',
                        params: { id: ticketId }
                    });
                } catch (e) { log.debug('kiosk url', e.message); }
                if (!pdfUrl && !kioskUrl) return;

                const fld = context.form.addField({
                    id: 'custpage_ticket_actions',
                    type: serverWidget.FieldType.INLINEHTML,
                    label: ' '
                });
                fld.defaultValue =
                    '<div style="background:#f9fafb;border:1px solid #d1d5db;padding:10px 14px;margin:8px 0;'
                    + 'border-radius:6px;font-family:Arial,sans-serif;font-size:13px;">'
                    + '<span style="font-weight:bold;margin-right:12px;">Scale Ticket:</span>'
                    + (pdfUrl
                        ? '<a href="' + pdfUrl + '" target="_blank" style="display:inline-block;padding:6px 14px;'
                          + 'margin-right:8px;background:#1e3a8a;color:#fff;text-decoration:none;border-radius:4px;font-weight:600;">'
                          + '&#128424; Print Scale Ticket (PDF)</a>'
                        : '')
                    + (kioskUrl
                        ? '<a href="' + kioskUrl + '" style="display:inline-block;padding:6px 14px;'
                          + 'background:#2976F3;color:#fff;text-decoration:none;border-radius:4px;font-weight:600;">'
                          + '&#9878; Correct at Kiosk</a>'
                        : '')
                    + '</div>';
            } catch (e) {
                log.error('SUST_UE_ScaleTicket_Buttons', e.message);
            }
        }

        return { beforeLoad: beforeLoad };
    });
