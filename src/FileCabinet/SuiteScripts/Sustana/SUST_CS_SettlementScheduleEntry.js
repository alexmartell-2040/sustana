/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 */

/**
 * SUST_CS_SettlementScheduleEntry.js
 *
 * Client script for Settlement Schedule Entry Suitelet
 * Provides field validation and interactive behavior
 *
 * Author: Sustana Dev Team
 * Date: February 2026
 */

define(['N/currentRecord', 'N/ui/dialog'],
    function(currentRecord, dialog) {

        /**
         * Page initialization
         */
        function pageInit(context) {
            console.log('Settlement Schedule Entry page initialized');
            updateFieldVisibility(context.currentRecord);
        }

        /**
         * Field changed event
         */
        function fieldChanged(context) {
            const currentRec = context.currentRecord;
            const fieldId = context.fieldId;

            // Update field visibility based on pricing method
            if (fieldId === 'custpage_method') {
                updateFieldVisibility(currentRec);
            }
        }

        /**
         * Update field visibility based on pricing method
         */
        function updateFieldVisibility(currentRec) {
            try {
                const method = currentRec.getValue({
                    fieldId: 'custpage_method'
                });

                // Get the field objects
                const basePriceField = currentRec.getField({
                    fieldId: 'custpage_base_price'
                });
                const marketRefField = currentRec.getField({
                    fieldId: 'custpage_market_ref'
                });
                const marketPctField = currentRec.getField({
                    fieldId: 'custpage_market_pct'
                });
                const marketAdjField = currentRec.getField({
                    fieldId: 'custpage_market_adj'
                });

                // Show/hide fields based on method
                // % of Index: show market/index fields, hide base price
                // Fixed Price: show base price, hide market/index fields

                if (method) {
                    // This would need to check the list value text
                    // For now, make all fields visible
                    basePriceField.isDisplay = true;
                    marketRefField.isDisplay = true;
                    marketPctField.isDisplay = true;
                    marketAdjField.isDisplay = true;
                }
            } catch (e) {
                console.error('Error updating field visibility', e);
            }
        }

        /**
         * Save record validation
         */
        function saveRecord(context) {
            const currentRec = context.currentRecord;

            try {
                // Validate vendor is selected
                const vendor = currentRec.getValue({
                    fieldId: 'custpage_vendor'
                });

                if (!vendor) {
                    dialog.alert({
                        title: 'Missing Vendor',
                        message: 'Please select a vendor for this schedule.'
                    });
                    return false;
                }

                // Validate pricing method
                const method = currentRec.getValue({
                    fieldId: 'custpage_method'
                });

                if (!method) {
                    dialog.alert({
                        title: 'Missing Pricing Method',
                        message: 'Please select a pricing method.'
                    });
                    return false;
                }

                // Validate dates
                const effectiveDate = currentRec.getValue({
                    fieldId: 'custpage_effective_date'
                });
                const expirationDate = currentRec.getValue({
                    fieldId: 'custpage_expiration_date'
                });

                if (effectiveDate && expirationDate) {
                    const effective = new Date(effectiveDate);
                    const expiration = new Date(expirationDate);

                    if (expiration <= effective) {
                        dialog.alert({
                            title: 'Invalid Dates',
                            message: 'Expiration date must be after effective date.'
                        });
                        return false;
                    }
                }

                return true;
            } catch (e) {
                console.error('Error in save validation', e);
                return false;
            }
        }

        /**
         * Cancel button function
         */
        function cancelForm() {
            window.history.back();
        }

        return {
            pageInit: pageInit,
            fieldChanged: fieldChanged,
            saveRecord: saveRecord,
            cancelForm: cancelForm
        };
    });
