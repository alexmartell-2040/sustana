/**
 * Unit tests for SUST_Lib_SettlementCreate.createLineSettlement (Sustana Recovery).
 *
 * Focus: the SELECT-field writes must never pass a text token (e.g. a market
 * reference of "Custom") to setValue, which throws INVALID_NUMBER on save and
 * aborts the whole settlement (observed live from the Manage Line Settlements
 * Suitelet). A numeric internal id must still use setValue; a text value must
 * fall back to setText; an unresolvable value must be skipped, not fatal.
 */

const record = require('./mocks/N/record');
const search = require('./mocks/N/search');
const log = require('./mocks/N/log');

// Real units are not needed here; market price is mocked.
const marketPriceLibMock = {
    getLatestPrice: jest.fn(() => null),
    getPriceForDate: jest.fn(() => null)
};

let lib;
const originalDefine = global.define;
global.define = function(deps, factory) {
    const depMap = {
        'N/record': record,
        'N/search': search,
        'N/log': log,
        './SUST_Lib_MarketPrice': marketPriceLibMock
    };
    const resolved = deps.map(d => {
        if (!(d in depMap)) throw new Error('Unmapped AMD dependency in lib test: ' + d);
        return depMap[d];
    });
    lib = factory(...resolved);
};
require('../src/FileCabinet/SuiteScripts/Sustana/SUST_Lib_SettlementCreate');
global.define = originalDefine;

const SETTLE_TYPE = 'customrecord_sust_settlement_record';

function baseParams(overrides) {
    return Object.assign({
        vendorId: 50,
        tranDate: new Date('2026-07-01'),
        poId: 200,
        itemReceiptId: 300,
        sourceLine: 1,
        itemId: 10,
        grossWeight: 40000,
        recoveryPct: 95,
        lotInternalId: 111,
        lotDetails: [{ lotNumber: 'TRK-002' }],
        sourceTag: 'Item Receipt #300 line 1 (on-demand)'
    }, overrides || {});
}

/** Read the values the script wrote onto the saved settlement record. */
function savedValues(id) {
    return record._getMockRecord(SETTLE_TYPE, id).values;
}

beforeEach(() => {
    record._reset();
    search._reset();
    marketPriceLibMock.getLatestPrice.mockReturnValue(null);
});

describe('createLineSettlement - defensive SELECT writes (INVALID_NUMBER fix)', () => {

    test('a text market reference ("Custom") goes through setText, never setValue (no INVALID_NUMBER)', () => {
        const scheduleInfo = {
            scheduleId: 5,
            methodId: 7,
            methodText: '% of Index',
            marketRefId: 'Custom',       // <-- text where an id is expected (the live bug)
            marketRefText: 'Custom',
            marketPct: 100,
            marketAdj: 0,
            treatmentCharge: 0,
            pricePerLb: 0
        };

        let id;
        expect(() => {
            id = lib.createLineSettlement(baseParams({ scheduleInfo: scheduleInfo }));
        }).not.toThrow();

        const v = savedValues(id);
        // setValue path (numeric field) must NOT have received the text token
        expect(v.custrecord_sust_settlement_market_source).toBeUndefined();
        // setText path carried the display text instead
        expect(v.custrecord_sust_settlement_market_source_text).toBe('Custom');
    });

    test('a numeric market reference id still uses setValue', () => {
        const scheduleInfo = {
            scheduleId: 5, methodId: 7, methodText: '% of Index',
            marketRefId: 42, marketRefText: 'RISI White Ledger',
            marketPct: 100, marketAdj: 0, treatmentCharge: 0, pricePerLb: 0
        };
        const id = lib.createLineSettlement(baseParams({ scheduleInfo: scheduleInfo }));
        const v = savedValues(id);
        expect(v.custrecord_sust_settlement_market_source).toBe(42);
        expect(v.custrecord_sust_settlement_market_source_text).toBeUndefined();
    });

    test('numeric method id uses setValue; the schedule link is only set when numeric', () => {
        const scheduleInfo = {
            scheduleId: 5, methodId: 7, methodText: '% of Index',
            marketRefId: 42, marketRefText: 'RISI White Ledger',
            marketPct: 100, marketAdj: 0, treatmentCharge: 0, pricePerLb: 0
        };
        const id = lib.createLineSettlement(baseParams({ scheduleInfo: scheduleInfo }));
        const v = savedValues(id);
        expect(v.custrecord_sust_settlement_method).toBe(7);
        expect(v.custrecord_sust_settlement_schedule).toBe(5);
    });

    test('a non-numeric schedule id is skipped rather than crashing the save', () => {
        const scheduleInfo = {
            scheduleId: 'abc', methodId: null, methodText: 'Received Pricing',
            marketRefId: null, marketRefText: null,
            marketPct: 100, marketAdj: 0, treatmentCharge: 0, pricePerLb: 0.15
        };
        let id;
        expect(() => { id = lib.createLineSettlement(baseParams({ scheduleInfo: scheduleInfo })); }).not.toThrow();
        const v = savedValues(id);
        expect(v.custrecord_sust_settlement_schedule).toBeUndefined();
        // method fell back to text
        expect(v.custrecord_sust_settlement_method_text).toBe('Received Pricing');
    });

    test('no schedule at all falls back to Received Pricing and still saves', () => {
        let id;
        expect(() => {
            id = lib.createLineSettlement(baseParams({ scheduleInfo: null }));
        }).not.toThrow();
        const v = savedValues(id);
        expect(v.custrecord_sust_settlement_method_text).toBe('Received Pricing');
        // weights still written
        expect(v.custrecord_sust_settlement_gross_lbs).toBe(40000);
        expect(v.custrecord_sust_settlement_net_lbs).toBeCloseTo(38000, 5); // 40000 * 95%
    });
});
