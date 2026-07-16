/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */

/**
 * SUST_UE_SO_IndexPricing.js
 *
 * Sell-side index pricing (the customer half of the 1:30 pricing moment).
 *
 * beforeSubmit (CREATE/EDIT, salesorder): for each line, finds an active
 * Sale-direction settlement schedule for this customer + item and prices the
 * line from the published index, effective-dated to the transaction date:
 *
 *   ratePerLb = getPriceForDate(indexText, trandate).pricePerLb x pct/100 + adjPerLb
 *
 * The line description carries the formula so the pricing is self-explanatory
 * on screen (e.g. "RISI SOP $200.00/ton x 100% + $10.00/ton = $210.00/ton").
 * Lines whose rate was manually set (different from the previous auto rate)
 * are left alone only when no schedule matches; a matching Sale schedule
 * always reprices — index pricing is the contract.
 *
 * beforeLoad (VIEW/EDIT): renders a banner listing which lines are index-priced.
 *
 * Author: MHI
 * Date: July 2026
 */

define(['N/search', 'N/runtime', 'N/log', 'N/ui/serverWidget', './SUST_Lib_MarketPrice', './SUST_Lib_Units'],
    function(search, runtime, log, serverWidget, marketPriceLib, units) {

        /**
         * Find the active Sale-direction schedule for a customer + item.
         * @returns {Object|null} {scheduleId, marketRefText, marketPct, marketAdj, basePrice, methodText}
         */
        function findSaleSchedule(customerId, itemId) {
            if (!customerId || !itemId) return null;
            try {
                const s = search.create({
                    type: 'customrecord_sust_settlement_schedule',
                    filters: [
                        ['custrecord_sust_sched_customer', 'anyof', customerId],
                        'AND', ['custrecord_sust_schedule_item', 'anyof', itemId],
                        'AND', ['custrecord_sust_schedule_active', 'is', 'T'],
                        'AND', ['isinactive', 'is', 'F']
                    ],
                    columns: [
                        'internalid',
                        'custrecord_sust_sched_direction',
                        'custrecord_sust_schedule_method',
                        'custrecord_sust_schedule_base_price',
                        'custrecord_sust_schedule_market_ref',
                        'custrecord_sust_schedule_market_pct',
                        'custrecord_sust_schedule_market_adj'
                    ]
                });
                let found = null;
                s.run().each(function(r) {
                    // Direction matched by display text — only Sale schedules price SOs
                    if (r.getText('custrecord_sust_sched_direction') !== 'Sale') return true;
                    found = {
                        scheduleId: r.id,
                        methodText: r.getText('custrecord_sust_schedule_method') || '',
                        basePrice: parseFloat(r.getValue('custrecord_sust_schedule_base_price') || 0),
                        marketRefText: r.getText('custrecord_sust_schedule_market_ref') || '',
                        marketPct: parseFloat(r.getValue('custrecord_sust_schedule_market_pct') || 100),
                        marketAdj: parseFloat(r.getValue('custrecord_sust_schedule_market_adj') || 0)
                    };
                    return false;
                });
                return found;
            } catch (e) {
                log.error('findSaleSchedule', `Customer ${customerId}, item ${itemId}: ${e.message}`);
                return null;
            }
        }

        /**
         * Compute the line rate ($/lb) from a Sale schedule as of tranDate.
         * @returns {Object|null} {ratePerLb, memo} or null when unpriceable
         */
        function priceFromSchedule(schedule, tranDate) {
            // Fixed Price schedules sell at the base price
            if (schedule.methodText === 'Fixed Price' && schedule.basePrice > 0) {
                return {
                    ratePerLb: schedule.basePrice,
                    memo: 'Fixed Price ' + units.formatPerTon(schedule.basePrice)
                };
            }

            if (!schedule.marketRefText || schedule.marketRefText === marketPriceLib.MANUAL_SOURCE_TEXT) {
                return null;
            }

            const priceData = marketPriceLib.getPriceForDate(schedule.marketRefText, tranDate);
            if (!priceData || !(priceData.pricePerLb > 0)) return null;

            const pct = schedule.marketPct || 100;
            const adj = schedule.marketAdj || 0;
            const ratePerLb = (priceData.pricePerLb * pct / 100) + adj;

            let memo = schedule.marketRefText + ' ' + units.formatPerTon(priceData.pricePerLb);
            if (pct !== 100) memo += ' x ' + pct + '%';
            if (adj !== 0) memo += (adj > 0 ? ' + ' : ' − ') + units.formatPerTon(Math.abs(adj));
            memo += ' = ' + units.formatPerTon(ratePerLb);
            return { ratePerLb: ratePerLb, memo: memo };
        }

        function beforeSubmit(context) {
            try {
                if (context.type !== context.UserEventType.CREATE &&
                    context.type !== context.UserEventType.EDIT) {
                    return;
                }

                const rec = context.newRecord;
                const customerId = rec.getValue({ fieldId: 'entity' });
                const tranDate = rec.getValue({ fieldId: 'trandate' }) || new Date();
                if (!customerId) return;

                const lineCount = rec.getLineCount({ sublistId: 'item' });
                const priced = [];

                for (let i = 0; i < lineCount; i++) {
                    try {
                        const itemId = rec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
                        if (!itemId) continue;

                        const schedule = findSaleSchedule(customerId, itemId);
                        if (!schedule) continue;

                        const pricing = priceFromSchedule(schedule, tranDate);
                        if (!pricing) {
                            log.audit('Index Price Unavailable',
                                `SO line ${i + 1}: Sale schedule ${schedule.scheduleId} matched but no index value for "${schedule.marketRefText}" — rate left as-is.`);
                            continue;
                        }

                        const rate = Math.round(pricing.ratePerLb * 1000000) / 1000000;
                        const qty = parseFloat(rec.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i }) || 0);

                        rec.setSublistValue({ sublistId: 'item', fieldId: 'price', line: i, value: -1 }); // -1 = custom price level
                        rec.setSublistValue({ sublistId: 'item', fieldId: 'rate', line: i, value: rate });
                        if (qty > 0) {
                            rec.setSublistValue({
                                sublistId: 'item', fieldId: 'amount', line: i,
                                value: Math.round(rate * qty * 100) / 100
                            });
                        }
                        rec.setSublistValue({ sublistId: 'item', fieldId: 'description', line: i, value: pricing.memo });
                        priced.push({ line: i + 1, rate: rate, memo: pricing.memo });
                    } catch (lineErr) {
                        log.error('Index pricing line failed', `Line ${i + 1}: ${lineErr.message}`);
                    }
                }

                if (priced.length > 0) {
                    log.audit('SO Index Pricing Applied',
                        priced.map(function(p) { return `line ${p.line}: $${p.rate}/lb (${p.memo})`; }).join('; '));
                }
            } catch (e) {
                log.error('SUST_UE_SO_IndexPricing.beforeSubmit failed', e.message + '\n' + (e.stack || ''));
            }
        }

        function beforeLoad(context) {
            try {
                if (context.type !== context.UserEventType.VIEW &&
                    context.type !== context.UserEventType.EDIT) {
                    return;
                }
                const rec = context.newRecord;
                const lineCount = rec.getLineCount({ sublistId: 'item' });
                const indexed = [];
                for (let i = 0; i < lineCount; i++) {
                    const desc = rec.getSublistValue({ sublistId: 'item', fieldId: 'description', line: i }) || '';
                    if (desc.indexOf('/ton') !== -1 && desc.indexOf('=') !== -1) {
                        indexed.push('Line ' + (i + 1) + ': ' + desc);
                    }
                }
                if (indexed.length === 0) return;

                const html = ''
                    + '<div style="border: 2px solid #2976F3; background: #eaf1fe; color: #1e3a8a;'
                    + ' padding: 10px 14px; margin: 8px 0; border-radius: 6px; font-family: Arial, sans-serif; font-size: 12px;">'
                    + '<strong>Index-priced order:</strong> line rates are set from the customer\'s Sale schedule, effective-dated to the order date.'
                    + '<br>' + indexed.map(escapeHtml).join('<br>')
                    + '</div>';

                const fld = context.form.addField({
                    id: 'custpage_index_pricing_note',
                    type: serverWidget.FieldType.INLINEHTML,
                    label: 'Index Pricing'
                });
                fld.defaultValue = html;
            } catch (e) {
                log.error('SUST_UE_SO_IndexPricing.beforeLoad failed', e.message);
            }
        }

        function escapeHtml(s) {
            return String(s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        return {
            beforeSubmit: beforeSubmit,
            beforeLoad: beforeLoad
        };
    });
