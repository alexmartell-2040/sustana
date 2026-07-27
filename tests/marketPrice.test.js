/**
 * Unit tests for SUST_Lib_MarketPrice.js
 *
 * Published-index pricing (RISI recovered-fiber indices):
 * - INDEX_MAP configuration (4 RISI sources, matched by display TEXT)
 * - listIndexSources()
 * - storeIndexPrice(): $/ton in, $/lb stored; upsert by date + source text
 * - getLatestPrice(): most recent stored value, matched by source TEXT
 * - getPriceForDate(): effective-dated ('onorbefore') lookup with fallback
 */

const record = require('./mocks/N/record');
const search = require('./mocks/N/search');
const log = require('./mocks/N/log');
const format = require('./mocks/N/format');

// ---------------------------------------------------------------
// Load the REAL units lib first (no deps), then the market price
// lib with the real units lib injected.
// ---------------------------------------------------------------
let units;
let marketPriceLib;
const originalDefine = global.define;

global.define = function(deps, factory) {
    units = factory();
};
require('../src/FileCabinet/SuiteScripts/Sustana/SUST_Lib_Units');

global.define = function(deps, factory) {
    const depMap = {
        'N/record': record,
        'N/search': search,
        'N/log': log,
        'N/format': format,
        './SUST_Lib_Units': units
    };
    const resolvedDeps = deps.map(d => {
        if (!(d in depMap)) throw new Error('Unmapped AMD dependency in test: ' + d);
        return depMap[d];
    });
    marketPriceLib = factory(...resolvedDeps);
};
require('../src/FileCabinet/SuiteScripts/Sustana/SUST_Lib_MarketPrice');
global.define = originalDefine;

// Helper: a stored market-price search row ({} values keyed like the mock expects)
function priceRow(id, sourceText, pricePerLb, date) {
    return {
        id: id,
        values: {
            custrecord_sust_mp_price_per_lb: String(pricePerLb),
            custrecord_sust_mp_date: date,
            custrecord_sust_mp_source_text: sourceText
        }
    };
}

