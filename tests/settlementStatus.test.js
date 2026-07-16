/**
 * Unit tests for Settlement Status Automation (Sustana Recovery)
 *
 * Tests:
 * - SUST_UE_Settlement_StatusChange.js (User Event: vendor bill creation on
 *   status transitions; bill line resolution via script param / config record)
 * - SUST_SL_SettlementCalculation.js (Suitelet: QUALITY deduction calculation
 *   from lot quality data + schedule deduction definitions)
 *
 * Status values are matched by display TEXT (customlist_sust_settlement_status):
 * Draft / Completed / Provisional Paid / Final Settled / Voided.
 */

const record = require('./mocks/N/record');
const search = require('./mocks/N/search');
const runtime = require('./mocks/N/runtime');
const log = require('./mocks/N/log');
const format = require('./mocks/N/format');
const redirectMock = require('./mocks/N/redirect');
const urlMock = require('./mocks/N/url');
const serverWidget = require('./mocks/N/ui/serverWidget');

// =============================================
// Load the REAL units lib (no deps) — passed into the Suitelet depMap
// =============================================
let unitsLib;
const originalDefine = global.define;
global.define = function(deps, factory) {
    unitsLib = factory();
};
require('../src/FileCabinet/SuiteScripts/Sustana/SUST_Lib_Units');

// =============================================
// Chained-lib mocks
// =============================================

// SUST_Lib_Config mock — bill line resolution reads
// get('settlementFeeItem') / get('settlementExpenseAccount')
const configLibMock = {
    get: jest.fn(() => ''),
    getConfig: jest.fn(() => ({})),
    reset: jest.fn()
};

// SUST_Lib_SettlementCreate mock — quality values for the settlement's lot
const DEFAULT_LOT_QUALITY = { moisturePct: 0, contaminationPct: 0, fiberContentPct: 0, baleCount: 0 };
const settlementLibMock = {
    getLotQuality: jest.fn(() => ({ ...DEFAULT_LOT_QUALITY }))
};

const marketPriceLibMock = {
    MANUAL_SOURCE_TEXT: 'Custom/Manual Entry',
    listIndexSources: jest.fn(() => []),
    getLatestPrice: jest.fn(() => null),
    getPriceForDate: jest.fn(() => null)
};

// =============================================
// Load UE Script (SUST_UE_Settlement_StatusChange.js) via AMD shim
// =============================================
let ueModule;

global.define = function(deps, factory) {
    const depMap = {
        'N/record': record,
        'N/search': search,
        'N/runtime': runtime,
        'N/log': log,
        './SUST_Lib_Config': configLibMock
    };
    const resolvedDeps = deps.map(d => {
        if (!(d in depMap)) throw new Error('Unmapped AMD dependency in UE test: ' + d);
        return depMap[d];
    });
    ueModule = factory(...resolvedDeps);
};
require('../src/FileCabinet/SuiteScripts/Sustana/SUST_UE_Settlement_StatusChange');

// =============================================
// Load Suitelet (SUST_SL_SettlementCalculation.js) via AMD shim
// =============================================
let slModule;

global.define = function(deps, factory) {
    const depMap = {
        'N/ui/serverWidget': serverWidget,
        'N/record': record,
        'N/search': search,
        'N/redirect': redirectMock,
        'N/log': log,
        'N/format': format,
        'N/url': urlMock,
        './SUST_Lib_MarketPrice': marketPriceLibMock,
        './SUST_Lib_SettlementCreate': settlementLibMock,
        './SUST_Lib_Units': unitsLib
    };
    const resolvedDeps = deps.map(d => {
        if (!(d in depMap)) throw new Error('Unmapped AMD dependency in SL test: ' + d);
        return depMap[d];
    });
    slModule = factory(...resolvedDeps);
};
require('../src/FileCabinet/SuiteScripts/Sustana/SUST_SL_SettlementCalculation');

global.define = originalDefine;

// =============================================
// Shared helpers
// =============================================

/** Set the custscript_sust_settle_fee_item script parameter for the UE. */
function setScriptParam(value) {
    runtime.getCurrentScript.mockImplementation(() => ({
        id: 'customscript_test',
        deploymentId: 'customdeploy_test',
        getParameter: jest.fn((options) =>
            (options && options.name === 'custscript_sust_settle_fee_item') ? value : null)
    }));
}

/** UE afterSubmit context — statuses passed as display TEXT (getText). */
function createUEContext(type, newStatusText, oldStatusText, settlementId) {
    return {
        type: type,
        UserEventType: { CREATE: 'create', EDIT: 'edit', DELETE: 'delete' },
        newRecord: {
            id: settlementId || '100',
            getValue: jest.fn(() => null),
            getText: jest.fn(opts =>
                opts.fieldId === 'custrecord_sust_settlement_status' ? newStatusText : null)
        },
        oldRecord: oldStatusText !== null ? {
            getValue: jest.fn(() => null),
            getText: jest.fn(opts =>
                opts.fieldId === 'custrecord_sust_settlement_status' ? oldStatusText : null)
        } : null
    };
}

