/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 */

/**
 * SUST_Lib_MarketPrice.js
 *
 * Library module for published-index pricing (RISI-style recovered-fiber indices).
 *
 * Indices are entered manually (or by the demo seeder) in $/ton and stored on
 * customrecord_sust_market_price in $/lb (all math in this project runs in lbs —
 * see SUST_Lib_Units). Lookups are effective-dated: getPriceForDate returns the
 * most recent index value on or before the requested date, which is how a
 * monthly published index with a lag behaves.
 *
 * IMPORTANT: index sources are matched by the DISPLAY TEXT of
 * customlist_sust_market_price_source. The values in INDEX_MAP below must match
 * that list exactly (Jest-tested).
 *
 * Author: MHI
 * Date: July 2026
 */

define(['N/record', 'N/search', 'N/log', 'N/format', './SUST_Lib_Units'],
    function(record, search, log, format, units) {

        /**
         * Published index sources. Keys are internal handles; sourceText must equal
         * the customlist_sust_market_price_source display value.
         */
        const INDEX_MAP = {
            RISI_SOP:          { sourceText: 'RISI SOP' },
            RISI_WHITE_LEDGER: { sourceText: 'RISI White Ledger' },
            RISI_MIXED_PAPER:  { sourceText: 'RISI Mixed Paper' },
            RISI_MOP:          { sourceText: 'RISI Mixed Office Paper' }
        };

        const MANUAL_SOURCE_TEXT = 'Custom/Manual Entry';

        /** All known index source display texts. */
        function listIndexSources() {
            return Object.keys(INDEX_MAP).map(function(k) { return INDEX_MAP[k].sourceText; });
        }

        /**
         * Store one index price observation. Idempotent: an existing record for the
         * same date + source is updated, otherwise a new one is created.
         *
         * @param {Object} params
         * @param {string} params.sourceText   display text of the index (e.g. 'RISI SOP')
         * @param {Date|string} params.date    effective date of the published value
         * @param {number} params.pricePerTon  published index value in $/ton
         * @returns {number|null} saved record internal id, or null on error
         */
        function storeIndexPrice(params) {
            try {
                const sourceText = params.sourceText;
                if (!sourceText) {
                    log.error('storeIndexPrice', 'sourceText is required');
                    return null;
                }
                const effectiveDate = new Date(params.date);
                effectiveDate.setHours(0, 0, 0, 0);
                const pricePerTon = parseFloat(params.pricePerTon) || 0;
                const pricePerLb = units.perTonToPerLb(pricePerTon);

                const formattedDate = format.format({ value: effectiveDate, type: format.Type.DATE });

                // Find existing record for date + source (source matched by text)
                let existingRecordId = null;
                search.create({
                    type: 'customrecord_sust_market_price',
                    filters: [
                        ['custrecord_sust_mp_date', 'on', formattedDate], 'AND',
                        ['custrecord_sust_mp_superseded_by', 'anyof', '@NONE@']
                    ],
                    columns: ['internalid', 'custrecord_sust_mp_source']
                }).run().each(function(result) {
                    if (result.getText('custrecord_sust_mp_source') === sourceText) {
                        existingRecordId = result.id;
                        return false;
                    }
                    return true;
                });

                let priceRecord;
                let supersededId = null;
                if (existingRecordId) {
                    const existing = record.load({ type: 'customrecord_sust_market_price', id: existingRecordId });
                    const existingLb = parseFloat(existing.getValue({ fieldId: 'custrecord_sust_mp_price_per_lb' })) || 0;
                    if (Math.abs(existingLb - pricePerLb) < 0.0000001) {
                        // Same value — refresh metadata in place (idempotent re-run).
                        priceRecord = existing;
                        log.debug('storeIndexPrice', 'Unchanged ' + sourceText + ' for ' + formattedDate + ' (record ' + existingRecordId + ')');
                    } else {
                        // CORRECTION: version-control the change. Keep the original,
                        // create a correction record, chain them — original vs
                        // corrected stays visible; lookups use only the correction.
                        supersededId = existingRecordId;
                        priceRecord = record.create({ type: 'customrecord_sust_market_price' });
                        priceRecord.setValue({ fieldId: 'custrecord_sust_mp_date', value: effectiveDate });
                        priceRecord.setText({ fieldId: 'custrecord_sust_mp_source', text: sourceText });
                        try {
                            priceRecord.setValue({ fieldId: 'custrecord_sust_mp_corrected', value: true });
                            priceRecord.setValue({
                                fieldId: 'custrecord_sust_mp_correction_note',
                                value: 'Corrects record ' + existingRecordId + ': $' + existingLb.toFixed(4)
                                    + '/lb -> $' + pricePerLb.toFixed(4) + '/lb (' + new Date().toISOString().substring(0, 10) + ')'
                            });
                        } catch (eCorr) { log.debug('correction fields skipped', eCorr.message); }
                        log.audit('storeIndexPrice — CORRECTION',
                            sourceText + ' ' + formattedDate + ': $' + existingLb.toFixed(4) + ' -> $' + pricePerLb.toFixed(4) + '/lb');
                    }
                } else {
                    priceRecord = record.create({ type: 'customrecord_sust_market_price' });
                    priceRecord.setValue({ fieldId: 'custrecord_sust_mp_date', value: effectiveDate });
                    priceRecord.setText({ fieldId: 'custrecord_sust_mp_source', text: sourceText });
                    log.debug('storeIndexPrice', 'Creating ' + sourceText + ' for ' + formattedDate);
                }

                priceRecord.setValue({ fieldId: 'custrecord_sust_mp_price_per_lb', value: pricePerLb });
                priceRecord.setValue({ fieldId: 'custrecord_sust_mp_raw_rate', value: pricePerTon });
                priceRecord.setValue({ fieldId: 'custrecord_sust_mp_raw_unit', value: '$/ton' });
                priceRecord.setValue({ fieldId: 'custrecord_sust_mp_fetched_at', value: new Date().toISOString() });

                const savedId = priceRecord.save();
                if (supersededId) {
                    try {
                        record.submitFields({
                            type: 'customrecord_sust_market_price', id: supersededId,
                            values: { custrecord_sust_mp_superseded_by: savedId }
                        });
                    } catch (eSup) { log.error('supersede stamp failed', eSup.message); }
                }
                return savedId;
            } catch (e) {
                log.error('storeIndexPrice', (params && params.sourceText) + ': ' + e.toString());
                return null;
            }
        }

        /**
         * Get the most recent stored price for a given index source.
         *
         * @param {string} marketSourceText - e.g. 'RISI SOP'
         * @returns {Object|null} { pricePerLb, date } or null
         */
        function getLatestPrice(marketSourceText) {
            try {
                if (!marketSourceText || marketSourceText === MANUAL_SOURCE_TEXT) {
                    return null;
                }

                const priceSearch = search.create({
                    type: 'customrecord_sust_market_price',
                    filters: [['custrecord_sust_mp_superseded_by', 'anyof', '@NONE@']],
                    columns: [
                        'custrecord_sust_mp_price_per_lb',
                        search.createColumn({
                            name: 'custrecord_sust_mp_date',
                            sort: search.Sort.DESC
                        }),
                        'custrecord_sust_mp_source'
                    ]
                });

                let found = null;
                priceSearch.run().each(function(result) {
                    const sourceText = result.getText('custrecord_sust_mp_source');
                    if (sourceText === marketSourceText) {
                        found = {
                            pricePerLb: parseFloat(result.getValue('custrecord_sust_mp_price_per_lb') || 0),
                            date: result.getValue('custrecord_sust_mp_date')
                        };
                        return false; // stop — first match is most recent due to sort
                    }
                    return true;
                });

                if (found) {
                    log.debug('Latest Price Found', marketSourceText + ': $' + found.pricePerLb.toFixed(4) + '/lb (' + found.date + ')');
                } else {
                    log.debug('No Price Found', 'No stored price for: ' + marketSourceText);
                }

                return found;

            } catch (e) {
                log.error('Error getting latest price', marketSourceText + ': ' + e.toString());
                return null;
            }
        }

        /**
         * Effective-dated lookup: the most recent index value ON OR BEFORE the
         * given date (how a monthly published index with lag behaves).
         * Falls back to getLatestPrice() when no dated value exists yet.
         *
         * @param {string} marketSourceText - e.g. 'RISI SOP'
         * @param {string|Date} dateStr - effective date (M/D/YYYY or Date)
         * @returns {Object|null} { pricePerLb, date } or null
         */
        function getPriceForDate(marketSourceText, dateStr) {
            try {
                if (!marketSourceText || marketSourceText === MANUAL_SOURCE_TEXT) {
                    return null;
                }
                if (!dateStr) {
                    return getLatestPrice(marketSourceText);
                }

                const effectiveDate = (dateStr instanceof Date)
                    ? dateStr
                    : new Date(dateStr);
                const formattedDate = format.format({ value: effectiveDate, type: format.Type.DATE });

                const priceSearch = search.create({
                    type: 'customrecord_sust_market_price',
                    filters: [
                        ['custrecord_sust_mp_date', 'onorbefore', formattedDate], 'AND',
                        ['custrecord_sust_mp_superseded_by', 'anyof', '@NONE@']
                    ],
                    columns: [
                        'custrecord_sust_mp_price_per_lb',
                        search.createColumn({
                            name: 'custrecord_sust_mp_date',
                            sort: search.Sort.DESC
                        }),
                        'custrecord_sust_mp_source'
                    ]
                });

                let found = null;
                priceSearch.run().each(function(result) {
                    const sourceText = result.getText('custrecord_sust_mp_source');
                    if (sourceText === marketSourceText) {
                        found = {
                            pricePerLb: parseFloat(result.getValue('custrecord_sust_mp_price_per_lb') || 0),
                            date: result.getValue('custrecord_sust_mp_date')
                        };
                        return false; // first match = latest on/before date
                    }
                    return true;
                });

                if (found) {
                    log.debug('Effective-Dated Price', marketSourceText + ' as of ' + formattedDate +
                        ': $' + found.pricePerLb.toFixed(4) + '/lb (published ' + found.date + ')');
                    return found;
                }

                // No value on/before the date — fall back to latest available
                log.debug('No Effective Price', 'No ' + marketSourceText + ' value on/before ' + formattedDate + ', falling back to latest');
                return getLatestPrice(marketSourceText);

            } catch (e) {
                log.error('Error getting price for date', marketSourceText + ' ' + dateStr + ': ' + e.toString());
                return getLatestPrice(marketSourceText);
            }
        }

        return {
            INDEX_MAP: INDEX_MAP,
            MANUAL_SOURCE_TEXT: MANUAL_SOURCE_TEXT,
            listIndexSources: listIndexSources,
            storeIndexPrice: storeIndexPrice,
            getLatestPrice: getLatestPrice,
            getPriceForDate: getPriceForDate
        };

    });
