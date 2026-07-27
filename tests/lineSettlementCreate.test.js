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

    test('a text market reference ("Custom") is skipped entirely, never reaching save (no INVALID_NUMBER)', () => {
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
        // Neither setValue nor setText is called for a non-numeric market ref — the field
        // is left blank so the bad token can never reach save() and throw INVALID_NUMBER.
        expect(v.custrecord_sust_settlement_market_source).toBeUndefined();
        expect(v.custrecord_sust_settlement_market_source_text).toBeUndefined();
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

    // Settlement Mode is set explicitly so the record never falls back to an account
    // field default that resolves to the unusable "Custom" text (the live INVALID_NUMBER bug).
    test('mode is preset to Auto when a schedule is present', () => {
        const scheduleInfo = {
            scheduleId: 5, methodId: 7, methodText: '% of Index',
            marketRefId: 42, marketRefText: 'RISI White Ledger',
            marketPct: 100, marketAdj: 0, treatmentCharge: 0, pricePerLb: 0
        };
        const id = lib.createLineSettlement(baseParams({ scheduleInfo: scheduleInfo }));
        expect(savedValues(id).custrecord_sust_settlement_mode_text).toBe('Auto');
    });

    test('mode is preset to Calculator when there is no schedule', () => {
        const id = lib.createLineSettlement(baseParams({ scheduleInfo: null }));
        expect(savedValues(id).custrecord_sust_settlement_mode_text).toBe('Calculator');
    });
});

// ---------------------------------------------------------------
// Settlement cadence — vendor-driven weekly/monthly aggregation
// ---------------------------------------------------------------

describe('settlement cadence - period keys', () => {
    test('Monthly key is YYYY-MM', () => {
        expect(lib.periodKeyFor('Monthly', new Date('2026-07-22T12:00:00Z'))).toBe('2026-07');
    });

    test('Weekly key is the ISO week', () => {
        // Wed 2026-07-22 falls in ISO week 30 of 2026
        expect(lib.periodKeyFor('Weekly', new Date('2026-07-22T12:00:00Z'))).toBe('2026-W30');
    });

    test('Weekly key handles the year boundary (ISO week belongs to next year)', () => {
        // Mon 2024-12-30 is ISO 2025-W01
        expect(lib.periodKeyFor('Weekly', new Date('2024-12-30T12:00:00Z'))).toBe('2025-W01');
    });
});

