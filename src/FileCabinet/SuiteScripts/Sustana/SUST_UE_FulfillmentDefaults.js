/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 * @description User Event on Item Fulfillment — sets default values and adds Shipping Matrix button
 */
define(['N/record', 'N/log', 'N/runtime', 'N/url'],
    (record, log, runtime, url) => {

        const beforeLoad = (context) => {
            if (context.type !== context.UserEventType.VIEW) return;

            try {
                const rec = context.newRecord;
                const form = context.form;

                // Add "Shipping Matrix" button on view mode
                const csId = rec.getValue('custbody_sust_consol_shipment');
                if (csId) {
                    // Link to existing consolidated shipment detail
                    const matrixUrl = url.resolveScript({
                        scriptId: 'customscript_sust_sl_shipmatrix',
                        deploymentId: 'customdeploy_sust_sl_shipmatrix',
                        params: { mode: 'detail', csid: csId }
                    });
                    form.addButton({
                        id: 'custpage_btn_ship_matrix',
                        label: 'Shipping Matrix',
                        functionName: `window.open('${matrixUrl}', '_blank')`
                    });
                } else {
                    // Link to new shipment creation
                    const matrixUrl = url.resolveScript({
                        scriptId: 'customscript_sust_sl_shipmatrix',
                        deploymentId: 'customdeploy_sust_sl_shipmatrix',
                        params: { mode: 'new' }
                    });
                    form.addButton({
                        id: 'custpage_btn_ship_matrix',
                        label: 'Create Consolidated Shipment',
                        functionName: `window.open('${matrixUrl}', '_blank')`
                    });
                }
            } catch (e) {
                log.debug('beforeLoad', 'Shipping Matrix button error: ' + e.message);
            }
        };

        return { beforeLoad };
    }
);
