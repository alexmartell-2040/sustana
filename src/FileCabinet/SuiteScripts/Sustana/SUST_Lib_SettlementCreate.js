/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 */

/**
 * SUST_Lib_SettlementCreate.js
 *
 * v2.3 (June 2026): Shared settlement-creation library.
 *
 * Encapsulates the creation of a LINE-SCOPED Sustana Recovery settlement record so the
 * same logic is used by:
 *   - SUST_UE_ItemReceipt_CreateSettlement (conditional auto-create at receipt), and
 *   - SUST_SL_CreateLineSettlement (on-demand line-picker Suitelet, incl. settle-before-receipt from a PO).
 *
 * Line-level model (v2.3): one settlement record per scrap line, anchored to the
 * source PO + line. Settlement records carry custrecord_sust_settle_po,
 * custrecord_sust_settlement_item_receipt, and custrecord_sust_settle_source_line.
 *
 * Extracted from the v1/v2 SUST_UE_ItemReceipt_CreateSettlement createSettlementRecord()
 * so behavior (schedule lookup, market price, pay-on-receipt override, treatment charge)
 * is preserved exactly; the only additions are the line-level FKs.
 */

define(['N/record', 'N/search', 'N/log', './SUST_Lib_MarketPrice'],
    function(record, search, log, marketPriceLib) {

        /**
         * Look up an item custom field value.
         */
        function lookupItemField(itemId, fieldId) {
            try {
                const lookup = search.lookupFields({ type: search.Type.ITEM, id: itemId, columns: [fieldId] });
                return lookup[fieldId];
            } catch (e) {
                log.error('lookupItemField', `Item: ${itemId}, Field: ${fieldId}, Error: ${e.toString()}`);
                return null;
            }
        }

        /**
         * Get a lot's quality attributes (moisture / contamination / fiber content / bale count).
         * These drive quality deductions on the settlement.
         */
        function getLotQuality(lotNumber) {
            try {
                const lotSearch = search.create({
                    type: 'inventorynumber',
                    filters: [['inventorynumber', 'is', lotNumber]],
                    columns: [
                        'custitemnumber_sust_moisture_pct',
                        'custitemnumber_sust_contamination_pct',
                        'custitemnumber_sust_fiber_content_pct',
                        'custitemnumber_sust_bale_count'
                    ]
                });
                const results = lotSearch.run().getRange({ start: 0, end: 1 });
                if (results.length > 0) {
                    const r = results[0];
                    return {
                        moisturePct: parseFloat(r.getValue('custitemnumber_sust_moisture_pct') || 0),
                        contaminationPct: parseFloat(r.getValue('custitemnumber_sust_contamination_pct') || 0),
                        fiberContentPct: parseFloat(r.getValue('custitemnumber_sust_fiber_content_pct') || 0),
                        baleCount: parseInt(r.getValue('custitemnumber_sust_bale_count') || 0, 10)
                    };
                }
            } catch (e) {
                log.error('getLotQuality', `Lot: ${lotNumber}, Error: ${e.toString()}`);
            }
            return { moisturePct: 0, contaminationPct: 0, fiberContentPct: 0, baleCount: 0 };
        }

        /**
         * Resolve a lot's internal id from its number string.
         */
        function resolveLotInternalId(lotNumber) {
            try {
                if (!lotNumber) return null;
                const s = search.create({
                    type: 'inventorynumber',
                    filters: [['inventorynumber', 'is', lotNumber]],
                    columns: ['internalid']
                });
                const res = s.run().getRange({ start: 0, end: 1 });
                return res.length > 0 ? parseInt(res[0].id, 10) : null;
            } catch (e) {
                log.error('resolveLotInternalId', `Lot: ${lotNumber}, Error: ${e.toString()}`);
                return null;
            }
        }

        /**
         * Find the settlement schedule for a vendor + item combination.
         */
        function findSettlementSchedule(vendorId, itemId) {
            try {
                if (!vendorId || !itemId) return null;
                const scheduleSearch = search.create({
                    type: 'customrecord_sust_settlement_schedule',
                    filters: [
                        ['custrecord_sust_schedule_vendor', 'anyof', vendorId],
                        'AND', ['custrecord_sust_schedule_item', 'anyof', itemId],
                        'AND', ['isinactive', 'is', 'F']
                    ],
                    columns: [
                        'internalid',
                        'custrecord_sust_schedule_method',
                        'custrecord_sust_schedule_base_price',
                        'custrecord_sust_schedule_market_ref',
                        'custrecord_sust_schedule_market_pct',
                        'custrecord_sust_schedule_market_adj',
                        'custrecord_sust_sched_proc_charge'
                    ]
                });
                const results = scheduleSearch.run().getRange({ start: 0, end: 1 });
                if (results.length > 0) {
                    const r = results[0];
                    return {
                        scheduleId: r.id,
                        methodId: r.getValue('custrecord_sust_schedule_method'),
                        methodText: r.getText('custrecord_sust_schedule_method'),
                        pricePerLb: parseFloat(r.getValue('custrecord_sust_schedule_base_price') || 0),
                        marketRefId: r.getValue('custrecord_sust_schedule_market_ref'),
                        marketRefText: r.getText('custrecord_sust_schedule_market_ref'),
                        marketPct: parseFloat(r.getValue('custrecord_sust_schedule_market_pct') || 100),
                        marketAdj: parseFloat(r.getValue('custrecord_sust_schedule_market_adj') || 0),
                        treatmentCharge: parseFloat(r.getValue('custrecord_sust_sched_proc_charge') || 0)
                    };
                }
            } catch (e) {
                log.error('findSettlementSchedule', `Vendor: ${vendorId}, Item: ${itemId}, Error: ${e.toString()}`);
            }
            return null;
        }

        /**
         * Dedup: find an existing settlement already bound to this source line.
         * Matches on source line key plus whichever anchor we have (IR or PO).
         * @returns {string|null} settlement internal id, or null
         */
        function findExistingLineSettlement(params) {
            try {
                const filters = [];
                if (params.sourceLine !== null && params.sourceLine !== undefined && params.sourceLine !== '') {
                    filters.push(['custrecord_sust_settle_source_line', 'equalto', parseInt(params.sourceLine, 10)]);
                    if (params.itemReceiptId) {
                        filters.push('AND', ['custrecord_sust_settlement_item_receipt', 'anyof', params.itemReceiptId]);
                    } else if (params.poId) {
                        filters.push('AND', ['custrecord_sust_settle_po', 'anyof', params.poId]);
                    }
                } else if (params.itemReceiptId) {
                    // No line key — fall back to IR-level dedup (legacy behavior)
                    filters.push(['custrecord_sust_settlement_item_receipt', 'anyof', params.itemReceiptId]);
                } else {
                    return null;
                }
                const s = search.create({
                    type: 'customrecord_sust_settlement_record',
                    filters: filters,
                    columns: ['internalid']
                });
                const res = s.run().getRange({ start: 0, end: 1 });
                return res.length > 0 ? res[0].id : null;
            } catch (e) {
                log.error('findExistingLineSettlement', e.toString());
                return null;
            }
        }

        /**
         * True when v is a positive integer internal-id (or an all-digit string).
         */
        function isNumericId(v) {
            return v !== null && v !== undefined && v !== '' && /^\d+$/.test(String(v).trim());
        }

        /**
         * Set a SELECT field defensively. NetSuite throws INVALID_NUMBER if a text token
         * (e.g. a market reference of "Custom") is passed to setValue on a list field.
         * Prefer setValue when we have a real internal id; otherwise fall back to setText
         * on the display value. Never let a single unresolvable list value abort the save.
         * @returns {boolean} whether the field was set
         */
        function setSelectField(rec, fieldId, idValue, textValue) {
            try {
                if (isNumericId(idValue)) {
                    rec.setValue({ fieldId: fieldId, value: parseInt(idValue, 10) });
                    return true;
                }
                // idValue wasn't a numeric id — it may itself be the display text.
                const text = (idValue !== null && idValue !== undefined && String(idValue).trim() !== '')
                    ? String(idValue) : textValue;
                if (text !== null && text !== undefined && String(text).trim() !== '') {
                    rec.setText({ fieldId: fieldId, text: String(text) });
                    return true;
                }
            } catch (e) {
                log.audit('Select field skipped',
                    `${fieldId}: could not resolve "${idValue}"/"${textValue}" to a list value — leaving blank (${e.message})`);
            }
            return false;
        }

        /**
         * Schedule-driven line value. Pure math shared by create + period-append.
         * @returns {Object} { netValue, marketPrice: number|null, marketRefId: number|null }
         */
        function computeScheduleValue(scheduleInfo, netWeight, recoveryPct) {
            const out = { netValue: 0, marketPrice: null, marketRefId: null };
            if (!scheduleInfo) return out;

            const methodText = scheduleInfo.methodText || '';
            const isMarketBased = (methodText === '% of Index' || methodText.indexOf('Recover') !== -1) && scheduleInfo.marketRefText;
            const isRecoveredMode = methodText.indexOf('Recover') !== -1;

            if (isMarketBased) {
                if (isNumericId(scheduleInfo.marketRefId)) out.marketRefId = parseInt(scheduleInfo.marketRefId, 10);
                const storedPrice = marketPriceLib.getLatestPrice(scheduleInfo.marketRefText);
                if (storedPrice && storedPrice.pricePerLb > 0) {
                    const pct = scheduleInfo.marketPct || 100;
                    const adj = scheduleInfo.marketAdj || 0;
                    const effective = (storedPrice.pricePerLb * pct / 100) + adj;
                    const recoveryFactor = (isRecoveredMode && recoveryPct > 0) ? (recoveryPct / 100) : 1;
                    out.netValue = netWeight * effective * recoveryFactor;
                    out.marketPrice = storedPrice.pricePerLb;
                }
            } else if (scheduleInfo.pricePerLb > 0) {
                out.netValue = netWeight * scheduleInfo.pricePerLb;
            }
            return out;
        }

        // ── Settlement cadence (vendor-driven weekly/monthly aggregation) ──────

        /**
         * Vendor's settlement cadence text. Defaults to 'Per Receipt' when the
         * field is empty or unreadable.
         */
        function getVendorCadence(vendorId) {
            try {
                const lk = search.lookupFields({
                    type: 'vendor', id: vendorId,
                    columns: ['custentity_sust_settlement_cadence']
                });
                const v = lk.custentity_sust_settlement_cadence;
                if (Array.isArray(v) && v.length > 0 && v[0].text) return v[0].text;
            } catch (e) {
                log.debug('getVendorCadence', `Vendor ${vendorId}: ${e.message}`);
            }
            return 'Per Receipt';
        }

        /**
         * Period key for a cadence + date: Monthly → '2026-07', Weekly → ISO week '2026-W30'.
         */
        function periodKeyFor(cadence, dateVal) {
            const d = dateVal ? new Date(dateVal) : new Date();
            if (cadence === 'Monthly') {
                return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
            }
            // ISO-8601 week number (week starts Monday; week 1 contains Jan 4)
            const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
            const day = t.getUTCDay() || 7;
            t.setUTCDate(t.getUTCDate() + 4 - day);
            const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
            const week = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
            return t.getUTCFullYear() + '-W' + ('0' + week).slice(-2);
        }

        /**
         * Find the open (Draft) aggregated settlement for a vendor + period.
         * @returns {Object|null} { id, sources: [] }
         */
        function findOpenPeriodSettlement(vendorId, periodKey) {
            try {
                const res = search.create({
                    type: 'customrecord_sust_settlement_record',
                    filters: [
                        ['custrecord_sust_settlement_vendor', 'anyof', vendorId], 'AND',
                        ['custrecord_sust_settle_period_key', 'is', periodKey], 'AND',
                        ['isinactive', 'is', 'F']
                    ],
                    columns: ['internalid', 'custrecord_sust_settlement_status', 'custrecord_sust_settle_agg_sources']
                }).run().getRange({ start: 0, end: 10 });
                for (let i = 0; i < res.length; i++) {
                    if ((res[i].getText({ name: 'custrecord_sust_settlement_status' }) || '') !== 'Draft') continue;
                    let sources = [];
                    try {
                        sources = JSON.parse(res[i].getValue({ name: 'custrecord_sust_settle_agg_sources' }) || '[]');
                        if (!Array.isArray(sources)) sources = [];
                    } catch (ePar) { sources = []; }
                    return { id: res[i].id, sources: sources };
                }
            } catch (e) {
                log.error('findOpenPeriodSettlement', `Vendor ${vendorId} / ${periodKey}: ${e.message}`);
            }
            return null;
        }

        /**
         * Roll one receipt line into an existing open period settlement:
         * accumulate weights + value, track the source key, append notes.
         */
        function appendLineToSettlement(settlementId, params, sourceKey) {
            const recoveryPct = (params.recoveryPct !== null && params.recoveryPct !== undefined && params.recoveryPct !== '')
                ? parseFloat(params.recoveryPct) : 100;
            const grossWeight = parseFloat(params.grossWeight || 0);
            const netWeight = grossWeight * (recoveryPct / 100);
            const scheduleInfo = params.scheduleInfo || findSettlementSchedule(params.vendorId, params.itemId);
            const calc = computeScheduleValue(scheduleInfo, netWeight, recoveryPct);

            const rec = record.load({ type: 'customrecord_sust_settlement_record', id: settlementId });

            const gross = (parseFloat(rec.getValue({ fieldId: 'custrecord_sust_settlement_gross_lbs' })) || 0) + grossWeight;
            const net = (parseFloat(rec.getValue({ fieldId: 'custrecord_sust_settlement_net_lbs' })) || 0) + netWeight;
            rec.setValue({ fieldId: 'custrecord_sust_settlement_gross_lbs', value: gross });
            rec.setValue({ fieldId: 'custrecord_sust_settlement_net_lbs', value: net });
            rec.setValue({ fieldId: 'custrecord_sust_settlement_recovery_pct', value: gross > 0 ? (net / gross) * 100 : 100 });

            const value = (parseFloat(rec.getValue({ fieldId: 'custrecord_sust_settlement_net_value' })) || 0) + calc.netValue;
            rec.setValue({ fieldId: 'custrecord_sust_settlement_net_value', value: value });
            if (calc.marketPrice !== null && !rec.getValue({ fieldId: 'custrecord_sust_settlement_market_price' })) {
                rec.setValue({ fieldId: 'custrecord_sust_settlement_market_price', value: calc.marketPrice });
            }

            let sources = [];
            try {
                sources = JSON.parse(rec.getValue({ fieldId: 'custrecord_sust_settle_agg_sources' }) || '[]');
                if (!Array.isArray(sources)) sources = [];
            } catch (ePar) { sources = []; }
            sources.push(sourceKey);
            rec.setValue({ fieldId: 'custrecord_sust_settle_agg_sources', value: JSON.stringify(sources) });

            const lotNumbers = (params.lotDetails || []).map(function(d) { return d.lotNumber; }).filter(Boolean);
            const addNote = '+ ' + (params.sourceTag || sourceKey) + ': ' + grossWeight + ' lbs gross'
                + (lotNumbers.length ? ' (lots ' + lotNumbers.join(', ') + ')' : '');
            const notes = (rec.getValue({ fieldId: 'custrecord_sust_settlement_notes' }) || '') + '\n' + addNote;
            rec.setValue({ fieldId: 'custrecord_sust_settlement_notes', value: notes.substring(0, 3900) });

            rec.save();
            writeSliceRecord(settlementId, params, netWeight, calc.netValue);
            log.audit('Settlement Line Appended',
                `Settlement ${settlementId} += ${grossWeight} lbs from ${params.sourceTag || sourceKey} | new gross ${gross} lbs | new value $${value.toFixed(2)}`);
            return settlementId;
        }

        /**
         * Write a Settlement Receipt Slice child record so the aggregated parent
         * shows exactly which receipt lines make it up (native sublist on the
         * settlement record). Guarded — a slice failure never blocks settlement
         * creation.
         */
        function writeSliceRecord(settlementId, params, netWeight, sliceValue) {
            try {
                const slice = record.create({ type: 'customrecord_sust_settle_slice' });
                slice.setValue({ fieldId: 'custrecord_sust_slice_settlement', value: settlementId });
                if (params.itemReceiptId) {
                    slice.setValue({ fieldId: 'custrecord_sust_slice_ir', value: parseInt(params.itemReceiptId, 10) });
                }
                if (params.sourceLine !== null && params.sourceLine !== undefined && params.sourceLine !== '') {
                    slice.setValue({ fieldId: 'custrecord_sust_slice_source_line', value: parseInt(params.sourceLine, 10) });
                }
                if (params.lotInternalId) {
                    slice.setValue({ fieldId: 'custrecord_sust_slice_lot', value: params.lotInternalId });
                }
                slice.setValue({ fieldId: 'custrecord_sust_slice_date', value: new Date(params.tranDate || Date.now()) });
                slice.setValue({ fieldId: 'custrecord_sust_slice_gross_lbs', value: parseFloat(params.grossWeight || 0) });
                slice.setValue({ fieldId: 'custrecord_sust_slice_net_lbs', value: netWeight });
                slice.setValue({ fieldId: 'custrecord_sust_slice_value', value: sliceValue || 0 });
                return slice.save();
            } catch (e) {
                log.error('writeSliceRecord', `Settlement ${settlementId}: ${e.message}`);
                return null;
            }
        }

        /**
         * Cadence-aware entry point. Per-Receipt vendors get one settlement per
         * line (existing behavior); Weekly/Monthly vendors get one draft
         * settlement per period that receipt lines append into.
         * @returns {Object} { id, action: 'created'|'appended'|'skipped', cadence, periodKey }
         */
        function createOrAppendLineSettlement(params) {
            const cadence = getVendorCadence(params.vendorId);
            if (cadence !== 'Weekly' && cadence !== 'Monthly') {
                return { id: createLineSettlement(params), action: 'created', cadence: cadence, periodKey: null };
            }

            const periodKey = periodKeyFor(cadence, params.tranDate);
            const sourceKey = 'ir:' + (params.itemReceiptId || ('po' + params.poId)) + ':' + params.sourceLine;

            const open = findOpenPeriodSettlement(params.vendorId, periodKey);
            if (open) {
                if (open.sources.indexOf(sourceKey) !== -1) {
                    log.debug('Aggregated Line Exists', `${sourceKey} already in settlement ${open.id}`);
                    return { id: open.id, action: 'skipped', cadence: cadence, periodKey: periodKey };
                }
                appendLineToSettlement(open.id, params, sourceKey);
                return { id: open.id, action: 'appended', cadence: cadence, periodKey: periodKey };
            }

            // First line of the period — create, then stamp the period identity.
            const id = createLineSettlement(params);
            record.submitFields({
                type: 'customrecord_sust_settlement_record', id: id,
                values: {
                    custrecord_sust_settle_period_key: periodKey,
                    custrecord_sust_settle_agg_sources: JSON.stringify([sourceKey])
                }
            });
            const firstRecovery = (params.recoveryPct !== null && params.recoveryPct !== undefined && params.recoveryPct !== '')
                ? parseFloat(params.recoveryPct) : 100;
            const firstNet = parseFloat(params.grossWeight || 0) * (firstRecovery / 100);
            const firstCalc = computeScheduleValue(
                params.scheduleInfo || findSettlementSchedule(params.vendorId, params.itemId),
                firstNet, firstRecovery);
            writeSliceRecord(id, params, firstNet, firstCalc.netValue);
            log.audit('Period Settlement Opened',
                `Settlement ${id} opens ${cadence} period ${periodKey} for vendor ${params.vendorId}`);
            return { id: id, action: 'created', cadence: cadence, periodKey: periodKey };
        }

        /**
         * Create a line-scoped settlement record.
         *
         * @param {Object} params
         * @param {number} params.vendorId        - vendor (entity)
         * @param {Date|string} params.tranDate    - settlement date
         * @param {number} [params.poId]            - source PO (custrecord_sust_settle_po)
         * @param {number} [params.itemReceiptId]   - source IR (custrecord_sust_settlement_item_receipt)
         * @param {number} [params.sourceLine]      - source line key (custrecord_sust_settle_source_line)
         * @param {number} params.itemId            - primary item (for schedule lookup)
         * @param {number} params.grossWeight       - line gross lbs
         * @param {number} [params.recoveryPct]     - yield %, default 100
         * @param {number} [params.lotInternalId]   - settlement lot
         * @param {Array}  [params.lotDetails]      - [{lotNumber}] for notes
         * @param {Object} [params.scheduleInfo]    - pre-resolved schedule; if omitted, looked up from vendor+item
         * @param {string} [params.sourceTag]       - free text for the notes header (e.g. "Item Receipt #123 line 2")
         * @returns {number} new settlement internal id
         */
        function createLineSettlement(params) {
            const recoveryPct = (params.recoveryPct !== null && params.recoveryPct !== undefined && params.recoveryPct !== '')
                ? parseFloat(params.recoveryPct) : 100;
            const grossWeight = parseFloat(params.grossWeight || 0);
            const netWeight = grossWeight * (recoveryPct / 100);

            const scheduleInfo = params.scheduleInfo || findSettlementSchedule(params.vendorId, params.itemId);

            const settlement = record.create({ type: 'customrecord_sust_settlement_record' });

            settlement.setValue({ fieldId: 'custrecord_sust_settlement_vendor', value: params.vendorId });
            settlement.setValue({ fieldId: 'custrecord_sust_settlement_date', value: new Date(params.tranDate || Date.now()) });
            settlement.setText({ fieldId: 'custrecord_sust_settlement_status', text: 'Draft' });

            // Explicitly set a valid Settlement Mode so the record never falls back to a
            // field default. On this account an unset mode resolves to an unusable "Custom"
            // value that throws INVALID_NUMBER at save (mode-driven field-lock is applied by
            // SUST_UE_SettlementModeLock; Auto = schedule-driven). Guarded so a mode-field
            // config issue can never abort settlement creation.
            try {
                settlement.setText({ fieldId: 'custrecord_sust_settlement_mode', text: scheduleInfo ? 'Auto' : 'Calculator' });
            } catch (eMode) {
                log.audit('Settlement mode preset skipped', eMode.message);
            }

            // Method + schedule link (defensive: schedule fields may hold text, not ids)
            if (scheduleInfo && (scheduleInfo.methodId || scheduleInfo.methodText)) {
                setSelectField(settlement, 'custrecord_sust_settlement_method', scheduleInfo.methodId, scheduleInfo.methodText);
                if (isNumericId(scheduleInfo.scheduleId)) {
                    settlement.setValue({ fieldId: 'custrecord_sust_settlement_schedule', value: parseInt(scheduleInfo.scheduleId, 10) });
                }
            } else {
                settlement.setText({ fieldId: 'custrecord_sust_settlement_method', text: 'Received Pricing' });
            }

            // Pay-on-receipt vendor override (v2 SETTLE-017): force Received Pricing
            try {
                const vLookup = search.lookupFields({
                    type: search.Type.VENDOR, id: params.vendorId, columns: ['custentity_sust_pay_on_receipt']
                });
                const payOnReceipt = vLookup.custentity_sust_pay_on_receipt;
                if (payOnReceipt === true || payOnReceipt === 'T') {
                    settlement.setText({ fieldId: 'custrecord_sust_settlement_method', text: 'Received Pricing' });
                    log.audit('Pay-on-Receipt Override', `Vendor ${params.vendorId}: forcing Received Pricing.`);
                }
            } catch (porErr) {
                log.debug('Pay-on-Receipt check skipped', porErr.message);
            }

            // Weights / yield
            settlement.setValue({ fieldId: 'custrecord_sust_settlement_gross_lbs', value: grossWeight });
            settlement.setValue({ fieldId: 'custrecord_sust_settlement_net_lbs', value: netWeight });
            settlement.setValue({ fieldId: 'custrecord_sust_settlement_recovery_pct', value: recoveryPct });

            // Initial net value (schedule-driven; mirrors v2 logic)
            const calc = computeScheduleValue(scheduleInfo, netWeight, recoveryPct);
            if (calc.marketPrice !== null) {
                settlement.setValue({ fieldId: 'custrecord_sust_settlement_market_price', value: calc.marketPrice });
            }
            if (calc.marketRefId !== null) {
                settlement.setValue({ fieldId: 'custrecord_sust_settlement_market_source', value: calc.marketRefId });
            }
            if (scheduleInfo && scheduleInfo.treatmentCharge > 0) {
                settlement.setValue({ fieldId: 'custrecord_sust_settlement_treatment', value: scheduleInfo.treatmentCharge });
            }
            const netSettlementValue = calc.netValue;
            settlement.setValue({ fieldId: 'custrecord_sust_settlement_net_value', value: netSettlementValue });

            // Line-level source FKs (v2.3)
            if (params.poId) {
                settlement.setValue({ fieldId: 'custrecord_sust_settle_po', value: params.poId });
            }
            if (params.itemReceiptId) {
                settlement.setValue({ fieldId: 'custrecord_sust_settlement_item_receipt', value: params.itemReceiptId });
            }
            if (params.sourceLine !== null && params.sourceLine !== undefined && params.sourceLine !== '') {
                settlement.setValue({ fieldId: 'custrecord_sust_settle_source_line', value: parseInt(params.sourceLine, 10) });
            }
            if (params.lotInternalId) {
                settlement.setValue({ fieldId: 'custrecord_sust_settlement_lot', value: params.lotInternalId });
            }

            // Notes
            const lotNumbers = (params.lotDetails || []).map(function(d) { return d.lotNumber; }).filter(Boolean);
            const notesHeader = params.sourceTag ? `Auto-generated from ${params.sourceTag}` : 'Generated settlement';
            const notes = notesHeader + (lotNumbers.length ? `\nLots: ${lotNumbers.join(', ')}` : '');
            settlement.setValue({ fieldId: 'custrecord_sust_settlement_notes', value: notes });

            const settlementId = settlement.save();
            log.audit('Settlement Created (line-scoped)',
                `ID ${settlementId} | vendor ${params.vendorId} | po ${params.poId || '-'} | ir ${params.itemReceiptId || '-'} | line ${params.sourceLine !== undefined ? params.sourceLine : '-'} | net $${netSettlementValue.toFixed(2)}`);
            return settlementId;
        }

        return {
            lookupItemField: lookupItemField,
            getLotQuality: getLotQuality,
            resolveLotInternalId: resolveLotInternalId,
            findSettlementSchedule: findSettlementSchedule,
            findExistingLineSettlement: findExistingLineSettlement,
            createLineSettlement: createLineSettlement,
            computeScheduleValue: computeScheduleValue,
            getVendorCadence: getVendorCadence,
            periodKeyFor: periodKeyFor,
            findOpenPeriodSettlement: findOpenPeriodSettlement,
            createOrAppendLineSettlement: createOrAppendLineSettlement
        };

    });
