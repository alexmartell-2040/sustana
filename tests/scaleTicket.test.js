/**
 * Unit tests for the Scale Ticket kiosk — SUST_SL_ScaleTicket.js (Suitelet)
 * and SUST_CS_ScaleTicket.js (Client Script) — the 7:00/7:30 receiving moment.
 *
 * The Suitelet IS the scale system: it renders the kiosk form, guards
 * against duplicate ticket numbers, and on save transforms the selected PO
 * into an Item Receipt with weight columns + lot number = ticket number, so
 * the existing receipt UE chain (landed cost -> settlement -> vendor-lot
 * bridge) fires untouched — ticket in, AP-ready receipt out, zero re-keying.
 */

const record = require('./mocks/N/record');
const search = require('./mocks/N/search');
const runtime = require('./mocks/N/runtime');
const log = require('./mocks/N/log');
const urlMock = require('./mocks/N/url');
const serverWidget = require('./mocks/N/ui/serverWidget');
const dialog = require('./mocks/N/ui/dialog');

// Load the REAL units lib (no deps), then the Suitelet with it injected.
let unitsLib;
const originalDefine = global.define;
global.define = function(deps, factory) {
    unitsLib = factory();
};
require('../src/FileCabinet/SuiteScripts/Sustana/SUST_Lib_Units');

// Load the REAL lot-attributes lib with mocked N/ modules injected.
let lotAttrLib;
global.define = function(deps, factory) {
    const depMap = { 'N/record': record, 'N/search': search, 'N/log': log };
    lotAttrLib = factory(...deps.map(d => depMap[d]));
};
require('../src/FileCabinet/SuiteScripts/Sustana/SUST_Lib_LotAttributes');

let scaleTicket;
global.define = function(deps, factory) {
    const depMap = {
        'N/ui/serverWidget': serverWidget,
        'N/record': record,
        'N/search': search,
        'N/runtime': runtime,
        'N/url': urlMock,
        'N/log': log,
        './SUST_Lib_Units': unitsLib,
        './SUST_Lib_LotAttributes': lotAttrLib
    };
    const resolvedDeps = deps.map(d => {
        if (!(d in depMap)) throw new Error('Unmapped AMD dependency in ScaleTicket SL test: ' + d);
        return depMap[d];
    });
    scaleTicket = factory(...resolvedDeps);
};
require('../src/FileCabinet/SuiteScripts/Sustana/SUST_SL_ScaleTicket');

let scaleTicketCS;
global.define = function(deps, factory) {
    const depMap = {
        'N/currentRecord': {},
        'N/url': urlMock,
        'N/ui/dialog': dialog
    };
    const resolvedDeps = deps.map(d => {
        if (!(d in depMap)) throw new Error('Unmapped AMD dependency in ScaleTicket CS test: ' + d);
        return depMap[d];
    });
    scaleTicketCS = factory(...resolvedDeps);
};
require('../src/FileCabinet/SuiteScripts/Sustana/SUST_CS_ScaleTicket');

global.define = originalDefine;

const TICKET_TYPE = 'customrecord_sust_scale_ticket';

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function createMockForm() {
    const fields = {};
    return {
        clientScriptModulePath: null,
        addFieldGroup: jest.fn(),
        addField: jest.fn((opts) => {
            const f = {
                defaultValue: null,
                isMandatory: false,
                updateDisplayType: jest.fn(),
                setHelpText: jest.fn(),
                addSelectOption: jest.fn()
            };
            fields[opts.id] = f;
            return f;
        }),
        addSubmitButton: jest.fn(),
        _fields: fields
    };
}

function createGetContext(params) {
    let capturedForm = null;
    serverWidget.createForm.mockImplementation((opts) => {
        capturedForm = createMockForm();
        capturedForm._title = opts.title;
        return capturedForm;
    });
    const ctx = {
        request: { method: 'GET', parameters: params || {} },
        response: { writePage: jest.fn(), write: jest.fn() }
    };
    scaleTicket.onRequest(ctx);
    return { ctx, form: capturedForm };
}

function createPostContext(params) {
    const ctx = {
        request: { method: 'POST', parameters: params },
        response: { write: jest.fn(), writePage: jest.fn() }
    };
    scaleTicket.onRequest(ctx);
    return ctx;
}

function writtenHtml(ctx) {
    return ctx.response.write.mock.calls.map(c => c[0]).join('');
}

function createCurrentRecord(initial) {
    const values = { ...initial };
    return {
        getValue: jest.fn(({ fieldId }) => values[fieldId]),
        setValue: jest.fn(({ fieldId, value }) => { values[fieldId] = value; }),
        _values: values
    };
}

