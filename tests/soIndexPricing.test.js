/**
 * Unit tests for SUST_UE_SO_IndexPricing.js
 *
 * Sell-side index pricing (the customer half of the 1:30 moment): prices
 * Sales Order lines from an active Sale-direction settlement schedule
 * matched by customer + item —
 *   ratePerLb = getPriceForDate(indexText, trandate).pricePerLb x pct/100 + adj
 * The line description carries the formula; a beforeLoad banner lists which
 * lines were index-priced.
 */

const search = require('./mocks/N/search');
const runtime = require('./mocks/N/runtime');
const log = require('./mocks/N/log');
const serverWidget = require('./mocks/N/ui/serverWidget');
const record = require('./mocks/N/record');

// Real units lib (no deps) so $/ton memo formatting is exact, not guessed.
let unitsLib;
const originalDefine = global.define;
global.define = function(deps, factory) {
    unitsLib = factory();
};
require('../src/FileCabinet/SuiteScripts/Sustana/SUST_Lib_Units');

// SUST_Lib_MarketPrice is mocked directly — its own behavior (effective
// dating, $/ton<->$/lb, source-text matching) is covered by marketPrice.test.js.
const marketPriceLibMock = {
    MANUAL_SOURCE_TEXT: 'Custom/Manual Entry',
    getPriceForDate: jest.fn()
};

let soPricing;
global.define = function(deps, factory) {
    const depMap = {
        'N/search': search,
        'N/runtime': runtime,
        'N/log': log,
        'N/ui/serverWidget': serverWidget,
        './SUST_Lib_MarketPrice': marketPriceLibMock,
        './SUST_Lib_Units': unitsLib
    };
    const resolvedDeps = deps.map(d => {
        if (!(d in depMap)) throw new Error('Unmapped AMD dependency in SO_IndexPricing test: ' + d);
        return depMap[d];
    });
    soPricing = factory(...resolvedDeps);
};
require('../src/FileCabinet/SuiteScripts/Sustana/SUST_UE_SO_IndexPricing');
global.define = originalDefine;

const UserEventType = { CREATE: 'create', EDIT: 'edit', DELETE: 'delete', VIEW: 'view' };
const SCHEDULE_TYPE = 'customrecord_sust_settlement_schedule';

/** A settlement-schedule search row shaped for search.getText()/getValue(). */
function scheduleRow(id, {
    direction = 'Sale',
    method = '% of Index',
    basePrice = 0,
    marketRef = 'RISI SOP',
    marketPct = 100,
    marketAdj = 0
} = {}) {
    return {
        id,
        values: {
            custrecord_sust_sched_direction_text: direction,
            custrecord_sust_schedule_method_text: method,
            custrecord_sust_schedule_base_price: basePrice,
            custrecord_sust_schedule_market_ref_text: marketRef,
            custrecord_sust_schedule_market_pct: marketPct,
            custrecord_sust_schedule_market_adj: marketAdj
        }
    };
}

function soContext(type, { entity = '100', trandate = '6/10/2026', lines = [] } = {}) {
    const rec = record._createMockRecord('salesorder', { entity, trandate }, { item: lines });
    return { type, newRecord: rec, UserEventType };
}