/** Find the vendor bill record instance created by the UE (if any). */
function getCreatedBill() {
    const idx = record.create.mock.calls.findIndex(c => c[0].type === 'vendorbill');
    return idx === -1 ? null : record.create.mock.results[idx].value;
}

/** Suitelet calculate-endpoint context. */
function createCalculateContext(settlementId) {
    let responseBody = '';
    return {
        request: {
            method: 'GET',
            parameters: {
                action: 'calculate',
                settlementid: settlementId
            }
        },
        response: {
            setHeader: jest.fn(),
            write: jest.fn(data => { responseBody = data; }),
            writePage: jest.fn()
        },
        getResponseBody: () => responseBody
    };
}

/**
 * Set up a settlement + schedule + lot + quality-deduction definitions.
 * Deduction definitions live on customrecord_sust_settlement_penalty with the
 * quality metric matched by TEXT ('Moisture %' / 'Contamination %').
 */
function setupQualityTest(options) {
    const { lotQuality, penaltyDefs, netLbs, marketPrice, treatment, provisional } = options;
    const settlementId = '200';
    const scheduleId = '10';
    const lotId = '50';

    record._setMockRecord('customrecord_sust_settlement_record', settlementId, {
        custrecord_sust_settlement_net_lbs: String(netLbs !== undefined ? netLbs : 2000),
        custrecord_sust_settlement_market_price: String(marketPrice !== undefined ? marketPrice : 0.05),
        custrecord_sust_settlement_treatment: String(treatment || 0),
        custrecord_sust_settlement_provisional: String(provisional || 0),
        custrecord_sust_settlement_schedule: scheduleId,
        custrecord_sust_settlement_lot: lotId
    });

    search._setLookupResult('customrecord_sust_settlement_schedule', scheduleId, {
        custrecord_sust_schedule_market_pct: '100',
        custrecord_sust_schedule_market_adj: '0'
    });

    // The Suitelet resolves the lot NUMBER from the inventorynumber record,
    // then asks the settlement lib for that lot's measured quality.
    search._setLookupResult('inventorynumber', lotId, { inventorynumber: 'TRK-101' });
    settlementLibMock.getLotQuality.mockReturnValue({ ...DEFAULT_LOT_QUALITY, ...lotQuality });

    search._setSearchResults('customrecord_sust_settlement_penalty',
        penaltyDefs.map((def, i) => ({
            id: String(i + 1),
            values: {
                custrecord_sust_penalty_element: def.elementId,
                custrecord_sust_penalty_element_text: def.elementText,
                custrecord_sust_penalty_threshold: String(def.threshold),
                custrecord_sust_penalty_rate: String(def.rate),
                custrecord_sust_penalty_calculation_text: def.calcType
            }
        }))
    );

    search._setSearchResults('customrecord_sust_penalty_detail', []);

    return settlementId;
}

/** Created penalty-detail record instances (args + record) from the record mock. */
function getCreatedPenaltyDetails() {
    return record.create.mock.calls
        .map((call, i) => ({ args: call[0], rec: record.create.mock.results[i].value }))
        .filter(x => x.args.type === 'customrecord_sust_penalty_detail');
}


// =============================================================================
// UE SCRIPT TESTS — SUST_UE_Settlement_StatusChange.js
// =============================================================================

