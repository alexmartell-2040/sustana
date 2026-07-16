/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 */

/**
 * SUST_CS_LotQualityEntry.js
 *
 * Client script for the Lot Quality & Grade Entry Suitelet.
 * Provides validation and cancel button handler.
 *
 * Author: Sustana Dev Team
 * Date: July 2026
 */

define(['N/currentRecord', 'N/ui/dialog', 'N/log'],
    function(currentRecord, dialog, log) {

        // Sublist quality field ids (see SUST_SL_LotQualityEntry QUALITY_FIELDS)
        const QUALITY_FIELDS = ['moisture', 'contamination', 'fiber_content', 'bale_count'];

        // The percent-type quality fields must stay within 0-100
        const PERCENT_FIELDS = ['moisture', 'contamination', 'fiber_content'];

        /**
         * Page initialization
         */
        function pageInit(context) {
            log.debug('pageInit', 'Lot Quality Entry form loaded');
        }

        /**
         * Validate before save:
         *   - at least one quality value entered per lot
         *   - percent fields within 0-100
         */
        function saveRecord(context) {
            const rec = context.currentRecord;
            const lineCount = rec.getLineCount({ sublistId: 'custpage_lot_lines' });

            for (let i = 0; i < lineCount; i++) {
                let hasQuality = false;

                for (let j = 0; j < QUALITY_FIELDS.length; j++) {
                    // PERCENT fields may return values with a '%' suffix — parseFloat first
                    const raw = rec.getSublistValue({
                        sublistId: 'custpage_lot_lines',
                        fieldId: 'custpage_quality_' + QUALITY_FIELDS[j],
                        line: i
                    });
                    const val = parseFloat(raw);

                    if (!isNaN(val) && val > 0) {
                        hasQuality = true;
                    }

                    if (PERCENT_FIELDS.indexOf(QUALITY_FIELDS[j]) !== -1 &&
                        !isNaN(val) && (val < 0 || val > 100)) {
                        dialog.alert({
                            title: 'Validation',
                            message: `Line ${i + 1}: percent values must be between 0 and 100.`
                        });
                        return false;
                    }
                }

                if (!hasQuality) {
                    const lotNumber = rec.getSublistValue({
                        sublistId: 'custpage_lot_lines',
                        fieldId: 'custpage_lot_number',
                        line: i
                    });
                    dialog.alert({
                        title: 'Validation',
                        message: `Lot ${lotNumber} (line ${i + 1}) has no quality values. Please enter at least one quality value per lot.`
                    });
                    return false;
                }
            }

            return true;
        }

        /**
         * Cancel and return to Item Receipt
         */
        function cancelForm() {
            const rec = currentRecord.get();
            const itemReceiptId = rec.getValue({ fieldId: 'custpage_item_receipt_id' });

            if (itemReceiptId) {
                window.location.href = '/app/accounting/transactions/itemrcpt.nl?id=' + itemReceiptId;
            } else {
                history.back();
            }
        }

        return {
            pageInit: pageInit,
            saveRecord: saveRecord,
            cancelForm: cancelForm
        };

    });
