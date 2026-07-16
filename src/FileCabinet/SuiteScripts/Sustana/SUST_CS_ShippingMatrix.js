/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 * @description Client Script for Shipping Matrix Suitelet — button handlers, navigation, weight auto-calculation
 */
define(['N/currentRecord', 'N/ui/dialog', 'N/log'],
    (currentRecord, dialog, log) => {

        const pageInit = (context) => {
            console.log('Shipping Matrix initialized');
        };

        // ── Action Helpers ─────────────────────────────────────────────────

        const submitAction = (actionName) => {
            const rec = currentRecord.get();
            rec.setValue({ fieldId: 'custpage_action', value: actionName });
            document.forms[0].submit();
        };

        // ── Button Handlers ────────────────────────────────────────────────

        const doAction_newShipment = () => {
            // Navigate to new shipment form
            const currentUrl = window.location.href;
            const baseUrl = currentUrl.split('?')[0];
            const params = new URLSearchParams(window.location.search);
            params.set('mode', 'new');
            params.delete('csid');
            params.delete('msg');
            window.location.href = baseUrl + '?' + params.toString();
        };

        const doAction_backToList = () => {
            const currentUrl = window.location.href;
            const baseUrl = currentUrl.split('?')[0];
            const params = new URLSearchParams(window.location.search);
            params.set('mode', 'list');
            params.delete('csid');
            params.delete('msg');
            window.location.href = baseUrl + '?' + params.toString();
        };

        const doAction_markShipped = () => {
            dialog.confirm({
                title: 'Mark as Shipped',
                message: 'This will mark the consolidated shipment as Shipped and lock editing. Continue?'
            }).then((result) => {
                if (result) {
                    submitAction('mark_shipped');
                }
            }).catch((e) => {
                console.error('Mark shipped confirmation error:', e);
            });
        };

        const doAction_cancelShipment = () => {
            dialog.confirm({
                title: 'Cancel Shipment',
                message: 'This will cancel the consolidated shipment. This cannot be undone. Continue?'
            }).then((result) => {
                if (result) {
                    submitAction('cancel_shipment');
                }
            }).catch((e) => {
                console.error('Cancel shipment confirmation error:', e);
            });
        };

        const doAction_printBOL = () => {
            const rec = currentRecord.get();
            const bolUrl = rec.getValue({ fieldId: 'custpage_bol_url' });
            if (bolUrl) {
                window.open(bolUrl, '_blank');
            }
        };

        // ── Sublist Field Changed — auto-calc tare weight ──────────────────

        const sublistChanged = (context) => {
            if (context.sublistId === 'custpage_pallets') {
                const rec = currentRecord.get();
                const fieldId = context.fieldId;

                if (fieldId === 'custpage_pal_gross_wt' || fieldId === 'custpage_pal_net_wt') {
                    const gross = parseFloat(rec.getCurrentSublistValue({
                        sublistId: 'custpage_pallets',
                        fieldId: 'custpage_pal_gross_wt'
                    })) || 0;
                    const net = parseFloat(rec.getCurrentSublistValue({
                        sublistId: 'custpage_pallets',
                        fieldId: 'custpage_pal_net_wt'
                    })) || 0;

                    if (gross > 0 && net > 0) {
                        rec.setCurrentSublistValue({
                            sublistId: 'custpage_pallets',
                            fieldId: 'custpage_pal_tare_wt',
                            value: Math.round((gross - net) * 100) / 100
                        });
                    }
                }
            }
        };

        return {
            pageInit,
            sublistChanged,
            doAction_newShipment,
            doAction_backToList,
            doAction_markShipped,
            doAction_cancelShipment,
            doAction_printBOL
        };
    }
);
