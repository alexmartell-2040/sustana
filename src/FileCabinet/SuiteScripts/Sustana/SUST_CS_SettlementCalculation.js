/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 */

/**
 * SUST_CS_SettlementCalculation.js
 *
 * Client script for Settlement Calculation Suitelet
 * Features:
 * - Real-time recovery % and balance due calculation
 * - Server-side penalty calculation via AJAX
 * - Market price refresh from stored RISI index prices
 * - Status change confirmation dialogs
 *
 * Author: Sustana Dev Team
 * Date: February 2026
 */

define(['N/currentRecord', 'N/ui/dialog', 'N/url'],
    function(currentRecord, dialog, url) {

        /**
         * Page initialization
         */
        function pageInit(context) {
            console.log('Settlement Calculation page initialized');
            // Only run calculations if on the settlement form (not the list page)
            try {
                const grossLbs = context.currentRecord.getValue({ fieldId: 'custpage_gross_lbs' });
                if (grossLbs !== null && grossLbs !== undefined) {
                    calculateRecoveryPercentage(context.currentRecord);
                    calculateBalanceDue(context.currentRecord);
                }
            } catch (e) {
                // On list page — no form fields to calculate
            }
        }

        /**
         * Field changed event
         */
        function fieldChanged(context) {
            const currentRec = context.currentRecord;
            const fieldId = context.fieldId;

            if (fieldId === 'custpage_gross_lbs' || fieldId === 'custpage_net_lbs') {
                calculateRecoveryPercentage(currentRec);
            }

            if (fieldId === 'custpage_net_value' || fieldId === 'custpage_provisional') {
                calculateBalanceDue(currentRec);
            }

            // Auto-calculate net weight as 95% of gross when gross changes and net is empty
            if (fieldId === 'custpage_gross_lbs') {
                const grossLbs = currentRec.getValue({ fieldId: 'custpage_gross_lbs' });
                const currentNet = currentRec.getValue({ fieldId: 'custpage_net_lbs' });

                if (!currentNet && grossLbs) {
                    currentRec.setValue({ fieldId: 'custpage_net_lbs', value: grossLbs * 0.95 });
                }
            }
        }

        /**
         * Calculate recovery percentage from gross and net weight
         */
        function calculateRecoveryPercentage(currentRec) {
            try {
                const grossLbs = parseFloat(currentRec.getValue({ fieldId: 'custpage_gross_lbs' }) || 0);
                const netLbs = parseFloat(currentRec.getValue({ fieldId: 'custpage_net_lbs' }) || 0);

                let recoveryPct = 0;
                if (grossLbs > 0) {
                    recoveryPct = (netLbs / grossLbs) * 100;
                }

                currentRec.setValue({ fieldId: 'custpage_recovery_pct', value: recoveryPct });
            } catch (e) {
                console.error('Error calculating recovery percentage', e);
            }
        }

        /**
         * Calculate balance due = net value - provisional paid
         */
        function calculateBalanceDue(currentRec) {
            try {
                const netValue = parseFloat(currentRec.getValue({ fieldId: 'custpage_net_value' }) || 0);
                const provisional = parseFloat(currentRec.getValue({ fieldId: 'custpage_provisional' }) || 0);
                currentRec.setValue({ fieldId: 'custpage_balance_due', value: netValue - provisional });
            } catch (e) {
                console.error('Error calculating balance due', e);
            }
        }

        /**
         * Calculate Settlement button handler.
         * For saved settlements: calls server endpoint for full calculation including penalties.
         * For unsaved settlements: does client-side calculation (no penalties).
         */
        function calculateSettlement() {
            try {
                const currentRec = currentRecord.get();
                const settlementId = currentRec.getValue({ fieldId: 'custpage_settlement_id' });

                if (settlementId) {
                    calculateServerSide(currentRec, settlementId);
                } else {
                    calculateClientSide(currentRec);
                }
            } catch (e) {
                console.error('Error calculating settlement', e);
                dialog.alert({ title: 'Calculation Error', message: 'Error calculating settlement: ' + e.message });
            }
        }

        /**
         * Server-side calculation — calls Suitelet endpoint and updates form
         */
        function calculateServerSide(currentRec, settlementId) {
            const suiteletUrl = url.resolveScript({
                scriptId: 'customscript_sust_sl_settlecalc',
                deploymentId: 'customdeploy_sust_sl_settlecalc',
                params: { action: 'calculate', settlementid: settlementId }
            });

            const xhr = new XMLHttpRequest();
            xhr.open('GET', suiteletUrl, false);
            xhr.send();

            if (xhr.status !== 200) {
                dialog.alert({ title: 'Request Failed', message: 'Could not calculate settlement. HTTP ' + xhr.status });
                return;
            }

            const result = JSON.parse(xhr.responseText);
            if (result.error) {
                dialog.alert({ title: 'Calculation Error', message: result.error });
                return;
            }

            // Update form fields with server-calculated values
            currentRec.setValue({ fieldId: 'custpage_gross_value', value: result.grossValue.toFixed(2) });
            currentRec.setValue({ fieldId: 'custpage_net_value', value: result.netValue.toFixed(2) });
            currentRec.setValue({ fieldId: 'custpage_penalties', value: result.totalPenalties.toFixed(2) });
            calculateBalanceDue(currentRec);

            // Build summary message
            let msg = 'Gross Value: $' + result.grossValue.toFixed(2) +
                      '\nTotal Penalties: $' + result.totalPenalties.toFixed(2) +
                      '\nNet Value: $' + result.netValue.toFixed(2);

            if (result.scheduleMarketPct !== 100 || result.scheduleMarketAdj !== 0) {
                msg += '\n\nEffective Price: $' + result.effectivePrice.toFixed(4) + '/lb';
            }

            if (result.penaltyDetails && result.penaltyDetails.length > 0) {
                msg += '\n\n--- Penalty Breakdown ---';
                for (const p of result.penaltyDetails) {
                    msg += '\n' + p.elementText + ': ' + p.actualPct.toFixed(2) + '% (threshold: ' +
                           p.threshold.toFixed(2) + '%, excess: ' + p.excessPct.toFixed(2) + '%) = $' + p.amount.toFixed(2);
                }
            }

            dialog.alert({ title: 'Settlement Calculated', message: msg });
        }

        /**
         * Client-side calculation fallback for unsaved settlements
         */
        function calculateClientSide(currentRec) {
            const netLbs = parseFloat(currentRec.getValue({ fieldId: 'custpage_net_lbs' }) || 0);
            const marketPrice = parseFloat(currentRec.getValue({ fieldId: 'custpage_market_price' }) || 0);
            const treatment = parseFloat(currentRec.getValue({ fieldId: 'custpage_treatment' }) || 0);
            const penalties = parseFloat(currentRec.getValue({ fieldId: 'custpage_penalties' }) || 0);

            const marketPct = parseFloat(currentRec.getValue({ fieldId: 'custpage_schedule_market_pct' }) || 100);
            const marketAdj = parseFloat(currentRec.getValue({ fieldId: 'custpage_schedule_market_adj' }) || 0);

            const effectivePrice = (marketPrice * marketPct / 100) + marketAdj;
            const grossValue = netLbs * effectivePrice;
            const netValue = grossValue - treatment - penalties;

            currentRec.setValue({ fieldId: 'custpage_gross_value', value: grossValue.toFixed(2) });
            currentRec.setValue({ fieldId: 'custpage_net_value', value: netValue.toFixed(2) });
            calculateBalanceDue(currentRec);

            let msg = 'Gross Value: $' + grossValue.toFixed(2) + '\nNet Value: $' + netValue.toFixed(2);
            if (marketPct !== 100 || marketAdj !== 0) {
                msg += '\n\nEffective Price: $' + effectivePrice.toFixed(4) + '/lb' +
                       ' (Market $' + marketPrice.toFixed(4) + ' x ' + marketPct + '% + $' + marketAdj.toFixed(2) + ')';
            }
            msg += '\n\nNote: Save the settlement first, then click Calculate to include penalty calculations.';

            dialog.alert({ title: 'Settlement Calculated', message: msg });
        }

        /**
         * Refresh Market Price button handler
         */
        function refreshMarketPrice() {
            try {
                const currentRec = currentRecord.get();
                const marketSource = currentRec.getText({ fieldId: 'custpage_market_source' });

                if (!marketSource || marketSource === 'Custom/Manual Entry') {
                    dialog.alert({
                        title: 'Market Source Required',
                        message: 'Select a market price source (e.g., RISI SOP) to auto-fetch.'
                    });
                    return;
                }

                const suiteletUrl = url.resolveScript({
                    scriptId: 'customscript_sust_sl_settlecalc',
                    deploymentId: 'customdeploy_sust_sl_settlecalc',
                    params: { action: 'getprice', source: marketSource }
                });

                const xhr = new XMLHttpRequest();
                xhr.open('GET', suiteletUrl, false);
                xhr.send();

                if (xhr.status !== 200) {
                    dialog.alert({ title: 'Request Failed', message: 'Could not fetch market price. HTTP ' + xhr.status });
                    return;
                }

                const response = JSON.parse(xhr.responseText);
                if (response.pricePerLb) {
                    currentRec.setValue({ fieldId: 'custpage_market_price', value: response.pricePerLb });
                    dialog.alert({
                        title: 'Market Price Updated',
                        message: marketSource + ': $' + response.pricePerLb.toFixed(4) + '/lb\nAs of: ' + response.date
                    });
                } else {
                    dialog.alert({
                        title: 'No Price Available',
                        message: 'No stored price found for ' + marketSource + '.\nEnter an index price in the Market Price table or use Custom/Manual Entry.'
                    });
                }

            } catch (e) {
                console.error('Error refreshing market price', e);
                dialog.alert({ title: 'Error', message: 'Error fetching market price: ' + e.message });
            }
        }

        /**
         * Save record validation with status change confirmation
         */
        function saveRecord(context) {
            const currentRec = context.currentRecord;

            try {
                // Basic field validation
                const vendor = currentRec.getValue({ fieldId: 'custpage_vendor' });
                if (!vendor) {
                    dialog.alert({ title: 'Missing Vendor', message: 'Please select a vendor/customer.' });
                    return false;
                }

                const settlementDate = currentRec.getValue({ fieldId: 'custpage_settlement_date' });
                if (!settlementDate) {
                    dialog.alert({ title: 'Missing Date', message: 'Please enter a settlement date.' });
                    return false;
                }

                const status = currentRec.getValue({ fieldId: 'custpage_status' });
                if (!status) {
                    dialog.alert({ title: 'Missing Status', message: 'Please select a status.' });
                    return false;
                }

                const method = currentRec.getValue({ fieldId: 'custpage_method' });
                if (!method) {
                    dialog.alert({ title: 'Missing Method', message: 'Please select a settlement method.' });
                    return false;
                }

                const grossLbs = parseFloat(currentRec.getValue({ fieldId: 'custpage_gross_lbs' }) || 0);
                if (grossLbs <= 0) {
                    dialog.alert({ title: 'Invalid Weight', message: 'Gross weight must be greater than zero.' });
                    return false;
                }

                const netLbs = parseFloat(currentRec.getValue({ fieldId: 'custpage_net_lbs' }) || 0);
                if (netLbs > grossLbs) {
                    dialog.alert({ title: 'Invalid Weight', message: 'Net weight cannot exceed gross weight.' });
                    return false;
                }

                // Status change detection and confirmation
                const originalStatus = currentRec.getValue({ fieldId: 'custpage_original_status' });
                const newStatusText = currentRec.getText({ fieldId: 'custpage_status' });

                if (originalStatus && newStatusText && originalStatus !== newStatusText) {
                    return confirmStatusChange(originalStatus, newStatusText, currentRec);
                }

                return true;
            } catch (e) {
                console.error('Error in save validation', e);
                return false;
            }
        }

        /**
         * Confirm status change with appropriate message
         */
        function confirmStatusChange(fromStatus, toStatus, currentRec) {
            let message = '';

            if (toStatus === 'Completed') {
                message = 'Changing status to Completed will lock core settlement fields (vendor, date, method, schedule).\n\nQuality deductions will be auto-calculated if lot quality data and schedule deductions are configured.\n\nProceed?';
            } else if (toStatus === 'Provisional Paid') {
                const provisional = parseFloat(currentRec.getValue({ fieldId: 'custpage_provisional' }) || 0);
                if (provisional <= 0) {
                    dialog.alert({
                        title: 'Provisional Amount Required',
                        message: 'Please enter a Provisional Paid amount before changing status to Provisional Paid.'
                    });
                    return false;
                }
                message = 'Changing status to Provisional Paid will:\n- Lock all calculation fields\n- Create a provisional vendor bill for $' + provisional.toFixed(2) + '\n\nProceed?';
            } else if (toStatus === 'Final Settled') {
                const balanceDue = parseFloat(currentRec.getValue({ fieldId: 'custpage_balance_due' }) || 0);
                if (balanceDue > 0) {
                    message = 'Changing status to Final Settled will:\n- Create a final vendor bill for $' + balanceDue.toFixed(2) + ' (balance due)\n- Lock all fields\n\nProceed?';
                } else if (balanceDue < 0) {
                    message = 'Warning: Balance due is negative ($' + balanceDue.toFixed(2) + '). The provisional payment exceeded the net value.\n\nA vendor bill will still be created. You may need to process a vendor credit manually.\n\nProceed?';
                } else {
                    message = 'Balance due is $0.00. No final vendor bill will be created.\n\nProceed?';
                }
            } else if (toStatus === 'Voided') {
                message = 'Voiding this settlement will lock all fields. This cannot be undone.\n\nAny existing vendor bills will NOT be automatically voided — handle them manually.\n\nProceed?';
            } else if (toStatus === 'Draft') {
                message = 'Rolling back to Draft will unlock fields for editing.\n\nProceed?';
            }

            if (message) {
                return confirm(message);
            }

            return true;
        }

        /**
         * Create New Settlement button handler — navigates to blank settlement form
         */
        function createNewSettlement() {
            var suiteletUrl = url.resolveScript({
                scriptId: 'customscript_sust_sl_settlecalc',
                deploymentId: 'customdeploy_sust_sl_settlecalc',
                params: { 'new': 'T' }
            });
            window.location.href = suiteletUrl;
        }

        /**
         * Cancel/Back button handler
         */
        function cancelForm() {
            // Navigate back to settlement list
            var suiteletUrl = url.resolveScript({
                scriptId: 'customscript_sust_sl_settlecalc',
                deploymentId: 'customdeploy_sust_sl_settlecalc'
            });
            window.location.href = suiteletUrl;
        }

        return {
            pageInit: pageInit,
            fieldChanged: fieldChanged,
            saveRecord: saveRecord,
            calculateSettlement: calculateSettlement,
            refreshMarketPrice: refreshMarketPrice,
            createNewSettlement: createNewSettlement,
            cancelForm: cancelForm
        };
    });