describe('SUST_UE_Settlement_StatusChange', () => {

    beforeEach(() => {
        record._reset();
        search._reset();
        runtime._reset();
        log._reset();
        jest.clearAllMocks();
        // Defaults: no script parameter, empty config record
        setScriptParam(null);
        configLibMock.get.mockImplementation(() => '');
    });

    /** Config with a Settlement Fee item (preferred bill-line path). */
    function configureFeeItem(itemId) {
        configLibMock.get.mockImplementation(key => key === 'settlementFeeItem' ? itemId : '');
    }

    /** Config with only an expense account (fallback bill-line path). */
    function configureExpenseAccount(accountId) {
        configLibMock.get.mockImplementation(key => key === 'settlementExpenseAccount' ? accountId : '');
    }

    // -------------------------------------------------
    // Status change detection
    // -------------------------------------------------

    describe('afterSubmit - status change detection', () => {

        test('does nothing when event type is DELETE', () => {
            const ctx = createUEContext('delete', 'Provisional Paid', 'Draft', '100');
            ueModule.afterSubmit(ctx);
            expect(record.load).not.toHaveBeenCalled();
        });

        test('does nothing when status has not changed', () => {
            const ctx = createUEContext('edit', 'Draft', 'Draft', '100');
            ueModule.afterSubmit(ctx);
            expect(record.load).not.toHaveBeenCalled();
        });

        test('CREATE as Draft does not trigger bill creation', () => {
            const ctx = createUEContext('create', 'Draft', null, '100');
            ueModule.afterSubmit(ctx);
            expect(record.create).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------
    // Provisional bill creation (status text: 'Provisional Paid')
    // -------------------------------------------------

    describe('afterSubmit - provisional bill creation', () => {

        test('creates provisional vendor bill when status changes to Provisional Paid', () => {
            configureFeeItem('77');
            const ctx = createUEContext('edit', 'Provisional Paid', 'Completed', '100');

            record._setMockRecord('customrecord_sust_settlement_record', '100', {
                custrecord_sust_settlement_vendor: '50',
                custrecord_sust_settlement_date: '2/15/2026',
                custrecord_sust_settlement_provisional: '5000',
                custrecord_sust_settlement_prov_bill: '',
                custrecord_sust_settlement_net_value: '10000'
            });

            ueModule.afterSubmit(ctx);

            // Should load the settlement
            expect(record.load).toHaveBeenCalledWith(expect.objectContaining({
                type: 'customrecord_sust_settlement_record',
                id: '100'
            }));

            // Should create a vendor bill for the vendor with a -PROV suffixed ref
            const bill = getCreatedBill();
            expect(bill).not.toBeNull();
            expect(bill._values.entity).toBe(50);
            expect(bill._values.tranid).toBe('SETTLE-100-PROV');
            expect(bill.save).toHaveBeenCalled();

            // Should link the bill to the settlement
            expect(record.submitFields).toHaveBeenCalledWith(expect.objectContaining({
                type: 'customrecord_sust_settlement_record',
                id: '100',
                values: expect.objectContaining({
                    custrecord_sust_settlement_prov_bill: expect.any(Number)
                })
            }));
        });

        test('skips bill when provisional bill already exists', () => {
            configureFeeItem('77');
            const ctx = createUEContext('edit', 'Provisional Paid', 'Completed', '100');

            record._setMockRecord('customrecord_sust_settlement_record', '100', {
                custrecord_sust_settlement_vendor: '50',
                custrecord_sust_settlement_provisional: '5000',
                custrecord_sust_settlement_prov_bill: '999' // Already has a bill
            });

            ueModule.afterSubmit(ctx);

            expect(record.create).not.toHaveBeenCalled();
        });

        test('skips bill when provisional amount is zero', () => {
            configureFeeItem('77');
            const ctx = createUEContext('edit', 'Provisional Paid', 'Completed', '100');

            record._setMockRecord('customrecord_sust_settlement_record', '100', {
                custrecord_sust_settlement_vendor: '50',
                custrecord_sust_settlement_provisional: '0',
                custrecord_sust_settlement_prov_bill: ''
            });

            ueModule.afterSubmit(ctx);

            expect(record.create).not.toHaveBeenCalled();
        });

        test('skips bill when no vendor is set', () => {
            configureFeeItem('77');
            const ctx = createUEContext('edit', 'Provisional Paid', 'Completed', '100');

            record._setMockRecord('customrecord_sust_settlement_record', '100', {
                custrecord_sust_settlement_vendor: '',
                custrecord_sust_settlement_provisional: '5000',
                custrecord_sust_settlement_prov_bill: ''
            });

            ueModule.afterSubmit(ctx);

            expect(record.create).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------
    // Bill line resolution: script param -> config fee item -> config
    // expense account -> throw (writeBillLine)
    // -------------------------------------------------

    describe('writeBillLine resolution (via provisional bill)', () => {

        function seedProvisionalSettlement() {
            record._setMockRecord('customrecord_sust_settlement_record', '100', {
                custrecord_sust_settlement_vendor: '50',
                custrecord_sust_settlement_date: '2/15/2026',
                custrecord_sust_settlement_provisional: '5000',
                custrecord_sust_settlement_prov_bill: ''
            });
            return createUEContext('edit', 'Provisional Paid', 'Completed', '100');
        }

        test('uses the config Settlement Fee ITEM line when configured', () => {
            configureFeeItem('77');
            const ctx = seedProvisionalSettlement();

            ueModule.afterSubmit(ctx);

            const bill = getCreatedBill();
            expect(bill._sublistData.item[0]).toEqual(expect.objectContaining({
                item: 77,          // parseInt of config value
                quantity: 1,
                rate: 5000,
                amount: 5000,
                description: expect.stringContaining('Provisional')
            }));
            // No expense line written
            expect(bill._sublistData.expense).toBeUndefined();
            expect(bill.save).toHaveBeenCalled();
        });

        test('script parameter custscript_sust_settle_fee_item overrides the config item', () => {
            setScriptParam('55');
            configureFeeItem('77');
            const ctx = seedProvisionalSettlement();

            ueModule.afterSubmit(ctx);

            const bill = getCreatedBill();
            expect(bill._sublistData.item[0].item).toBe(55);
        });

        test('falls back to the config EXPENSE account line when no fee item', () => {
            configureExpenseAccount('888');
            const ctx = seedProvisionalSettlement();

            ueModule.afterSubmit(ctx);

            const bill = getCreatedBill();
            expect(bill._sublistData.expense[0]).toEqual(expect.objectContaining({
                account: 888,
                amount: 5000,
                memo: expect.stringContaining('Provisional')
            }));
            // No item line written
            expect(bill._sublistData.item).toBeUndefined();
            expect(bill.save).toHaveBeenCalled();
        });

        test('throws (bill never saved) when neither fee item nor expense account configured', () => {
            // Default beforeEach config: everything '' — writeBillLine must throw.
            const ctx = seedProvisionalSettlement();

            // afterSubmit itself must not throw (non-blocking)...
            expect(() => ueModule.afterSubmit(ctx)).not.toThrow();

            // ...but the bill is never saved and the settlement is never linked
            const bill = getCreatedBill();
            expect(bill.save).not.toHaveBeenCalled();
            expect(record.submitFields).not.toHaveBeenCalled();
            expect(log.error).toHaveBeenCalledWith(
                'Error Creating Provisional Bill',
                expect.objectContaining({
                    error: expect.stringContaining('No settlement fee item or expense account configured')
                })
            );
        });
    });

    // -------------------------------------------------
    // Final bill creation (status text: 'Final Settled')
    // -------------------------------------------------

    describe('afterSubmit - final bill creation', () => {

        test('creates final vendor bill for balance due on Final Settled', () => {
            configureFeeItem('77');
            const ctx = createUEContext('edit', 'Final Settled', 'Provisional Paid', '100');

            record._setMockRecord('customrecord_sust_settlement_record', '100', {
                custrecord_sust_settlement_vendor: '50',
                custrecord_sust_settlement_date: '2/15/2026',
                custrecord_sust_settlement_net_value: '10000',
                custrecord_sust_settlement_provisional: '5000',
                custrecord_sust_settlement_bill: ''
            });

            ueModule.afterSubmit(ctx);

            // Should create a vendor bill for the 5000 balance due
            expect(record.create).toHaveBeenCalledWith(expect.objectContaining({
                type: 'vendorbill'
            }));

            // Should link bill and store balance due
            expect(record.submitFields).toHaveBeenCalledWith(expect.objectContaining({
                type: 'customrecord_sust_settlement_record',
                id: '100',
                values: expect.objectContaining({
                    custrecord_sust_settlement_bill: expect.any(Number),
                    custrecord_sust_settlement_balance_due: 5000 // 10000 - 5000
                })
            }));
        });

        test('creates bill even for negative balance / overpayment', () => {
            configureFeeItem('77');
            const ctx = createUEContext('edit', 'Final Settled', 'Provisional Paid', '100');

            record._setMockRecord('customrecord_sust_settlement_record', '100', {
                custrecord_sust_settlement_vendor: '50',
                custrecord_sust_settlement_net_value: '4000',
                custrecord_sust_settlement_provisional: '5000', // Overpaid by $1000
                custrecord_sust_settlement_bill: ''
            });

            ueModule.afterSubmit(ctx);

            // Should still create a bill (abs amount, negative balance logged)
            expect(record.create).toHaveBeenCalledWith(expect.objectContaining({
                type: 'vendorbill'
            }));
        });

        test('Final Settled transition loads the settlement and never throws', () => {
            configureFeeItem('77');
            const ctx = createUEContext('edit', 'Final Settled', 'Provisional Paid', '100');

            record._setMockRecord('customrecord_sust_settlement_record', '100', {
                custrecord_sust_settlement_vendor: '50',
                custrecord_sust_settlement_net_value: '10000',
                custrecord_sust_settlement_provisional: '5000',
                custrecord_sust_settlement_bill: ''
            });

            expect(() => ueModule.afterSubmit(ctx)).not.toThrow();
            expect(record.load).toHaveBeenCalledWith(expect.objectContaining({
                type: 'customrecord_sust_settlement_record',
                id: '100'
            }));
        });

        test('skips bill when balance due is zero', () => {
            configureFeeItem('77');
            const ctx = createUEContext('edit', 'Final Settled', 'Provisional Paid', '100');

            record._setMockRecord('customrecord_sust_settlement_record', '100', {
                custrecord_sust_settlement_vendor: '50',
                custrecord_sust_settlement_net_value: '5000',
                custrecord_sust_settlement_provisional: '5000', // Matches net value exactly
                custrecord_sust_settlement_bill: ''
            });

            ueModule.afterSubmit(ctx);

            expect(record.create).not.toHaveBeenCalled();
        });

        test('skips bill when final bill already exists', () => {
            configureFeeItem('77');
            const ctx = createUEContext('edit', 'Final Settled', 'Provisional Paid', '100');

            record._setMockRecord('customrecord_sust_settlement_record', '100', {
                custrecord_sust_settlement_vendor: '50',
                custrecord_sust_settlement_net_value: '10000',
                custrecord_sust_settlement_provisional: '5000',
                custrecord_sust_settlement_bill: '888' // Already has a bill
            });

            ueModule.afterSubmit(ctx);

            expect(record.create).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------
    // Approval fields
    // -------------------------------------------------

    describe('afterSubmit - approval fields', () => {

        test('sets approval fields on Draft -> Completed transition', () => {
            const ctx = createUEContext('edit', 'Completed', 'Draft', '100');

            ueModule.afterSubmit(ctx);

            expect(record.submitFields).toHaveBeenCalledWith(expect.objectContaining({
                type: 'customrecord_sust_settlement_record',
                id: '100',
                values: expect.objectContaining({
                    custrecord_sust_settlement_approved_by: 1, // Default runtime user ID
                    custrecord_sust_settlement_approved_date: expect.any(Date)
                })
            }));
        });

        test('does not set approval fields on non-Draft -> Completed', () => {
            const ctx = createUEContext('edit', 'Completed', 'Provisional Paid', '100');

            ueModule.afterSubmit(ctx);

            expect(record.submitFields).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------
    // Error handling
    // -------------------------------------------------

    describe('error handling', () => {

        test('does not throw when record.load fails during bill creation', () => {
            configureFeeItem('77');
            const ctx = createUEContext('edit', 'Provisional Paid', 'Completed', '100');

            record.load.mockImplementationOnce(() => {
                throw new Error('Record not found');
            });

            expect(() => ueModule.afterSubmit(ctx)).not.toThrow();
        });

        test('does not throw when record.create fails during bill creation', () => {
            configureFeeItem('77');
            const ctx = createUEContext('edit', 'Provisional Paid', 'Completed', '100');

            record._setMockRecord('customrecord_sust_settlement_record', '100', {
                custrecord_sust_settlement_vendor: '50',
                custrecord_sust_settlement_provisional: '5000',
                custrecord_sust_settlement_prov_bill: ''
            });

            record.create.mockImplementationOnce(() => {
                throw new Error('Vendor bill creation failed');
            });

            expect(() => ueModule.afterSubmit(ctx)).not.toThrow();
        });
    });

    // -------------------------------------------------
    // Non-billing status texts
    // -------------------------------------------------

    describe('status texts that do not trigger billing', () => {

        test("'Draft' does not trigger bill creation", () => {
            const ctx = createUEContext('edit', 'Draft', 'Completed', '100');
            ueModule.afterSubmit(ctx);
            expect(record.create).not.toHaveBeenCalled();
        });

        test("'Voided' does not trigger bill creation", () => {
            const ctx = createUEContext('edit', 'Voided', 'Draft', '100');
            ueModule.afterSubmit(ctx);
            expect(record.create).not.toHaveBeenCalled();
        });
    });
});


// =============================================================================
// SUITELET CALCULATION TESTS — SUST_SL_SettlementCalculation.js
// =============================================================================

describe('SUST_SL_SettlementCalculation - Server-Side Calculation', () => {

    beforeEach(() => {
        record._reset();
        search._reset();
        log._reset();
        jest.clearAllMocks();
        settlementLibMock.getLotQuality.mockImplementation(() => ({ ...DEFAULT_LOT_QUALITY }));
        marketPriceLibMock.getLatestPrice.mockImplementation(() => null);
    });

    // -------------------------------------------------
    // Basic calculation
    // -------------------------------------------------

    describe('basic calculation (no deductions)', () => {

        test('calculates gross value = net lbs x market price ($/lb)', () => {
            record._setMockRecord('customrecord_sust_settlement_record', '200', {
                custrecord_sust_settlement_net_lbs: '40000',       // 20 tons
                custrecord_sust_settlement_market_price: '0.10',   // $200/ton
                custrecord_sust_settlement_treatment: '500',
                custrecord_sust_settlement_provisional: '2000',
                custrecord_sust_settlement_schedule: '',
                custrecord_sust_settlement_lot: ''
            });
            search._setSearchResults('customrecord_sust_penalty_detail', []);

            const ctx = createCalculateContext('200');
            slModule.onRequest(ctx);
            const result = JSON.parse(ctx.getResponseBody());

            expect(result.grossValue).toBe(4000);   // 40000 * 0.10
            expect(result.totalPenalties).toBe(0);
            expect(result.netValue).toBe(3500);     // 4000 - 500 - 0
            expect(result.balanceDue).toBe(1500);   // 3500 - 2000
        });

        test('applies schedule market percentage and adjustment', () => {
            const scheduleId = '10';

            record._setMockRecord('customrecord_sust_settlement_record', '200', {
                custrecord_sust_settlement_net_lbs: '2000',
                custrecord_sust_settlement_market_price: '0.10',
                custrecord_sust_settlement_treatment: '0',
                custrecord_sust_settlement_provisional: '0',
                custrecord_sust_settlement_schedule: scheduleId,
                custrecord_sust_settlement_lot: ''
            });

            // Schedule: 90% of index + $0.005/lb adjustment
            search._setLookupResult('customrecord_sust_settlement_schedule', scheduleId, {
                custrecord_sust_schedule_market_pct: '90',
                custrecord_sust_schedule_market_adj: '0.005'
            });
            search._setSearchResults('customrecord_sust_settlement_penalty', []);
            search._setSearchResults('customrecord_sust_penalty_detail', []);

            const ctx = createCalculateContext('200');
            slModule.onRequest(ctx);
            const result = JSON.parse(ctx.getResponseBody());

            // effectivePrice = (0.10 * 90/100) + 0.005 = 0.09 + 0.005 = 0.095
            expect(result.effectivePrice).toBeCloseTo(0.095, 6);
            expect(result.grossValue).toBeCloseTo(190, 6); // 2000 * 0.095
            expect(result.scheduleMarketPct).toBe(90);
            expect(result.scheduleMarketAdj).toBe(0.005);
        });

        test('returns error when no settlement ID provided', () => {
            const ctx = createCalculateContext('');
            slModule.onRequest(ctx);
            const result = JSON.parse(ctx.getResponseBody());

            expect(result.error).toBeDefined();
        });

        test('returns JSON with Content-Type header', () => {
            record._setMockRecord('customrecord_sust_settlement_record', '200', {
                custrecord_sust_settlement_net_lbs: '100',
                custrecord_sust_settlement_market_price: '0.10',
                custrecord_sust_settlement_treatment: '0',
                custrecord_sust_settlement_provisional: '0',
                custrecord_sust_settlement_schedule: '',
                custrecord_sust_settlement_lot: ''
            });
            search._setSearchResults('customrecord_sust_penalty_detail', []);

            const ctx = createCalculateContext('200');
            slModule.onRequest(ctx);

            expect(ctx.response.setHeader).toHaveBeenCalledWith(
                expect.objectContaining({ name: 'Content-Type', value: 'application/json' })
            );

            const result = JSON.parse(ctx.getResponseBody());
            expect(result).toHaveProperty('grossValue');
            expect(result).toHaveProperty('netValue');
            expect(result).toHaveProperty('totalPenalties');
            expect(result).toHaveProperty('balanceDue');
            expect(result).toHaveProperty('penaltyDetails');
        });
    });

    // -------------------------------------------------
    // Quality deduction formulas (moisture / contamination)
    // -------------------------------------------------

    describe('quality deduction formulas', () => {

        test('Per Percentage Point: (actual - threshold) x rate x netLbs', () => {
            const settlementId = setupQualityTest({
                netLbs: 2000,
                marketPrice: 0.05,
                lotQuality: { moisturePct: 12 },       // 12% measured moisture
                penaltyDefs: [{
                    elementId: '1',
                    elementText: 'Moisture %',
                    threshold: 10,                      // 10% allowed
                    rate: 1.00,
                    calcType: 'Per Percentage Point'
                }]
            });

            const ctx = createCalculateContext(settlementId);
            slModule.onRequest(ctx);
            const result = JSON.parse(ctx.getResponseBody());

            // Lot number resolved from the inventorynumber record, then quality fetched
            expect(settlementLibMock.getLotQuality).toHaveBeenCalledWith('TRK-101');

            // Excess = 12 - 10 = 2 pct points
            // Deduction = 2 x 1.00 x 2000 lbs = 4000.00
            expect(result.totalPenalties).toBe(4000);
            expect(result.penaltyDetails).toHaveLength(1);
            expect(result.penaltyDetails[0]).toEqual(expect.objectContaining({
                elementText: 'Moisture %',
                actualPct: 12,
                threshold: 10,
                excessPct: 2,
                rate: 1,
                calcType: 'Per Percentage Point',
                amount: 4000
            }));
        });

        test('Flat Fee: fixed deduction once contamination exceeds threshold', () => {
            const settlementId = setupQualityTest({
                netLbs: 2000,
                marketPrice: 0.05,
                lotQuality: { contaminationPct: 5 },
                penaltyDefs: [{
                    elementId: '2',
                    elementText: 'Contamination %',
                    threshold: 3,
                    rate: 150.00, // $150 flat
                    calcType: 'Flat Fee'
                }]
            });

            const ctx = createCalculateContext(settlementId);
            slModule.onRequest(ctx);
            const result = JSON.parse(ctx.getResponseBody());

            expect(result.totalPenalties).toBe(150);
            expect(result.penaltyDetails).toHaveLength(1);
            expect(result.penaltyDetails[0].elementText).toBe('Contamination %');
            expect(result.penaltyDetails[0].amount).toBe(150);
        });

        test('Percentage Reduction: grossValue x (rate / 100)', () => {
            const settlementId = setupQualityTest({
                netLbs: 2000,
                marketPrice: 0.05,                     // grossValue = 2000 * 0.05 = 100
                lotQuality: { moisturePct: 12 },
                penaltyDefs: [{
                    elementId: '1',
                    elementText: 'Moisture %',
                    threshold: 10,
                    rate: 5.0,                          // 5% of gross value
                    calcType: 'Percentage Reduction'
                }]
            });

            const ctx = createCalculateContext(settlementId);
            slModule.onRequest(ctx);
            const result = JSON.parse(ctx.getResponseBody());

            // grossValue = 100, deduction = 100 * (5/100) = 5
            expect(result.grossValue).toBeCloseTo(100, 6);
            expect(result.totalPenalties).toBe(5);
            expect(result.penaltyDetails[0].amount).toBe(5);
        });

        test('no deduction when measured value is below threshold', () => {
            const settlementId = setupQualityTest({
                lotQuality: { moisturePct: 8 },
                penaltyDefs: [{
                    elementId: '1',
                    elementText: 'Moisture %',
                    threshold: 10,
                    rate: 1.00,
                    calcType: 'Per Percentage Point'
                }]
            });

            const ctx = createCalculateContext(settlementId);
            slModule.onRequest(ctx);
            const result = JSON.parse(ctx.getResponseBody());

            expect(result.totalPenalties).toBe(0);
            expect(result.penaltyDetails).toHaveLength(0);
        });

        test('no deduction when measured value equals threshold exactly', () => {
            const settlementId = setupQualityTest({
                lotQuality: { moisturePct: 10 },
                penaltyDefs: [{
                    elementId: '1',
                    elementText: 'Moisture %',
                    threshold: 10,
                    rate: 1.00,
                    calcType: 'Per Percentage Point'
                }]
            });

            const ctx = createCalculateContext(settlementId);
            slModule.onRequest(ctx);
            const result = JSON.parse(ctx.getResponseBody());

            expect(result.totalPenalties).toBe(0);
            expect(result.penaltyDetails).toHaveLength(0);
        });

        test('no deductions when no schedule or lot on the settlement', () => {
            record._setMockRecord('customrecord_sust_settlement_record', '200', {
                custrecord_sust_settlement_net_lbs: '2000',
                custrecord_sust_settlement_market_price: '0.05',
                custrecord_sust_settlement_treatment: '0',
                custrecord_sust_settlement_provisional: '0',
                custrecord_sust_settlement_schedule: '',
                custrecord_sust_settlement_lot: ''
            });
            search._setSearchResults('customrecord_sust_penalty_detail', []);

            const ctx = createCalculateContext('200');
            slModule.onRequest(ctx);
            const result = JSON.parse(ctx.getResponseBody());

            expect(result.totalPenalties).toBe(0);
            expect(result.penaltyDetails).toHaveLength(0);
            expect(settlementLibMock.getLotQuality).not.toHaveBeenCalled();
        });

        test('multiple quality deductions accumulate', () => {
            const settlementId = setupQualityTest({
                netLbs: 2000,
                marketPrice: 0.05,
                lotQuality: { moisturePct: 12, contaminationPct: 5 },
                penaltyDefs: [
                    {
                        elementId: '1',
                        elementText: 'Moisture %',
                        threshold: 10,
                        rate: 0.01,                    // $0.01/lb per pct point
                        calcType: 'Per Percentage Point'
                    },
                    {
                        elementId: '2',
                        elementText: 'Contamination %',
                        threshold: 3,
                        rate: 150.00,
                        calcType: 'Flat Fee'
                    }
                ]
            });

            const ctx = createCalculateContext(settlementId);
            slModule.onRequest(ctx);
            const result = JSON.parse(ctx.getResponseBody());

            // Moisture: (12 - 10) x 0.01 x 2000 = 40
            // Contamination: flat 150
            expect(result.totalPenalties).toBe(190);
            expect(result.penaltyDetails).toHaveLength(2);
        });

        test("skips definitions for unmapped metrics (e.g. 'Other')", () => {
            const settlementId = setupQualityTest({
                lotQuality: { moisturePct: 12 },
                penaltyDefs: [{
                    elementId: '5',
                    elementText: 'Other', // no measured lot value for this metric
                    threshold: 1,
                    rate: 50.00,
                    calcType: 'Flat Fee'
                }]
            });

            const ctx = createCalculateContext(settlementId);
            slModule.onRequest(ctx);
            const result = JSON.parse(ctx.getResponseBody());

            expect(result.totalPenalties).toBe(0);
            expect(result.penaltyDetails).toHaveLength(0);
        });

        test('skips quality deductions when the lot has no resolvable lot number', () => {
            const settlementId = setupQualityTest({
                lotQuality: { moisturePct: 12 },
                penaltyDefs: [{
                    elementId: '1',
                    elementText: 'Moisture %',
                    threshold: 10,
                    rate: 1.00,
                    calcType: 'Per Percentage Point'
                }]
            });
            // Blow away the lot-number lookup: inventorynumber resolves to nothing
            search._setLookupResult('inventorynumber', '50', {});

            const ctx = createCalculateContext(settlementId);
            slModule.onRequest(ctx);
            const result = JSON.parse(ctx.getResponseBody());

            expect(result.totalPenalties).toBe(0);
            expect(settlementLibMock.getLotQuality).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------
    // Penalty detail record management (delete-then-recreate)
    // -------------------------------------------------

    describe('penalty detail record management', () => {

        test('creates a customrecord_sust_penalty_detail row mirroring the deduction', () => {
            const settlementId = setupQualityTest({
                netLbs: 2000,
                lotQuality: { moisturePct: 12 },
                penaltyDefs: [{
                    elementId: '1',
                    elementText: 'Moisture %',
                    threshold: 10,
                    rate: 1.00,
                    calcType: 'Per Percentage Point'
                }]
            });

            const ctx = createCalculateContext(settlementId);
            slModule.onRequest(ctx);

            const details = getCreatedPenaltyDetails();
            expect(details).toHaveLength(1);
            expect(details[0].rec._values).toEqual(expect.objectContaining({
                custrecord_sust_penalty_settlement: '200',
                custrecord_sust_penalty_detail_element: '1',
                custrecord_sust_penalty_detail_actual: 12,
                custrecord_sust_penalty_detail_threshold: 10,
                custrecord_sust_penalty_detail_excess: 2,
                custrecord_sust_penalty_detail_rate: 1,
                custrecord_sust_penalty_detail_amount: 4000
            }));
            expect(details[0].rec.save).toHaveBeenCalled();
        });

        test('deletes existing penalty details before creating new ones', () => {
            const settlementId = setupQualityTest({
                lotQuality: { moisturePct: 12 },
                penaltyDefs: [{
                    elementId: '1',
                    elementText: 'Moisture %',
                    threshold: 10,
                    rate: 1.00,
                    calcType: 'Per Percentage Point'
                }]
            });

            // Existing penalty detail that should be deleted
            search._setSearchResults('customrecord_sust_penalty_detail', [
                { id: '99', values: {} }
            ]);

            const ctx = createCalculateContext(settlementId);
            slModule.onRequest(ctx);

            expect(record.delete).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'customrecord_sust_penalty_detail',
                    id: '99'
                })
            );
            // ...and the fresh detail row was still created
            expect(getCreatedPenaltyDetails()).toHaveLength(1);
        });
    });

    // -------------------------------------------------
    // Full settlement calculation (integration-style)
    // -------------------------------------------------

    describe('full settlement calculation', () => {

        test('netValue = grossValue - treatment - deductions; balanceDue = netValue - provisional', () => {
            const scheduleId = '10';
            const lotId = '50';

            record._setMockRecord('customrecord_sust_settlement_record', '200', {
                custrecord_sust_settlement_net_lbs: '2000',
                custrecord_sust_settlement_market_price: '0.06',
                custrecord_sust_settlement_treatment: '10',
                custrecord_sust_settlement_provisional: '50',
                custrecord_sust_settlement_schedule: scheduleId,
                custrecord_sust_settlement_lot: lotId
            });

            // Schedule: 95% of index + $0.0025/lb
            search._setLookupResult('customrecord_sust_settlement_schedule', scheduleId, {
                custrecord_sust_schedule_market_pct: '95',
                custrecord_sust_schedule_market_adj: '0.0025'
            });

            // Lot quality: moisture above threshold
            search._setLookupResult('inventorynumber', lotId, { inventorynumber: 'TRK-202' });
            settlementLibMock.getLotQuality.mockReturnValue({
                ...DEFAULT_LOT_QUALITY, moisturePct: 12
            });

            search._setSearchResults('customrecord_sust_settlement_penalty', [{
                id: '1',
                values: {
                    custrecord_sust_penalty_element: '1',
                    custrecord_sust_penalty_element_text: 'Moisture %',
                    custrecord_sust_penalty_threshold: '10',
                    custrecord_sust_penalty_rate: '0.005',
                    custrecord_sust_penalty_calculation_text: 'Per Percentage Point'
                }
            }]);
            search._setSearchResults('customrecord_sust_penalty_detail', []);

            const ctx = createCalculateContext('200');
            slModule.onRequest(ctx);
            const result = JSON.parse(ctx.getResponseBody());

            // effectivePrice = (0.06 * 95/100) + 0.0025 = 0.057 + 0.0025 = 0.0595
            expect(result.effectivePrice).toBeCloseTo(0.0595, 6);

            // grossValue = 2000 * 0.0595 = 119
            expect(result.grossValue).toBeCloseTo(119, 4);

            // Moisture deduction: (12 - 10) x 0.005 x 2000 = 20
            expect(result.totalPenalties).toBeCloseTo(20, 4);

            // netValue = 119 - 10 - 20 = 89
            expect(result.netValue).toBeCloseTo(89, 4);

            // balanceDue = 89 - 50 = 39
            expect(result.balanceDue).toBeCloseTo(39, 4);
        });

        test('updates the settlement record with calculated values', () => {
            record._setMockRecord('customrecord_sust_settlement_record', '200', {
                custrecord_sust_settlement_net_lbs: '500',
                custrecord_sust_settlement_market_price: '0.10',
                custrecord_sust_settlement_treatment: '20',
                custrecord_sust_settlement_provisional: '10',
                custrecord_sust_settlement_schedule: '',
                custrecord_sust_settlement_lot: ''
            });
            search._setSearchResults('customrecord_sust_penalty_detail', []);

            const ctx = createCalculateContext('200');
            slModule.onRequest(ctx);

            expect(record.submitFields).toHaveBeenCalledWith(expect.objectContaining({
                type: 'customrecord_sust_settlement_record',
                id: '200',
                values: expect.objectContaining({
                    custrecord_sust_settlement_penalties: 0,
                    custrecord_sust_settlement_gross_value: 50, // 500 * 0.10
                    custrecord_sust_settlement_net_value: 30,   // 50 - 20 - 0
                    custrecord_sust_settlement_balance_due: 20  // 30 - 10
                })
            }));
        });
    });
});