describe('settlement cadence - createOrAppendLineSettlement', () => {
    test('vendor without a cadence gets a per-receipt settlement (default path)', () => {
        const result = lib.createOrAppendLineSettlement(baseParams());
        expect(result.action).toBe('created');
        expect(result.periodKey).toBeNull();
        expect(savedValues(result.id).custrecord_sust_settlement_gross_lbs).toBe(40000);
    });

    test('Weekly vendor with no open period settlement creates one and stamps the period', () => {
        search._setLookupResult('vendor', 50, {
            custentity_sust_settlement_cadence: [{ value: '2', text: 'Weekly' }]
        });
        const result = lib.createOrAppendLineSettlement(baseParams());
        expect(result.action).toBe('created');
        expect(result.periodKey).toBe('2026-W27'); // Wed 2026-07-01 is ISO week 27
        const vals = savedValues(result.id);
        expect(vals.custrecord_sust_settle_period_key).toBe('2026-W27');
        expect(JSON.parse(vals.custrecord_sust_settle_agg_sources)).toEqual(['ir:300:1']);
    });

    test('Weekly vendor with an open Draft period settlement appends weights and tracks the source', () => {
        search._setLookupResult('vendor', 50, {
            custentity_sust_settlement_cadence: [{ value: '2', text: 'Weekly' }]
        });
        // Existing open settlement for the period, already holding line ir:300:1
        record._setMockRecord('customrecord_sust_settlement_record', 900, {
            custrecord_sust_settlement_gross_lbs: 10000,
            custrecord_sust_settlement_net_lbs: 9500,
            custrecord_sust_settlement_net_value: 500,
            custrecord_sust_settle_period_key: '2026-W27',
            custrecord_sust_settle_agg_sources: JSON.stringify(['ir:300:1']),
            custrecord_sust_settlement_notes: 'Auto-generated from Item Receipt #300 line 1'
        });
        search._setSearchResults('customrecord_sust_settlement_record', [{
            id: 900,
            values: {
                custrecord_sust_settlement_status_text: 'Draft',
                custrecord_sust_settle_agg_sources: JSON.stringify(['ir:300:1'])
            }
        }]);

        const result = lib.createOrAppendLineSettlement(baseParams({ sourceLine: 2, grossWeight: 20000, sourceTag: 'Item Receipt #300 line 2' }));
        expect(result.action).toBe('appended');
        expect(result.id).toBe(900);
        const vals = savedValues(900);
        expect(vals.custrecord_sust_settlement_gross_lbs).toBe(30000);      // 10000 + 20000
        expect(vals.custrecord_sust_settlement_net_lbs).toBe(9500 + 19000); // 95% recovery
        expect(JSON.parse(vals.custrecord_sust_settle_agg_sources)).toEqual(['ir:300:1', 'ir:300:2']);
        expect(vals.custrecord_sust_settlement_notes).toContain('line 2');
    });

    test('re-saved receipt line already in the period settlement is skipped, not double-counted', () => {
        search._setLookupResult('vendor', 50, {
            custentity_sust_settlement_cadence: [{ value: '3', text: 'Monthly' }]
        });
        record._setMockRecord('customrecord_sust_settlement_record', 901, {
            custrecord_sust_settlement_gross_lbs: 40000,
            custrecord_sust_settle_agg_sources: JSON.stringify(['ir:300:1'])
        });
        search._setSearchResults('customrecord_sust_settlement_record', [{
            id: 901,
            values: {
                custrecord_sust_settlement_status_text: 'Draft',
                custrecord_sust_settle_agg_sources: JSON.stringify(['ir:300:1'])
            }
        }]);

        const result = lib.createOrAppendLineSettlement(baseParams());
        expect(result.action).toBe('skipped');
        expect(savedValues(901).custrecord_sust_settlement_gross_lbs).toBe(40000); // unchanged
    });

    test('a non-Draft settlement in the period does not absorb new lines (a fresh one opens)', () => {
        search._setLookupResult('vendor', 50, {
            custentity_sust_settlement_cadence: [{ value: '2', text: 'Weekly' }]
        });
        search._setSearchResults('customrecord_sust_settlement_record', [{
            id: 902,
            values: {
                custrecord_sust_settlement_status_text: 'Final Settled',
                custrecord_sust_settle_agg_sources: JSON.stringify(['ir:299:1'])
            }
        }]);

        const result = lib.createOrAppendLineSettlement(baseParams());
        expect(result.action).toBe('created');
        expect(result.id).not.toBe(902);
    });
});

describe('settlement cadence - receipt slice child records', () => {
    const sliceCreates = () =>
        record.create.mock.calls.filter(c => c[0] && c[0].type === 'customrecord_sust_settle_slice').length;

    test('opening a weekly period settlement writes one Settlement Receipt Slice', () => {
        search._setLookupResult('vendor', 50, {
            custentity_sust_settlement_cadence: [{ value: '2', text: 'Weekly' }]
        });
        const before = sliceCreates();
        lib.createOrAppendLineSettlement(baseParams());
        expect(sliceCreates() - before).toBe(1);
    });

    test('appending to an open period settlement writes another slice', () => {
        search._setLookupResult('vendor', 50, {
            custentity_sust_settlement_cadence: [{ value: '2', text: 'Weekly' }]
        });
        record._setMockRecord('customrecord_sust_settlement_record', 910, {
            custrecord_sust_settlement_gross_lbs: 20000,
            custrecord_sust_settle_agg_sources: JSON.stringify(['ir:300:1'])
        });
        search._setSearchResults('customrecord_sust_settlement_record', [{
            id: 910,
            values: {
                custrecord_sust_settlement_status_text: 'Draft',
                custrecord_sust_settle_agg_sources: JSON.stringify(['ir:300:1'])
            }
        }]);
        const before = sliceCreates();
        lib.createOrAppendLineSettlement(baseParams({ sourceLine: 2, sourceTag: 'Item Receipt #300 line 2' }));
        expect(sliceCreates() - before).toBe(1);
    });

    test('per-receipt settlements do not write slices', () => {
        const before = sliceCreates();
        lib.createOrAppendLineSettlement(baseParams());
        expect(sliceCreates() - before).toBe(0);
    });
});
