/**
 * Unit tests for SUST_UE_ItemReceipt_CreateSettlement — the PO-level dedup guard.
 *
 * Regression: multiple receipts against one PO did not flow into settlements.
 * The old guard skipped the whole IR when the PO had ANY settlement — including
 * the ones an earlier receipt just created. The refined guard only skips when the
 * PO carries a PRE-RECEIPT settlement (linked to the PO but to no Item Receipt).
 */

const record = require('./mocks/N/record');
const search = require('./mocks/N/search');
const runtime = require('./mocks/N/runtime');
const log = require('./mocks/N/log');

const configLibMock = {
    get: jest.fn(() => ''),
    getConfig: jest.fn(() => ({ usSubsidiary: 1, caSubsidiary: 2 }))
};

const settlementLibMock = {
    lookupItemField: jest.fn((itemId, field) => {
        if (field === 'custitem_sust_is_scrap_material') return true;
        if (field === 'custitem_sust_typical_recovery') return 95;
        return null;
    }),
    findExistingLineSettlement: jest.fn(() => null),
    resolveLotInternalId: jest.fn(() => 111),
    createLineSettlement: jest.fn(() => 999)
};

let ue;
const originalDefine = global.define;
global.define = function(deps, factory) {
    const depMap = {
        'N/record': record,
        'N/search': search,
        'N/runtime': runtime,
        'N/log': log,
        './SUST_Lib_SettlementCreate': settlementLibMock,
        './SUST_Lib_Config': configLibMock
    };
    const resolved = deps.map(d => {
        if (!(d in depMap)) throw new Error('Unmapped AMD dependency in UE test: ' + d);
        return depMap[d];
    });
    ue = factory(...resolved);
};
require('../src/FileCabinet/SuiteScripts/Sustana/SUST_UE_ItemReceipt_CreateSettlement');
global.define = originalDefine;

const UET = { CREATE: 'create', EDIT: 'edit', DELETE: 'delete' };
const IR_ID = 300;
const PO_ID = 200;

/** Build an Item Receipt mock with one scrap line + lot detail. */
function buildIR() {
    const ir = record._createMockRecord('itemreceipt', {
        id: IR_ID,
        subsidiary: 1,
        entity: 50,
        trandate: new Date('2026-07-02'),
        createdfrom: PO_ID,
        custbody_sust_pricing_timing_text: 'Determined on Arrival'
    }, {
        item: [{ item: 10, custcol_sust_pricing_timing_text: '' }]
    });
    // Inventory-detail subrecord for line 0
    ir.getSublistSubrecord = jest.fn(() =>
        record._createMockRecord('subrecord', {}, {
            inventoryassignment: [{ receiptinventorynumber: 'TRK-002', quantity: 40000 }]
        })
    );
    return ir;
}

/**
 * Seed the settlement search so the @NONE@-scoped (pre-receipt) query and the
 * broad (any-PO) query return different rows — this is what distinguishes the
 * fixed guard from the old one.
 */
function seedSettlementSearch({ preReceipt, anyOnPo }) {
    search._setSearchResults('customrecord_sust_settlement_record', (opts) => {
        const isPreReceiptQuery = JSON.stringify(opts.filters || []).indexOf('@NONE@') !== -1;
        return isPreReceiptQuery ? preReceipt : anyOnPo;
    });
}

beforeEach(() => {
    record._reset();
    search._reset();
    settlementLibMock.createLineSettlement.mockClear();
    settlementLibMock.findExistingLineSettlement.mockClear();
    record.load = jest.fn(() => buildIR());
});

function run() {
    ue.afterSubmit({ type: UET.CREATE, UserEventType: UET, newRecord: { id: IR_ID } });
}

describe('SUST_UE_ItemReceipt_CreateSettlement - PO-level guard', () => {

    test('later receipt still creates a settlement when the PO only has receipt-linked settlements', () => {
        // A prior receipt created a settlement on this PO (shows up in the broad query),
        // but there is NO pre-receipt (settle-before-receipt) settlement.
        seedSettlementSearch({ preReceipt: [], anyOnPo: [{ id: '900' }] });

        run();

        expect(settlementLibMock.createLineSettlement).toHaveBeenCalledTimes(1);
    });

    test('IR auto-create is skipped when the PO carries a pre-receipt (settle-before-receipt) settlement', () => {
        seedSettlementSearch({ preReceipt: [{ id: '901' }], anyOnPo: [{ id: '901' }] });

        run();

        expect(settlementLibMock.createLineSettlement).not.toHaveBeenCalled();
    });

    test('first receipt on a clean PO creates a settlement', () => {
        seedSettlementSearch({ preReceipt: [], anyOnPo: [] });

        run();

        expect(settlementLibMock.createLineSettlement).toHaveBeenCalledTimes(1);
        const args = settlementLibMock.createLineSettlement.mock.calls[0][0];
        expect(args.itemReceiptId).toBe(IR_ID);
        expect(args.poId).toBe(PO_ID);
        expect(args.sourceLine).toBe(1);
    });
});
