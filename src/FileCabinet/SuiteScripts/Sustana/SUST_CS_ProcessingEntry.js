/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 * @description Client script for Processing Entry Suitelet. The Materials UI
 * (Inbound / Outbound panels) is self-contained INLINEHTML that keeps the
 * hidden custpage_materials_json field in sync; this script only validates
 * that JSON at save time.
 */
define(['N/currentRecord', 'N/ui/dialog', 'N/log'],
    (currentRecord, dialog, log) => {

        const pageInit = (context) => {
            log.debug('pageInit', 'Processing Entry form loaded');
        };

        /**
         * Validate the Materials JSON before submit: at least one inbound row
         * (grade + lot + weight), at least one outbound row, and total output
         * must not exceed total input.
         */
        const saveRecord = (context) => {
            const record = context.currentRecord;
            try {
                let data = { inputs: [], outputs: [] };
                try {
                    data = JSON.parse(record.getValue({ fieldId: 'custpage_materials_json' }) || '{}') || {};
                } catch (ePar) { /* fall through to empty */ }
                const inputs = (data.inputs || []).filter(r => r.item && parseFloat(r.tons) > 0);
                const outputs = (data.outputs || []).filter(r => r.item && parseFloat(r.tons) > 0);

                if (inputs.length === 0) {
                    dialog.alert({
                        title: 'Validation Error',
                        message: 'Add at least one Inbound row (grade, lot, weight).'
                    });
                    return false;
                }
                const missingLot = inputs.find(r => !r.lot);
                if (missingLot) {
                    dialog.alert({
                        title: 'Validation Error',
                        message: 'Every Inbound row needs a Lot — the Inventory Adjustment consumes specific lots.'
                    });
                    return false;
                }
                if (outputs.length === 0) {
                    dialog.alert({
                        title: 'Validation Error',
                        message: 'Add at least one Outbound row (grade, weight).'
                    });
                    return false;
                }

                const tin = inputs.reduce((a, r) => a + (parseFloat(r.tons) || 0), 0);
                const tout = outputs.reduce((a, r) => a + (parseFloat(r.tons) || 0), 0);
                if (tout > tin) {
                    dialog.alert({
                        title: 'Validation Error',
                        message: `Total outbound (${tout.toFixed(2)} tons) exceeds total inbound (${tin.toFixed(2)} tons).`
                    });
                    return false;
                }

                return true;
            } catch (e) {
                log.error('saveRecord', { error: e.message, stack: e.stack });
                return false;
            }
        };

        return {
            pageInit: pageInit,
            saveRecord: saveRecord
        };
    });