describe('SUST_SL_ScaleTicket (Suitelet)', () => {

    beforeEach(() => {
        record._reset();
        search._reset();
        log._reset();
        jest.clearAllMocks();
    });

    // ============================================================
    // GET - blank kiosk form
    // ============================================================

    describe('GET - blank kiosk', () => {
        test('renders the kiosk title and suggests TRK-001 when no tickets exist', () => {
            const { form } = createGetContext({});
            expect(form._title).toBe('Sustana Recovery — Scale Kiosk');
            expect(form._fields.custpage_ticket_number.defaultValue).toBe('TRK-001');
        });

        test('suggests the next sequential ticket number from existing tickets', () => {
            search._setSearchResults(TICKET_TYPE, [
                { id: '1', values: { custrecord_sust_st_ticket_number: 'TRK-001' } },
                { id: '2', values: { custrecord_sust_st_ticket_number: 'TRK-004' } },
                { id: '3', values: { custrecord_sust_st_ticket_number: 'TRK-002' } }
            ]);
            const { form } = createGetContext({});
            expect(form._fields.custpage_ticket_number.defaultValue).toBe('TRK-005');
        });

        test('attaches the client script', () => {
            const { form } = createGetContext({});
            expect(form.clientScriptModulePath).toBe('./SUST_CS_ScaleTicket.js');
        });

        test('does not populate the PO dropdown when no vendor is selected', () => {
            const { form } = createGetContext({});
            // Only the blank option is added.
            expect(form._fields.custpage_po.addSelectOption).toHaveBeenCalledTimes(1);
            expect(form._fields.custpage_po.addSelectOption).toHaveBeenCalledWith({ value: '', text: '' });
        });

        test('populates open POs for the vendor query param, filtered to receivable statuses', () => {
            search._setSearchResults(search.Type.PURCHASE_ORDER, [
                { id: '900', values: { tranid: 'PO-10001', trandate: '7/16/2026' } }
            ]);
            const { form } = createGetContext({ vendor: '50' });

            expect(form._fields.custpage_po.addSelectOption).toHaveBeenCalledWith(
                expect.objectContaining({ value: '900', text: expect.stringContaining('PO-10001') })
            );
            const searchOpts = search.create.mock.calls.find(c => c[0].type === search.Type.PURCHASE_ORDER)[0];
            expect(searchOpts.filters).toEqual([
                ['entity', 'anyof', '50'],
                'AND', ['mainline', 'is', 'T'],
                'AND', ['status', 'anyof', 'PurchOrd:B', 'PurchOrd:D', 'PurchOrd:E']
            ]);
        });
    });

    // ============================================================
    // GET - correction mode
    // ============================================================

    describe('GET - correction mode (?ticket=id)', () => {
        test('loads the existing ticket, disables the ticket-number field, and flags the linked IR', () => {
            record._setMockRecord(TICKET_TYPE, '55', {
                custrecord_sust_st_ticket_number: 'TRK-002',
                custrecord_sust_st_gross_lbs: 78500,
                custrecord_sust_st_item_receipt: '900'
            });
            const { form } = createGetContext({ ticket: '55' });

            expect(form._title).toContain('Correction');
            expect(form._title).toContain('TRK-002');
            expect(form._fields.custpage_ticket_number.defaultValue).toBe('TRK-002');
            expect(form._fields.custpage_ticket_number.updateDisplayType).toHaveBeenCalled();
            expect(form._fields.custpage_resync_note).toBeDefined();
            expect(form._fields.custpage_resync_note.defaultValue).toContain('900');
        });
    });

    // ============================================================
    // POST - validation
    // ============================================================

    describe('POST - validation', () => {
        test('rejects a missing ticket number', () => {
            const ctx = createPostContext({ custpage_vendor: '50', custpage_gross: '100', custpage_tare: '20' });
            expect(writtenHtml(ctx)).toContain('Ticket number is required');
            expect(record.create).not.toHaveBeenCalled();
        });

        test('rejects invalid weights (tare >= gross)', () => {
            const ctx = createPostContext({
                custpage_ticket_number: 'TRK-009', custpage_vendor: '50',
                custpage_gross: '100', custpage_tare: '150'
            });
            expect(writtenHtml(ctx)).toContain('Weights invalid');
            expect(record.create).not.toHaveBeenCalled();
        });
    });

    // ============================================================
    // POST - duplicate ticket guard
    // ============================================================

    describe('POST - duplicate ticket guard', () => {
        test('blocks a second ticket with the same number and links to the existing one', () => {
            search._setSearchResults(TICKET_TYPE, [{ id: '77', values: {} }]);
            const ctx = createPostContext({
                custpage_ticket_number: 'TRK-001', custpage_vendor: '50',
                custpage_gross: '78500', custpage_tare: '38500'
            });

            expect(record.create).not.toHaveBeenCalled();
            const html = writtenHtml(ctx);
            expect(html).toContain('Duplicate ticket');
            expect(html).toContain('TRK-001');
            expect(html).toContain('Open existing ticket');
        });
    });

    // ============================================================
    // POST - create without a PO (outage fallback)
    // ============================================================

    describe('POST - create without a PO (outage fallback)', () => {
        test('saves the ticket as Weighed Out without creating an Item Receipt', () => {
            const ctx = createPostContext({
                custpage_ticket_number: 'TRK-010', custpage_vendor: '50',
                custpage_gross: '50000', custpage_tare: '20000'
            });

            expect(record.create).toHaveBeenCalledWith({ type: TICKET_TYPE });
            expect(record.transform).not.toHaveBeenCalled();

            const created = record.create.mock.results[0].value;
            expect(created._values.custrecord_sust_st_status_text).toBe('Weighed Out');
            expect(created._values.custrecord_sust_st_net_lbs).toBe(30000);

            expect(writtenHtml(ctx)).toContain('receive manually when ready');
        });
    });

    // ============================================================
    // POST - create with a PO (receive against the PO)
    // ============================================================

    describe('POST - create with a PO (receive against the PO)', () => {
        beforeEach(() => {
            record._setMockTransform('purchaseorder', '900', 'itemreceipt', {
                values: {},
                sublists: { item: [{ item: '55', itemreceive: true }] }
            });
        });

        test('transforms the PO to an Item Receipt with weight columns and lot = ticket number', () => {
            const ctx = createPostContext({
                custpage_ticket_number: 'TRK-002', custpage_vendor: '50', custpage_po: '900',
                custpage_gross: '78500', custpage_tare: '38500', custpage_location: '3'
            });

            expect(record.transform).toHaveBeenCalledWith({
                fromType: 'purchaseorder', fromId: 900, toType: 'itemreceipt', isDynamic: false
            });

            const ir = record.transform.mock.results[0].value;
            expect(ir._values.custbody_sust_scale_ticket).toBe(1); // the ticket's own saved id
            expect(ir._sublistData.item[0].quantity).toBe(40000);
            expect(ir._sublistData.item[0].custcol_sust_scrap_gross_weight).toBe(78500);
            expect(ir._sublistData.item[0].custcol_sust_scrap_net_weight).toBe(40000);
            expect(ir._sublistData.item[0].location).toBe(3);

            // Lot number = ticket number, set via the inventorydetail subrecord.
            const detail = ir._subrecords['item_inventorydetail_0'];
            expect(detail._sublistData.inventoryassignment[0].receiptinventorynumber).toBe('TRK-002');
            expect(detail._sublistData.inventoryassignment[0].quantity).toBe(40000);

            const html = writtenHtml(ctx);
            expect(html).toContain('zero re-keying');
            expect(html).toContain('40,000 lbs');
            expect(html).toContain('20.00 tons');
        });

        test('marks the ticket Received and links the auto-created receipt and settlement', () => {
            search._setSearchResults('customrecord_sust_settlement_record', [{ id: '321', values: {} }]);
            const ctx = createPostContext({
                custpage_ticket_number: 'TRK-003', custpage_vendor: '50', custpage_po: '900',
                custpage_gross: '78500', custpage_tare: '38500'
            });

            const html = writtenHtml(ctx);
            expect(html).toContain('Item Receipt (auto-created)');
            expect(html).toContain('Supplier Settlement (auto-created by the receipt)');

            expect(record.submitFields).toHaveBeenCalledWith(expect.objectContaining({
                type: TICKET_TYPE,
                values: expect.objectContaining({ custrecord_sust_st_item_receipt: expect.any(Number) })
            }));
        });

        test('when the PO has no receivable lines, the ticket is still saved and the outage fallback is suggested', () => {
            record._setMockTransform('purchaseorder', '900', 'itemreceipt', { values: {}, sublists: { item: [] } });
            const ctx = createPostContext({
                custpage_ticket_number: 'TRK-006', custpage_vendor: '50', custpage_po: '900',
                custpage_gross: '78500', custpage_tare: '38500'
            });

            const html = writtenHtml(ctx);
            expect(html).toContain('receiving failed');
            expect(html).toContain('outage fallback');
            expect(html).toContain('Scale Ticket TRK-006');
        });
    });

    // ============================================================
    // POST - correction (re-sync weights to an existing IR)
    // ============================================================

    describe('POST - correction (existing ticket + IR, re-sync weights)', () => {
        test('re-syncs corrected weights to the linked Item Receipt without re-transforming the PO', () => {
            record._setMockRecord(TICKET_TYPE, '55', {
                custrecord_sust_st_ticket_number: 'TRK-002',
                custrecord_sust_st_item_receipt: '900'
            });

            const irMock = record._createMockRecord('itemreceipt', { id: '900' }, {
                item: [{ custcol_sust_scrap_net_weight: 40000, quantity: 40000 }]
            });
            record.load.mockImplementation((opts) => {
                if (opts.type === 'itemreceipt') return irMock;
                const stored = record._getMockRecord(opts.type, opts.id);
                return record._createMockRecord(opts.type, { id: opts.id, ...(stored ? stored.values : {}) });
            });

            const ctx = createPostContext({
                custpage_ticket_id: '55', custpage_ticket_number: 'TRK-002', custpage_vendor: '50',
                custpage_gross: '79000', custpage_tare: '38500'
            });

            expect(record.transform).not.toHaveBeenCalled();
            expect(irMock._sublistData.item[0].quantity).toBe(40500);
            expect(irMock._sublistData.item[0].custcol_sust_scrap_gross_weight).toBe(79000);
            expect(irMock._sublistData.item[0].custcol_sust_scrap_net_weight).toBe(40500);
            expect(irMock.save).toHaveBeenCalled();

            expect(writtenHtml(ctx)).toContain('Ticket corrected');
        });
    });
});