describe('SUST_Lib_MarketPrice', () => {

    beforeEach(() => {
        record._reset();
        search._reset();
        log._reset();
        jest.clearAllMocks();
    });

    // ============================================================
    // INDEX_MAP configuration
    // ============================================================

    describe('INDEX_MAP', () => {
        test('contains exactly the 4 RISI index sources', () => {
            expect(Object.keys(marketPriceLib.INDEX_MAP).sort()).toEqual(
                ['RISI_MIXED_PAPER', 'RISI_MOP', 'RISI_SOP', 'RISI_WHITE_LEDGER']
            );
        });

        test('source display texts match the customlist values', () => {
            expect(marketPriceLib.INDEX_MAP.RISI_SOP.sourceText).toBe('RISI SOP');
            expect(marketPriceLib.INDEX_MAP.RISI_WHITE_LEDGER.sourceText).toBe('RISI White Ledger');
            expect(marketPriceLib.INDEX_MAP.RISI_MIXED_PAPER.sourceText).toBe('RISI Mixed Paper');
            expect(marketPriceLib.INDEX_MAP.RISI_MOP.sourceText).toBe('RISI Mixed Office Paper');
        });

        test("MANUAL_SOURCE_TEXT is 'Custom/Manual Entry'", () => {
            expect(marketPriceLib.MANUAL_SOURCE_TEXT).toBe('Custom/Manual Entry');
        });

        test('the old metals API surface is gone', () => {
            expect(marketPriceLib.METAL_MAP).toBeUndefined();
            expect(marketPriceLib.API_CURRENCIES).toBeUndefined();
            expect(marketPriceLib.convertToPerLb).toBeUndefined();
            expect(marketPriceLib.fetchLatestPrices).toBeUndefined();
            expect(marketPriceLib.getApiConfig).toBeUndefined();
            expect(marketPriceLib.storePrices).toBeUndefined();
            expect(marketPriceLib.updateLastRun).toBeUndefined();
        });
    });

    describe('listIndexSources', () => {
        test('returns all 4 index display texts', () => {
            expect(marketPriceLib.listIndexSources().sort()).toEqual([
                'RISI Mixed Office Paper',
                'RISI Mixed Paper',
                'RISI SOP',
                'RISI White Ledger'
            ]);
        });

        test('does not include the manual source', () => {
            expect(marketPriceLib.listIndexSources()).not.toContain('Custom/Manual Entry');
        });
    });

    // ============================================================
    // storeIndexPrice()
    // ============================================================

    describe('storeIndexPrice', () => {

        test('creates a new record when no date+source match exists, converting $/ton to $/lb', () => {
            search._setSearchResults('customrecord_sust_market_price', []); // no existing rows

            const savedId = marketPriceLib.storeIndexPrice({
                sourceText: 'RISI SOP',
                date: '6/1/2026',
                pricePerTon: 200
            });

            // Created (not loaded)
            expect(record.create).toHaveBeenCalledWith({ type: 'customrecord_sust_market_price' });
            expect(record.load).not.toHaveBeenCalled();

            const created = record.create.mock.results[0].value;
            // $200/ton / 2000 lbs = $0.10/lb
            expect(created._values.custrecord_sust_mp_price_per_lb).toBe(0.10);
            // Raw published value + unit are preserved for audit
            expect(created._values.custrecord_sust_mp_raw_rate).toBe(200);
            expect(created._values.custrecord_sust_mp_raw_unit).toBe('$/ton');
            // Source stored by TEXT, date normalized to midnight
            expect(created._values.custrecord_sust_mp_source_text).toBe('RISI SOP');
            expect(created._values.custrecord_sust_mp_date).toBeInstanceOf(Date);
            expect(created._values.custrecord_sust_mp_date.getHours()).toBe(0);

            expect(created.save).toHaveBeenCalled();
            expect(savedId).toBe(1); // first id from the record mock
        });

        test('dedupe search filters on the date field and matches source by TEXT', () => {
            search._setSearchResults('customrecord_sust_market_price', []);

            marketPriceLib.storeIndexPrice({ sourceText: 'RISI SOP', date: '6/1/2026', pricePerTon: 200 });

            const searchOpts = search.create.mock.calls[0][0];
            expect(searchOpts.type).toBe('customrecord_sust_market_price');
            expect(searchOpts.filters[0][0]).toBe('custrecord_sust_mp_date');
            expect(searchOpts.filters[0][1]).toBe('on');
            expect(searchOpts.columns).toContain('custrecord_sust_mp_source');
        });

        test('same date + source with the SAME price updates in place (idempotent re-run)', () => {
            search._setSearchResults('customrecord_sust_market_price', [
                priceRow('55', 'RISI SOP', 0.105, '6/1/2026')
            ]);
            record._setMockRecord('customrecord_sust_market_price', '55', {
                custrecord_sust_mp_price_per_lb: 0.105
            });

            const savedId = marketPriceLib.storeIndexPrice({
                sourceText: 'RISI SOP',
                date: '6/1/2026',
                pricePerTon: 210 // 210/2000 = 0.105 — unchanged
            });

            expect(record.load).toHaveBeenCalledWith({
                type: 'customrecord_sust_market_price',
                id: '55'
            });
            expect(record.create).not.toHaveBeenCalled();
            expect(savedId).toBe('55'); // updated in place, same id
        });

        test('same date + source with a DIFFERENT price creates a versioned CORRECTION', () => {
            search._setSearchResults('customrecord_sust_market_price', [
                priceRow('55', 'RISI SOP', 0.09, '6/1/2026')
            ]);
            record._setMockRecord('customrecord_sust_market_price', '55', {
                custrecord_sust_mp_price_per_lb: 0.09
            });

            const savedId = marketPriceLib.storeIndexPrice({
                sourceText: 'RISI SOP',
                date: '6/1/2026',
                pricePerTon: 210 // 0.105 ≠ 0.09 — a correction
            });

            // Original kept; a NEW correction record is created and chained
            expect(record.create).toHaveBeenCalledWith({ type: 'customrecord_sust_market_price' });
            expect(savedId).not.toBe('55');
            const corrected = record._getMockRecord('customrecord_sust_market_price', savedId).values;
            expect(corrected.custrecord_sust_mp_price_per_lb).toBe(0.105);
            expect(corrected.custrecord_sust_mp_corrected).toBe(true);
            expect(corrected.custrecord_sust_mp_correction_note).toContain('0.0900');
            expect(corrected.custrecord_sust_mp_correction_note).toContain('0.1050');
            // Original stamped as superseded by the correction
            const original = record._getMockRecord('customrecord_sust_market_price', '55').values;
            expect(original.custrecord_sust_mp_superseded_by).toBe(savedId);
        });

        test('creates a new record when the same date has a DIFFERENT source', () => {
            search._setSearchResults('customrecord_sust_market_price', [
                priceRow('55', 'RISI White Ledger', 0.08, '6/1/2026')
            ]);

            marketPriceLib.storeIndexPrice({ sourceText: 'RISI SOP', date: '6/1/2026', pricePerTon: 200 });

            expect(record.load).not.toHaveBeenCalled();
            expect(record.create).toHaveBeenCalledWith({ type: 'customrecord_sust_market_price' });
        });

        test('returns null and stores nothing when sourceText is missing', () => {
            const result = marketPriceLib.storeIndexPrice({ date: '6/1/2026', pricePerTon: 200 });

            expect(result).toBeNull();
            expect(record.create).not.toHaveBeenCalled();
            expect(record.load).not.toHaveBeenCalled();
        });
    });

    // ============================================================
    // getLatestPrice()
    // ============================================================

    describe('getLatestPrice', () => {
        test('returns the first result whose source TEXT matches', () => {
            // Search is sorted date desc; a non-matching source comes first
            search._setSearchResults('customrecord_sust_market_price', [
                priceRow('1', 'RISI White Ledger', 0.0725, '6/15/2026'),
                priceRow('2', 'RISI SOP', 0.11, '6/1/2026')
            ]);

            const result = marketPriceLib.getLatestPrice('RISI SOP');

            expect(result).toEqual({ pricePerLb: 0.11, date: '6/1/2026' });
        });

        test('first match wins when multiple rows exist for the source (date desc = most recent)', () => {
            search._setSearchResults('customrecord_sust_market_price', [
                priceRow('1', 'RISI SOP', 0.12, '6/15/2026'),
                priceRow('2', 'RISI SOP', 0.10, '5/15/2026')
            ]);

            const result = marketPriceLib.getLatestPrice('RISI SOP');

            expect(result.pricePerLb).toBe(0.12);
            expect(result.date).toBe('6/15/2026');
        });

        test('sorts by date descending', () => {
            search._setSearchResults('customrecord_sust_market_price', []);
            marketPriceLib.getLatestPrice('RISI SOP');

            const cols = search.create.mock.calls[0][0].columns;
            const dateCol = cols.find(c => c && c.name === 'custrecord_sust_mp_date');
            expect(dateCol).toBeDefined();
            expect(dateCol.sort).toBe(search.Sort.DESC);
        });

        test("returns null for 'Custom/Manual Entry' without searching", () => {
            const result = marketPriceLib.getLatestPrice('Custom/Manual Entry');

            expect(result).toBeNull();
            expect(search.create).not.toHaveBeenCalled();
        });

        test('returns null for empty/null source', () => {
            expect(marketPriceLib.getLatestPrice('')).toBeNull();
            expect(marketPriceLib.getLatestPrice(null)).toBeNull();
        });

        test('returns null when no stored row matches the source text', () => {
            search._setSearchResults('customrecord_sust_market_price', [
                priceRow('1', 'RISI Mixed Paper', 0.0475, '6/1/2026')
            ]);

            expect(marketPriceLib.getLatestPrice('RISI SOP')).toBeNull();
        });
    });

    // ============================================================
    // getPriceForDate()
    // ============================================================

    describe('getPriceForDate', () => {
        test("filters with 'onorbefore' on the price date (effective-dated lookup)", () => {
            search._setSearchResults('customrecord_sust_market_price', [
                priceRow('1', 'RISI SOP', 0.10, '6/1/2026')
            ]);

            marketPriceLib.getPriceForDate('RISI SOP', '6/10/2026');

            const searchOpts = search.create.mock.calls[0][0];
            expect(searchOpts.type).toBe('customrecord_sust_market_price');
            expect(searchOpts.filters).toEqual([
                ['custrecord_sust_mp_date', 'onorbefore', expect.any(String)], 'AND',
                ['custrecord_sust_mp_superseded_by', 'anyof', '@NONE@']
            ]);
        });

        test('returns the first source-text match = latest value on/before the date', () => {
            // Rows the date-filtered search would return, date desc:
            // a newer non-matching source, then the 6/1 SOP value, then an older SOP value.
            search._setSearchResults('customrecord_sust_market_price', [
                priceRow('1', 'RISI White Ledger', 0.0725, '6/8/2026'),
                priceRow('2', 'RISI SOP', 0.10, '6/1/2026'),
                priceRow('3', 'RISI SOP', 0.08, '5/1/2026')
            ]);

            const result = marketPriceLib.getPriceForDate('RISI SOP', '6/10/2026');

            expect(result).toEqual({ pricePerLb: 0.10, date: '6/1/2026' });
        });

        test('falls back to getLatestPrice when no dated match exists', () => {
            const latestRow = priceRow('9', 'RISI SOP', 0.115, '7/1/2026');

            // Function resolver: the effective-dated ('onorbefore') search finds
            // nothing; the unfiltered getLatestPrice search finds the row.
            search._setSearchResults('customrecord_sust_market_price', (options) => {
                const hasDateFilter = (options.filters || []).some(
                    f => Array.isArray(f) && f[1] === 'onorbefore'
                );
                return hasDateFilter ? [] : [latestRow];
            });

            const result = marketPriceLib.getPriceForDate('RISI SOP', '6/10/2026');

            // Two searches ran: the dated one, then the fallback
            expect(search.create).toHaveBeenCalledTimes(2);
            expect(search.create.mock.calls[0][0].filters[0][1]).toBe('onorbefore');
            // fallback (latest) search filters only exclude superseded corrections
            expect(search.create.mock.calls[1][0].filters).toEqual(
                [['custrecord_sust_mp_superseded_by', 'anyof', '@NONE@']]);
            expect(result).toEqual({ pricePerLb: 0.115, date: '7/1/2026' });
        });

        test('delegates to getLatestPrice when no date is given', () => {
            search._setSearchResults('customrecord_sust_market_price', [
                priceRow('1', 'RISI SOP', 0.10, '6/1/2026')
            ]);

            const result = marketPriceLib.getPriceForDate('RISI SOP', '');

            expect(result).toEqual({ pricePerLb: 0.10, date: '6/1/2026' });
            // Only the latest-price search ran (superseded corrections excluded)
            expect(search.create).toHaveBeenCalledTimes(1);
            expect(search.create.mock.calls[0][0].filters).toEqual(
                [['custrecord_sust_mp_superseded_by', 'anyof', '@NONE@']]);
        });

        test('returns null for the manual source', () => {
            expect(marketPriceLib.getPriceForDate('Custom/Manual Entry', '6/10/2026')).toBeNull();
            expect(search.create).not.toHaveBeenCalled();
        });

        test('returns null when neither dated nor latest value exists', () => {
            search._setSearchResults('customrecord_sust_market_price', []);
            expect(marketPriceLib.getPriceForDate('RISI SOP', '6/10/2026')).toBeNull();
        });
    });
});