describe('SUST_UE_SO_IndexPricing', () => {

    beforeEach(() => {
        search._reset();
        log._reset();
        jest.clearAllMocks();
        marketPriceLibMock.getPriceForDate.mockReset();
    });

    // ============================================================
    // beforeSubmit - guard clauses
    // ============================================================

    describe('beforeSubmit - no-op cases', () => {
        test('does nothing on DELETE', () => {
            const ctx = soContext(UserEventType.DELETE, { lines: [{ item: '55', quantity: 1 }] });
            soPricing.beforeSubmit(ctx);
            expect(search.create).not.toHaveBeenCalled();
        });

        test('does nothing without a customer', () => {
            const ctx = soContext(UserEventType.CREATE, { entity: '', lines: [{ item: '55', quantity: 1 }] });
            soPricing.beforeSubmit(ctx);
            expect(search.create).not.toHaveBeenCalled();
        });

        test('skips lines with no item', () => {
            const ctx = soContext(UserEventType.CREATE, { lines: [{ quantity: 1 }] });
            soPricing.beforeSubmit(ctx);
            expect(search.create).not.toHaveBeenCalled();
        });
    });

    // ============================================================
    // Schedule matching
    // ============================================================

    describe('schedule matching', () => {
        test('skips a line when no schedule matches the customer + item', () => {
            search._setSearchResults(SCHEDULE_TYPE, []);
            const ctx = soContext(UserEventType.CREATE, { lines: [{ item: '55', quantity: 20000 }] });
            soPricing.beforeSubmit(ctx);
            expect(ctx.newRecord._sublistData.item[0].rate).toBeUndefined();
        });

        test('skips a Purchase-direction schedule even if the search returns it', () => {
            search._setSearchResults(SCHEDULE_TYPE, [scheduleRow('1', { direction: 'Purchase' })]);
            marketPriceLibMock.getPriceForDate.mockReturnValue({ pricePerLb: 0.10, date: '6/1/2026' });

            const ctx = soContext(UserEventType.CREATE, { lines: [{ item: '55', quantity: 20000 }] });
            soPricing.beforeSubmit(ctx);
            expect(ctx.newRecord._sublistData.item[0].rate).toBeUndefined();
        });

        test('filters the schedule search on customer, item, and active status', () => {
            search._setSearchResults(SCHEDULE_TYPE, []);
            const ctx = soContext(UserEventType.CREATE, { entity: '77', lines: [{ item: '55', quantity: 20000 }] });
            soPricing.beforeSubmit(ctx);

            const opts = search.create.mock.calls[0][0];
            expect(opts.type).toBe(SCHEDULE_TYPE);
            expect(opts.filters).toEqual([
                ['custrecord_sust_sched_customer', 'anyof', '77'],
                'AND', ['custrecord_sust_schedule_item', 'anyof', '55'],
                'AND', ['custrecord_sust_schedule_active', 'is', 'T'],
                'AND', ['isinactive', 'is', 'F']
            ]);
        });
    });

    // ============================================================
    // Pricing formula
    // ============================================================

    describe('pricing formula', () => {
        test('Fixed Price schedule sets the rate to the base price', () => {
            search._setSearchResults(SCHEDULE_TYPE, [scheduleRow('1', { method: 'Fixed Price', basePrice: 0.30 })]);

            const ctx = soContext(UserEventType.CREATE, { lines: [{ item: '55', quantity: 10000 }] });
            soPricing.beforeSubmit(ctx);

            const line = ctx.newRecord._sublistData.item[0];
            expect(line.rate).toBe(0.30);
            expect(line.price).toBe(-1); // custom price level
            expect(line.amount).toBe(3000); // 0.30 x 10000
            expect(line.description).toContain('Fixed Price');
            expect(marketPriceLibMock.getPriceForDate).not.toHaveBeenCalled();
        });

        test('% of Index: rate = price x pct/100 + adj, memo carries the formula', () => {
            marketPriceLibMock.getPriceForDate.mockReturnValue({ pricePerLb: 0.10, date: '6/1/2026' }); // $200/ton
            search._setSearchResults(SCHEDULE_TYPE, [
                scheduleRow('1', { marketRef: 'RISI SOP', marketPct: 100, marketAdj: 0.005 }) // +$10/ton
            ]);

            const ctx = soContext(UserEventType.CREATE, {
                trandate: '6/10/2026', lines: [{ item: '55', quantity: 20000 }]
            });
            soPricing.beforeSubmit(ctx);

            expect(marketPriceLibMock.getPriceForDate).toHaveBeenCalledWith('RISI SOP', '6/10/2026');
            const line = ctx.newRecord._sublistData.item[0];
            expect(line.rate).toBe(0.105); // 0.10 + 0.005
            expect(line.amount).toBe(2100); // 0.105 x 20000
            expect(line.description).toBe('RISI SOP $200.00/ton + $10.00/ton = $210.00/ton');
        });

        test('memo includes the percentage factor when pct != 100 and a negative adjustment', () => {
            marketPriceLibMock.getPriceForDate.mockReturnValue({ pricePerLb: 0.30, date: '6/1/2026' }); // $600/ton
            search._setSearchResults(SCHEDULE_TYPE, [
                scheduleRow('1', { marketRef: 'RISI White Ledger', marketPct: 90, marketAdj: -0.0075 }) // -$15/ton
            ]);

            const ctx = soContext(UserEventType.CREATE, { lines: [{ item: '60', quantity: 5000 }] });
            soPricing.beforeSubmit(ctx);

            const line = ctx.newRecord._sublistData.item[0];
            // 0.30 x 0.90 - 0.0075 = 0.2625
            expect(line.rate).toBeCloseTo(0.2625, 6);
            expect(line.description).toBe('RISI White Ledger $600.00/ton x 90% − $15.00/ton = $525.00/ton');
        });

        test('leaves the line untouched when the schedule matches but no index value exists for the date', () => {
            marketPriceLibMock.getPriceForDate.mockReturnValue(null);
            search._setSearchResults(SCHEDULE_TYPE, [scheduleRow('1', {})]);

            const ctx = soContext(UserEventType.CREATE, { lines: [{ item: '55', quantity: 1000 }] });
            soPricing.beforeSubmit(ctx);
            expect(ctx.newRecord._sublistData.item[0].rate).toBeUndefined();
        });

        test('leaves the line untouched for a manual-source schedule (no index lookup)', () => {
            search._setSearchResults(SCHEDULE_TYPE, [scheduleRow('1', { marketRef: 'Custom/Manual Entry' })]);

            const ctx = soContext(UserEventType.CREATE, { lines: [{ item: '55', quantity: 1000 }] });
            soPricing.beforeSubmit(ctx);

            expect(ctx.newRecord._sublistData.item[0].rate).toBeUndefined();
            expect(marketPriceLibMock.getPriceForDate).not.toHaveBeenCalled();
        });

        test('prices only the matching line when multiple lines are present', () => {
            marketPriceLibMock.getPriceForDate.mockReturnValue({ pricePerLb: 0.10, date: '6/1/2026' });
            search._setSearchResults(SCHEDULE_TYPE, (opts) => {
                const itemFilter = opts.filters.find(f => Array.isArray(f) && f[0] === 'custrecord_sust_schedule_item');
                return itemFilter && itemFilter[2] === '55' ? [scheduleRow('1', {})] : [];
            });

            const ctx = soContext(UserEventType.CREATE, {
                lines: [{ item: '55', quantity: 1000 }, { item: '99', quantity: 500 }]
            });
            soPricing.beforeSubmit(ctx);

            expect(ctx.newRecord._sublistData.item[0].rate).toBeDefined();
            expect(ctx.newRecord._sublistData.item[1].rate).toBeUndefined();
        });
    });

    // ============================================================
    // beforeLoad - index-pricing banner
    // ============================================================

    describe('beforeLoad', () => {
        function loadContext(type, lines) {
            const rec = record._createMockRecord('salesorder', {}, { item: lines });
            const addedFields = [];
            const form = {
                addField: jest.fn(() => {
                    const f = { defaultValue: null };
                    addedFields.push(f);
                    return f;
                })
            };
            return { ctx: { type, newRecord: rec, form, UserEventType }, addedFields };
        }

        test('adds a banner listing only the index-priced lines', () => {
            const { ctx, addedFields } = loadContext(UserEventType.VIEW, [
                { description: 'RISI SOP $200.00/ton + $10.00/ton = $210.00/ton' },
                { description: 'Plain line, not index priced' }
            ]);
            soPricing.beforeLoad(ctx);

            expect(addedFields).toHaveLength(1);
            expect(addedFields[0].defaultValue).toContain('Line 1');
            expect(addedFields[0].defaultValue).not.toContain('Line 2');
        });

        test('adds no banner when no line looks index-priced', () => {
            const { ctx, addedFields } = loadContext(UserEventType.EDIT, [{ description: 'Plain line' }]);
            soPricing.beforeLoad(ctx);
            expect(addedFields).toHaveLength(0);
        });

        test('does nothing on CREATE', () => {
            const { ctx, addedFields } = loadContext(UserEventType.CREATE, [
                { description: 'RISI SOP $200.00/ton = $200.00/ton' }
            ]);
            soPricing.beforeLoad(ctx);
            expect(addedFields).toHaveLength(0);
        });
    });
});
