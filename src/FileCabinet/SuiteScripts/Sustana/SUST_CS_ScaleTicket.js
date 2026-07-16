/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 */

/**
 * SUST_CS_ScaleTicket.js
 *
 * Client behavior for the scale kiosk (SUST_SL_ScaleTicket):
 *  - Net = Gross − Tare, computed live (net is display-only).
 *  - Changing the supplier reloads the kiosk with ?vendor= so the server
 *    can rebuild the open-PO dropdown for that supplier.
 *  - saveRecord validates ticket number, supplier, and weight sanity.
 *
 * Author: MHI
 * Date: July 2026
 */

define(['N/currentRecord', 'N/url', 'N/ui/dialog'],
    function(currentRecord, url, dialog) {

        function pageInit(context) {
            recomputeNet(context.currentRecord);
        }

        function fieldChanged(context) {
            const rec = context.currentRecord;

            if (context.fieldId === 'custpage_gross' || context.fieldId === 'custpage_tare') {
                recomputeNet(rec);
            }

            if (context.fieldId === 'custpage_vendor') {
                // Rebuild the open-PO dropdown server-side for the chosen supplier.
                const vendorId = rec.getValue({ fieldId: 'custpage_vendor' });
                const editingTicket = rec.getValue({ fieldId: 'custpage_ticket_id' });
                if (vendorId && !editingTicket) {
                    const kiosk = url.resolveScript({
                        scriptId: 'customscript_sust_sl_scaleticket',
                        deploymentId: 'customdeploy_sust_sl_scaleticket',
                        params: { vendor: vendorId }
                    });
                    window.location.href = kiosk;
                }
            }
        }

        function recomputeNet(rec) {
            const gross = parseFloat(rec.getValue({ fieldId: 'custpage_gross' })) || 0;
            const tare = parseFloat(rec.getValue({ fieldId: 'custpage_tare' })) || 0;
            const net = Math.round((gross - tare) * 100) / 100;
            rec.setValue({
                fieldId: 'custpage_net',
                value: net > 0 ? net : '',
                ignoreFieldChange: true
            });
        }

        function saveRecord(context) {
            const rec = context.currentRecord;

            const ticketNumber = rec.getValue({ fieldId: 'custpage_ticket_number' });
            if (!ticketNumber) {
                dialog.alert({ title: 'Scale Kiosk', message: 'Enter a ticket number (e.g. TRK-001).' });
                return false;
            }
            if (!rec.getValue({ fieldId: 'custpage_vendor' })) {
                dialog.alert({ title: 'Scale Kiosk', message: 'Select the supplier.' });
                return false;
            }

            const gross = parseFloat(rec.getValue({ fieldId: 'custpage_gross' })) || 0;
            const tare = parseFloat(rec.getValue({ fieldId: 'custpage_tare' })) || 0;
            if (!(gross > 0)) {
                dialog.alert({ title: 'Scale Kiosk', message: 'Gross weight must be greater than zero.' });
                return false;
            }
            if (tare < 0 || tare >= gross) {
                dialog.alert({ title: 'Scale Kiosk', message: 'Tare must be less than gross (net = gross − tare must be positive).' });
                return false;
            }
            return true;
        }

        return {
            pageInit: pageInit,
            fieldChanged: fieldChanged,
            saveRecord: saveRecord
        };
    });
