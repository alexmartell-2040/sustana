/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */

/**
 * SUST_UE_ItemReceipt_Buttons.js
 *
 * Adds "Enter Lot Quality" and "Process Material" buttons to Item Receipt
 * for the Sustana Recovery subsidiary, when record is in VIEW mode.
 *
 * v2 (June 2026): subsidiary ID is now read from script parameter
 * `custscript_sust_subsidiary_id` (was hardcoded to 7 in v1).
 *
 * Author: Sustana Dev Team
 * Date: February 2026 (v1) / June 2026 (v2 — configurable subsidiary)
 */

define(['N/record', 'N/runtime', 'N/log', './SUST_Lib_Config'],
    function(record, runtime, log, configLib) {
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


        /**
         * beforeLoad - Add workflow buttons to Item Receipt form
         */
        function beforeLoad(context) {
            try {
                // Buttons show in VIEW *and* during CREATE/EDIT so all three
                // capture options are visible while keying a receipt. Pre-save
                // clicks are handled by the client script (offers to save first —
                // the Lot Quality page needs the saved receipt's lots).
                if (context.type !== context.UserEventType.VIEW &&
                    context.type !== context.UserEventType.CREATE &&
                    context.type !== context.UserEventType.EDIT) {
                    return;
                }

                const itemReceipt = context.newRecord;
                const subsidiaryId = itemReceipt.getValue({ fieldId: 'subsidiary' });

                // Only add buttons for configured Sustana subsidiaries
                if (!subsidiaryAllowed(subsidiaryId, 'custscript_sust_sub_id_btn')) {
                    return;
                }

                const form = context.form;

                // Attach client script for button handlers
                form.clientScriptModulePath = './SUST_CS_ItemReceiptButtons.js';

                // Add "Enter Lot Quality" button
                form.addButton({
                    id: 'custpage_btn_lot_quality',
                    label: 'Enter Lot Quality',
                    functionName: 'openLotQuality'
                });

                // Add "Process Material" button
                form.addButton({
                    id: 'custpage_btn_process_scrap',
                    label: 'Process Material',
                    functionName: 'openProcessScrap'
                });

                // Add "Regrade Lot" button (demo 5.3 — inspection & regrade)
                form.addButton({
                    id: 'custpage_btn_regrade',
                    label: 'Regrade Lot',
                    functionName: 'openRegrade'
                });

                log.debug('beforeLoad', `Added buttons to Item Receipt ${itemReceipt.id}`);

            } catch (e) {
                log.error('beforeLoad', e.toString() + '\n' + (e.stack || ''));
            }
        }

        return {
            beforeLoad: beforeLoad
        };

    });
