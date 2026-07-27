/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 * @description User Event for Settlement Record - Auto-creates vendor bills on status transitions
 */
define(['N/record', 'N/search', 'N/runtime', 'N/log', './SUST_Lib_Config'],
    (record, search, runtime, log, configLib) => {

        // Settlement status text values (must match customlist_sust_settlement_status)
        const SETTLEMENT_STATUS = {
            DRAFT: 'Draft',
            COMPLETED: 'Completed',
            PROVISIONAL_PAID: 'Provisional Paid',
            FINAL_SETTLED: 'Final Settled',
            VOIDED: 'Voided'
        };

        /**
         * Write a bill line using the configured Settlement Fee item (preferred)
         * or the configured expense account (fallback). Resolution order for each:
         * script parameter -> Sustana Config record. Throws when neither source
         * yields a value — a bill line must post somewhere deliberate.
         */
        function writeBillLine(bill, amount, memo) {
            const settleFeeItem = runtime.getCurrentScript().getParameter({
                name: 'custscript_sust_settle_fee_item'
            }) || configLib.get('settlementFeeItem');

            if (settleFeeItem) {
                // Preferred path: non-inventory item line
                bill.setSublistValue({ sublistId: 'item', fieldId: 'item', line: 0, value: parseInt(settleFeeItem) });
                bill.setSublistValue({ sublistId: 'item', fieldId: 'quantity', line: 0, value: 1 });
                bill.setSublistValue({ sublistId: 'item', fieldId: 'rate', line: 0, value: amount });
                bill.setSublistValue({ sublistId: 'item', fieldId: 'amount', line: 0, value: amount });
                bill.setSublistValue({ sublistId: 'item', fieldId: 'description', line: 0, value: memo });
                log.debug('Bill Line', `Using Settlement Fee item ${settleFeeItem}`);
                return;
            }

            const expenseAccount = configLib.get('settlementExpenseAccount');
            if (!expenseAccount) {
                throw new Error('No settlement fee item or expense account configured. ' +
                    'Set custscript_sust_settle_fee_item on the deployment, or fill the Sustana Config record (run SUST_SL_SeedSustanaDemo).');
            }
            bill.setSublistValue({ sublistId: 'expense', fieldId: 'account', line: 0, value: parseInt(expenseAccount) });
            bill.setSublistValue({ sublistId: 'expense', fieldId: 'amount', line: 0, value: amount });
            bill.setSublistValue({ sublistId: 'expense', fieldId: 'memo', line: 0, value: memo });
            log.debug('Bill Line', `Using configured expense account ${expenseAccount}`);
        }

        /**
         * Build vendor bill reference number from settlement's linked Item Receipt.
         * Format: "SETTLE-{ItemReceiptNumber}" or fallback "SETTLE-{settlementId}"
         */
        function getBillReferenceNumber(settlement, settlementId) {
            try {
                const itemReceiptId = settlement.getValue({ fieldId: 'custrecord_sust_settlement_item_receipt' });
                if (itemReceiptId) {
                    const irLookup = search.lookupFields({
                        type: search.Type.ITEM_RECEIPT,
                        id: itemReceiptId,
                        columns: ['tranid']
                    });
                    if (irLookup.tranid) {
                        return 'SETTLE-' + irLookup.tranid;
                    }
                }
            } catch (e) {
                log.debug('getBillReferenceNumber', 'Could not look up IR number: ' + e.toString());
            }
            return 'SETTLE-' + settlementId;
        }

        /**
         * After Submit event handler
         */
        const afterSubmit = (context) => {
            if (context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT) {
                return;
            }

            try {
                const newRecord = context.newRecord;
                const oldRecord = context.oldRecord;

                log.debug('UE afterSubmit Fired', {
                    eventType: context.type,
                    settlementId: newRecord.id,
                    hasOldRecord: !!oldRecord
                });

                // Use getText() to get status text directly — avoids hardcoded ID mapping issues
                const newStatusText = newRecord.getText({ fieldId: 'custrecord_sust_settlement_status' }) || '';
                const oldStatusText = oldRecord ? (oldRecord.getText({ fieldId: 'custrecord_sust_settlement_status' }) || '') : '';

                log.debug('Status Values', {
                    newStatusText: newStatusText,
                    oldStatusText: oldStatusText,
                    areEqual: newStatusText === oldStatusText
                });

                // No status change — nothing to do
                if (newStatusText === oldStatusText) {
                    log.debug('No Status Change', 'Exiting — status unchanged at ' + newStatusText);
                    return;
                }

                log.audit('Settlement Status Change', {
                    settlementId: newRecord.id,
                    from: oldStatusText,
                    to: newStatusText
                });

                // Handle transitions that create vendor bills
                if (newStatusText === SETTLEMENT_STATUS.PROVISIONAL_PAID) {
                    log.audit('Bill Trigger', 'Provisional Paid — calling createProvisionalBill');
                    createProvisionalBill(newRecord.id);
                } else if (newStatusText === SETTLEMENT_STATUS.FINAL_SETTLED) {
                    log.audit('Bill Trigger', 'Final Settled — calling createFinalBill');
                    createFinalBill(newRecord.id);
                } else {
                    log.debug('No Bill Trigger', 'Status ' + newStatusText + ' does not trigger bill creation');
                }

                // Set approval fields when moving to Completed or beyond
                if (newStatusText === SETTLEMENT_STATUS.COMPLETED &&
                    oldStatusText === SETTLEMENT_STATUS.DRAFT) {
                    setApprovalFields(newRecord.id);
                }

            } catch (e) {
                log.error('Settlement Status Change Error', e.toString() + '\n' + (e.stack || ''));
                // Non-blocking: don't throw so the settlement save still succeeds
            }
        };

        /**
         * Create a provisional vendor bill
         */
        function createProvisionalBill(settlementId) {
            try {
                const settlement = record.load({
                    type: 'customrecord_sust_settlement_record',
                    id: settlementId
                });

                const vendorId = settlement.getValue({ fieldId: 'custrecord_sust_settlement_vendor' });
                const settlementDate = settlement.getValue({ fieldId: 'custrecord_sust_settlement_date' });
                const provisionalAmount = parseFloat(settlement.getValue({ fieldId: 'custrecord_sust_settlement_provisional' }) || 0);
                const existingProvBill = settlement.getValue({ fieldId: 'custrecord_sust_settlement_prov_bill' });

                // Don't create if provisional bill already exists
                if (existingProvBill) {
                    log.debug('Provisional Bill Exists', 'Settlement ' + settlementId + ' already has provisional bill ' + existingProvBill);
                    return;
                }

                // Don't create if no provisional amount
                if (provisionalAmount <= 0) {
                    log.debug('No Provisional Amount', 'Settlement ' + settlementId + ' has no provisional amount — skipping bill creation');
                    return;
                }

                if (!vendorId) {
                    log.error('No Vendor', 'Settlement ' + settlementId + ' has no vendor — cannot create bill');
                    return;
                }

                log.audit('Creating Provisional Bill', {
                    settlementId: settlementId,
                    vendorId: vendorId,
                    amount: provisionalAmount
                });

                const refNumber = getBillReferenceNumber(settlement, settlementId);

                const bill = record.create({
                    type: record.Type.VENDOR_BILL,
                    isDynamic: false
                });

                bill.setValue({ fieldId: 'entity', value: parseInt(vendorId, 10) });
                bill.setValue({ fieldId: 'tranid', value: refNumber + '-PROV' });

                if (settlementDate) {
                    bill.setValue({ fieldId: 'trandate', value: new Date(settlementDate) });
                }

                bill.setValue({
                    fieldId: 'memo',
                    value: 'Provisional Settlement Payment - Settlement #' + settlementId
                });

                // Add expense line
                // v2 SETTLE-009: write line via helper (item or expense fallback)
                writeBillLine(bill, provisionalAmount, 'Material Settlement ' + settlementId + ' — Provisional');

                const billId = bill.save();

                log.audit('Provisional Bill Created', {
                    billId: billId,
                    settlementId: settlementId,
                    amount: provisionalAmount
                });

                // Link bill to settlement
                record.submitFields({
                    type: 'customrecord_sust_settlement_record',
                    id: settlementId,
                    values: {
                        custrecord_sust_settlement_prov_bill: billId
                    }
                });

            } catch (e) {
                log.error('Error Creating Provisional Bill', {
                    settlementId: settlementId,
                    error: e.toString(),
                    stack: e.stack || ''
                });
                // Non-blocking: settlement status still changes
            }
        }

        /**
         * Create a final vendor bill for the balance due
         */
        function createFinalBill(settlementId) {
            try {
                log.debug('createFinalBill START', 'Loading settlement ' + settlementId);

                const settlement = record.load({
                    type: 'customrecord_sust_settlement_record',
                    id: settlementId
                });

                const vendorId = settlement.getValue({ fieldId: 'custrecord_sust_settlement_vendor' });
                const settlementDate = settlement.getValue({ fieldId: 'custrecord_sust_settlement_date' });
                const netValue = parseFloat(settlement.getValue({ fieldId: 'custrecord_sust_settlement_net_value' }) || 0);
                const provisionalPaid = parseFloat(settlement.getValue({ fieldId: 'custrecord_sust_settlement_provisional' }) || 0);
                const existingFinalBill = settlement.getValue({ fieldId: 'custrecord_sust_settlement_bill' });
                const balanceDue = netValue - provisionalPaid;

                log.debug('createFinalBill Values', {
                    vendorId: vendorId,
                    settlementDate: settlementDate,
                    netValue: netValue,
                    provisionalPaid: provisionalPaid,
                    balanceDue: balanceDue,
                    existingFinalBill: existingFinalBill,
                    expenseAccount: configLib.get('settlementExpenseAccount')
                });

                // Don't create if final bill already exists
                if (existingFinalBill) {
                    log.debug('Final Bill Exists', 'Settlement ' + settlementId + ' already has final bill ' + existingFinalBill);
                    return;
                }

                if (!vendorId) {
                    log.error('No Vendor', 'Settlement ' + settlementId + ' has no vendor — cannot create bill');
                    return;
                }

                // If balance due is zero, no bill needed
                if (balanceDue === 0) {
                    log.audit('Zero Balance Due', 'Settlement ' + settlementId + ' has zero balance — no final bill needed');
                    return;
                }

                // If balance is negative (overpaid), log warning for manual handling
                if (balanceDue < 0) {
                    log.audit('Negative Balance Due', {
                        settlementId: settlementId,
                        balanceDue: balanceDue,
                        message: 'Provisional payment exceeded net value. Manual vendor credit may be required.'
                    });
                    // Still create the bill as a negative amount for visibility
                }

                log.audit('Creating Final Bill', {
                    settlementId: settlementId,
                    vendorId: vendorId,
                    netValue: netValue,
                    provisionalPaid: provisionalPaid,
                    balanceDue: balanceDue
                });

                const refNumber = getBillReferenceNumber(settlement, settlementId);

                // Deductions post as a separate VENDOR CREDIT so AP shows the full
                // story — gross bill netted by a credit — instead of a net-only bill.
                const penalties = parseFloat(settlement.getValue({ fieldId: 'custrecord_sust_settlement_penalties' }) || 0);
                const treatment = parseFloat(settlement.getValue({ fieldId: 'custrecord_sust_settlement_treatment' }) || 0);
                const deductions = penalties + treatment;
                const grossValue = parseFloat(settlement.getValue({ fieldId: 'custrecord_sust_settlement_gross_value' }) || 0);
                // Gross-bill mode needs a coherent gross: gross − deductions ≈ net.
                const grossMode = deductions > 0 && grossValue > 0
                    && Math.abs((grossValue - deductions) - netValue) < 0.01 && balanceDue > 0;
                const billAmount = grossMode ? (grossValue - provisionalPaid) : Math.abs(balanceDue);

                const bill = record.create({
                    type: record.Type.VENDOR_BILL,
                    isDynamic: false
                });

                bill.setValue({ fieldId: 'entity', value: parseInt(vendorId, 10) });
                bill.setValue({ fieldId: 'tranid', value: refNumber });

                if (settlementDate) {
                    bill.setValue({ fieldId: 'trandate', value: new Date(settlementDate) });
                }

                bill.setValue({
                    fieldId: 'memo',
                    value: grossMode
                        ? 'Final Settlement Payment - Settlement #' + settlementId + ' (gross; deductions on credit ' + refNumber + '-DED)'
                        : 'Final Settlement Payment - Settlement #' + settlementId
                });

                // v2 SETTLE-009: write line via helper (item or expense fallback)
                writeBillLine(bill, billAmount, 'Material Settlement ' + settlementId
                    + (grossMode ? ' — Gross Value' : ' — Final Balance'));

                const billId = bill.save();

                log.audit('Final Bill Created', {
                    billId: billId,
                    settlementId: settlementId,
                    billAmount: billAmount,
                    grossMode: grossMode
                });

                // Vendor credit for the deductions (gross mode only)
                let creditId = null;
                if (grossMode) {
                    try {
                        const credit = record.create({ type: record.Type.VENDOR_CREDIT, isDynamic: false });
                        credit.setValue({ fieldId: 'entity', value: parseInt(vendorId, 10) });
                        credit.setValue({ fieldId: 'tranid', value: refNumber + '-DED' });
                        if (settlementDate) credit.setValue({ fieldId: 'trandate', value: new Date(settlementDate) });
                        credit.setValue({
                            fieldId: 'memo',
                            value: 'Settlement #' + settlementId + ' quality deductions: penalties $' + penalties.toFixed(2)
                                + ' + treatment $' + treatment.toFixed(2) + ' (nets bill ' + refNumber + ')'
                        });
                        writeBillLine(credit, deductions, 'Material Settlement ' + settlementId + ' — Quality Deductions');
                        creditId = credit.save();
                        log.audit('Deduction Credit Created', {
                            creditId: creditId, settlementId: settlementId, deductions: deductions
                        });
                    } catch (eCredit) {
                        log.error('Deduction Credit Failed',
                            'Settlement ' + settlementId + ': ' + eCredit.message
                            + ' — bill posted GROSS ($' + billAmount.toFixed(2) + '); create the credit manually or the vendor is overpaid by $' + deductions.toFixed(2));
                    }
                }

                // Link bill to settlement and update balance due
                const updateValues = {
                    custrecord_sust_settlement_bill: billId,
                    custrecord_sust_settlement_balance_due: balanceDue
                };
                record.submitFields({
                    type: 'customrecord_sust_settlement_record',
                    id: settlementId,
                    values: updateValues
                });
                if (creditId) {
                    try {
                        const notes = settlement.getValue({ fieldId: 'custrecord_sust_settlement_notes' }) || '';
                        record.submitFields({
                            type: 'customrecord_sust_settlement_record', id: settlementId,
                            values: {
                                custrecord_sust_settlement_notes: notes
                                    + '\nAP: gross bill ' + refNumber + ' $' + billAmount.toFixed(2)
                                    + ' − vendor credit ' + refNumber + '-DED $' + deductions.toFixed(2)
                                    + ' = net $' + (billAmount - deductions).toFixed(2) + '.'
                            }
                        });
                    } catch (eNote) { log.debug('credit note skipped', eNote.message); }
                }

            } catch (e) {
                log.error('Error Creating Final Bill', {
                    settlementId: settlementId,
                    error: e.toString(),
                    stack: e.stack || ''
                });
                // Non-blocking: settlement status still changes
            }
        }

        /**
         * Set approval fields when settlement is completed
         */
        function setApprovalFields(settlementId) {
            try {
                const currentUser = runtime.getCurrentUser().id;
                record.submitFields({
                    type: 'customrecord_sust_settlement_record',
                    id: settlementId,
                    values: {
                        custrecord_sust_settlement_approved_by: currentUser,
                        custrecord_sust_settlement_approved_date: new Date()
                    }
                });
                log.debug('Approval Fields Set', 'Settlement ' + settlementId + ' approved by user ' + currentUser);
            } catch (e) {
                log.debug('Error setting approval fields', e.toString());
                // Non-blocking
            }
        }

        return {
            afterSubmit: afterSubmit
        };

    });