describe('SUST_CS_ScaleTicket (Client Script)', () => {

    beforeEach(() => {
        dialog._reset();
        jest.clearAllMocks();
        global.window = { location: { href: '' } };
    });

    afterEach(() => {
        delete global.window;
    });

    describe('net weight computation', () => {
        test('pageInit computes net = gross - tare', () => {
            const rec = createCurrentRecord({ custpage_gross: 78500, custpage_tare: 38500 });
            scaleTicketCS.pageInit({ currentRecord: rec });
            expect(rec._values.custpage_net).toBe(40000);
        });

        test('recomputes net when gross or tare changes', () => {
            const rec = createCurrentRecord({ custpage_gross: 100, custpage_tare: 20 });
            scaleTicketCS.fieldChanged({ currentRecord: rec, fieldId: 'custpage_tare' });
            expect(rec._values.custpage_net).toBe(80);
        });

        test('blanks net instead of showing a negative value', () => {
            const rec = createCurrentRecord({ custpage_gross: 20, custpage_tare: 50 });
            scaleTicketCS.fieldChanged({ currentRecord: rec, fieldId: 'custpage_gross' });
            expect(rec._values.custpage_net).toBe('');
        });
    });

    describe('vendor change reloads the kiosk for the open-PO dropdown', () => {
        test('navigates to the kiosk with ?vendor= when creating a new ticket', () => {
            const rec = createCurrentRecord({ custpage_vendor: '50', custpage_ticket_id: '' });
            scaleTicketCS.fieldChanged({ currentRecord: rec, fieldId: 'custpage_vendor' });

            expect(urlMock.resolveScript).toHaveBeenCalledWith(expect.objectContaining({
                scriptId: 'customscript_sust_sl_scaleticket',
                deploymentId: 'customdeploy_sust_sl_scaleticket',
                params: { vendor: '50' }
            }));
            expect(window.location.href).not.toBe('');
        });

        test('does not reload when correcting an existing ticket', () => {
            const rec = createCurrentRecord({ custpage_vendor: '50', custpage_ticket_id: '55' });
            scaleTicketCS.fieldChanged({ currentRecord: rec, fieldId: 'custpage_vendor' });
            expect(window.location.href).toBe('');
            expect(urlMock.resolveScript).not.toHaveBeenCalled();
        });
    });

    describe('saveRecord validation', () => {
        test('blocks save with no ticket number', () => {
            const rec = createCurrentRecord({});
            expect(scaleTicketCS.saveRecord({ currentRecord: rec })).toBe(false);
            expect(dialog.alert).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining('ticket number')
            }));
        });

        test('blocks save with no supplier', () => {
            const rec = createCurrentRecord({ custpage_ticket_number: 'TRK-001' });
            expect(scaleTicketCS.saveRecord({ currentRecord: rec })).toBe(false);
        });

        test('blocks save when gross is zero', () => {
            const rec = createCurrentRecord({
                custpage_ticket_number: 'TRK-001', custpage_vendor: '50',
                custpage_gross: 0, custpage_tare: 0
            });
            expect(scaleTicketCS.saveRecord({ currentRecord: rec })).toBe(false);
        });

        test('blocks save when tare >= gross', () => {
            const rec = createCurrentRecord({
                custpage_ticket_number: 'TRK-001', custpage_vendor: '50',
                custpage_gross: 100, custpage_tare: 100
            });
            expect(scaleTicketCS.saveRecord({ currentRecord: rec })).toBe(false);
        });

        test('allows save with valid ticket data', () => {
            const rec = createCurrentRecord({
                custpage_ticket_number: 'TRK-001', custpage_vendor: '50',
                custpage_gross: 100, custpage_tare: 20
            });
            expect(scaleTicketCS.saveRecord({ currentRecord: rec })).toBe(true);
            expect(dialog.alert).not.toHaveBeenCalled();
        });
    });
});
