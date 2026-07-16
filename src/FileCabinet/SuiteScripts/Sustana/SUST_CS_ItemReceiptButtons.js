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
         * Open Lot Quality & Grade Entry Suitelet
         */
        function openLotQuality() {
            try {
                const record = currentRecord.get();
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

        return {
            pageInit: pageInit,
            openLotQuality: openLotQuality,
            openProcessScrap: openProcessScrap
        };

    });
