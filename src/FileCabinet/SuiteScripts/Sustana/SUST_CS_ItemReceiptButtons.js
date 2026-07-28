/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 */

/**
 * SUST_CS_ItemReceiptButtons.js
 *
 * Client script for Item Receipt buttons.
 * Handles "Enter Lot Quality" and "Process Material" button clicks.
 *
 * Author: Sustana Dev Team
 * Date: February 2026
 */

define(['N/currentRecord', 'N/url', 'N/log'],
    function(currentRecord, url, log) {

        /**
         * Page initialization
         */
        function pageInit(context) {
            log.debug('pageInit', 'Item Receipt buttons client script loaded');
        }

        /**
         * Unsaved receipt: the target pages need the saved receipt's lots.
         * Offer to save now; the buttons reappear on the saved record.
         * @returns {boolean} true when the record is saved and has an id
         */
        function ensureSaved(record, label) {
            if (record.id) return true;
            if (confirm(label + ' needs the receipt saved first (the lots are created at save).\n\nSave the receipt now? Then click ' + label + ' again on the saved receipt.')) {
                try {
                    const btn = document.getElementById('btn_multibutton_submitter')
                        || document.querySelector('input[id^="btn_multibutton"]');
                    if (btn) { btn.click(); return false; }
                    if (document.forms.main_form) { document.forms.main_form.submit(); return false; }
                } catch (e) { /* fall through */ }
                alert('Could not trigger the save automatically — click Save, then use the button on the saved receipt.');
            }
            return false;
        }

        /**
         * Open Lot Quality & Grade Entry Suitelet
         */
        function openLotQuality() {
            try {
                const record = currentRecord.get();
                if (!ensureSaved(record, 'Enter Lot Quality')) return;
                const itemReceiptId = record.id;

                const suiteletUrl = url.resolveScript({
                    scriptId: 'customscript_sust_sl_lotquality',
                    deploymentId: 'customdeploy_sust_sl_lotquality',
                    params: {
                        itemreceiptid: itemReceiptId
                    }
                });

                window.open(suiteletUrl, '_blank');
            } catch (e) {
                log.error('openLotQuality', e.toString());
                alert('Error opening Lot Quality form: ' + e.message);
            }
        }

        /**
         * Open Processing Entry Suitelet pre-populated from Item Receipt
         */
        function openProcessScrap() {
            try {
                const record = currentRecord.get();
                if (!ensureSaved(record, 'Process Material')) return;
                const itemReceiptId = record.id;

                const suiteletUrl = url.resolveScript({
                    scriptId: 'customscript_sust_sl_processingentry',
                    deploymentId: 'customdeploy_sust_sl_processingentry',
                    params: {
                        itemreceiptid: itemReceiptId
                    }
                });

                window.open(suiteletUrl, '_blank');
            } catch (e) {
                log.error('openProcessScrap', e.toString());
                alert('Error opening Processing form: ' + e.message);
            }
        }

        /**
         * Open Inspection & Regrade Suitelet scoped to this receipt's lots
         */
        function openRegrade() {
            try {
                const record = currentRecord.get();
                if (!ensureSaved(record, 'Regrade Lot')) return;
                const suiteletUrl = url.resolveScript({
                    scriptId: 'customscript_sust_sl_regrade',
                    deploymentId: 'customdeploy_sust_sl_regrade',
                    params: { ir: record.id }
                });
                window.open(suiteletUrl, '_blank');
            } catch (e) {
                log.error('openRegrade', e.toString());
                alert('Error opening Regrade form: ' + e.message);
            }
        }

        return {
            pageInit: pageInit,
            openLotQuality: openLotQuality,
            openProcessScrap: openProcessScrap,
            openRegrade: openRegrade
        };

    });
