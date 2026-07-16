/**
 * Unit Tests for Shipping Matrix Suitelet
 * Tests consolidated shipment creation, pallet management, BOL generation, fulfillment linking
 */

const record = require('./mocks/N/record');
const search = require('./mocks/N/search');
const log = require('./mocks/N/log');
const runtime = require('./mocks/N/runtime');
const serverWidget = require('./mocks/N/ui/serverWidget');
const renderMod = require('./mocks/N/render');
const urlMod = require('./mocks/N/url');
const redirectMod = require('./mocks/N/redirect');

// Load the REAL units lib (no deps) so tons-formatting exercises real math.
let unitsLib;
const originalDefine = global.define;
global.define = function(deps, factory) {
    unitsLib = factory();
};
require('../src/FileCabinet/SuiteScripts/Sustana/SUST_Lib_Units');

let shippingMatrix;

global.define = function(deps, factory) {
    const depMap = {
        'N/ui/serverWidget': serverWidget,
        'N/record': record,
        'N/search': search,
        'N/log': log,
        'N/runtime': runtime,
        'N/url': urlMod,
        'N/redirect': redirectMod,
        'N/render': renderMod,
        './SUST_Lib_Units': unitsLib
    };
    const resolvedDeps = deps.map(d => {
        if (!(d in depMap)) throw new Error('Unmapped AMD dependency in ShippingMatrix test: ' + d);
        return depMap[d];
    });
    shippingMatrix = factory(...resolvedDeps);
};
require('../src/FileCabinet/SuiteScripts/Sustana/SUST_SL_ShippingMatrix.js');

global.define = originalDefine;

describe('Shipping Matrix Suitelet', () => {
    let mockForm;
    let mockSublist;
    let mockContext;

    beforeEach(() => {
        record._reset();
        search._reset();
        log._reset();
        jest.clearAllMocks();

        mockSublist = {
            addField: jest.fn(() => ({
                updateDisplayType: jest.fn()
            })),
            setSublistValue: jest.fn()
        };

        mockForm = {
            addField: jest.fn(() => ({
                updateDisplayType: jest.fn(),
                defaultValue: null
            })),
            addFieldGroup: jest.fn(),
            addSublist: jest.fn(() => mockSublist),
            addButton: jest.fn(),
            addSubmitButton: jest.fn(),
            clientScriptModulePath: null
        };

        serverWidget.createForm = jest.fn(() => mockForm);

        runtime.getCurrentScript = jest.fn(() => ({
            id: 'customscript_sust_sl_shipmatrix',
            deploymentId: 'customdeploy_sust_sl_shipmatrix'
        }));

        runtime.getCurrentUser = jest.fn(() => ({
            id: 1,
            name: 'Test User'
        }));

        mockContext = {
            request: {
                method: 'GET',
                parameters: {},
                getLineCount: jest.fn(() => 0),
                getSublistValue: jest.fn(() => '')
            },
            response: {
                writePage: jest.fn(),
                write: jest.fn(),
                writeFile: jest.fn()
            }
        };
    });

    describe('GET - List Mode', () => {
        test('renders list of consolidated shipments', () => {
            // Setup search to return shipments
            search.create = jest.fn(() => ({
                run: jest.fn(() => ({
                    each: jest.fn((callback) => {
                        // Return one consolidated shipment
                        callback({
                            id: '1',
                            getValue: jest.fn((field) => {
                                const values = {
                                    custrecord_sust_cs_ship_date: '3/10/2026',
                                    custrecord_sust_cs_bol_number: 'BOL-001',
                                    custrecord_sust_cs_carrier: 'FedEx Freight',
                                    custrecord_sust_cs_total_pallets: 4,
                                    custrecord_sust_cs_total_weight: 5200,
                                    custrecord_sust_cs_status: '1'
                                };
                                return values[field] || '';
                            }),
                            getText: jest.fn((field) => {
                                if (field === 'custrecord_sust_cs_status') return 'Open';
                                return '';
                            })
                        });
                        return false; // Stop after first
                    })
                }))
            }));

            shippingMatrix.onRequest(mockContext);

            expect(serverWidget.createForm).toHaveBeenCalledWith(
                expect.objectContaining({ title: expect.stringContaining('Shipping Matrix') })
            );
            expect(mockContext.response.writePage).toHaveBeenCalledWith(mockForm);
        });

        test('renders New Consolidated Shipment button', () => {
            search.create = jest.fn(() => ({
                run: jest.fn(() => ({
                    each: jest.fn(() => false)
                }))
            }));

            shippingMatrix.onRequest(mockContext);

            expect(mockForm.addButton).toHaveBeenCalledWith(
                expect.objectContaining({
                    label: 'New Consolidated Shipment',
                    functionName: 'doAction_newShipment'
                })
            );
        });
    });

    describe('GET - New Shipment Form', () => {
        test('renders new shipment form with fulfillment selection', () => {
            mockContext.request.parameters = { mode: 'new' };

            search.create = jest.fn(() => ({
                run: jest.fn(() => ({
                    each: jest.fn(() => false)
                }))
            }));

            shippingMatrix.onRequest(mockContext);

            expect(serverWidget.createForm).toHaveBeenCalledWith(
                expect.objectContaining({ title: 'Sustana Recovery — New Consolidated Shipment' })
            );
            expect(mockForm.addSubmitButton).toHaveBeenCalledWith(
                expect.objectContaining({ label: 'Create Consolidated Shipment' })
            );
        });
    });

    describe('GET - Detail Mode (Pallet Grid)', () => {
        test('renders pallet entry grid for a consolidated shipment', () => {
            mockContext.request.parameters = { mode: 'detail', csid: '1' };

            // Mock loading the CS record
            const mockCsRec = {
                getValue: jest.fn((field) => {
                    const values = {
                        custrecord_sust_cs_bol_number: 'BOL-001',
                        custrecord_sust_cs_carrier: 'FedEx Freight',
                        custrecord_sust_cs_ship_date: '3/10/2026',
                        custrecord_sust_cs_notes: ''
                    };
                    return values[field] || '';
                }),
                getText: jest.fn((field) => {
                    if (field === 'custrecord_sust_cs_status') return 'Open';
                    return '';
                })
            };
            record.load = jest.fn(() => mockCsRec);

            // Empty fulfillments and pallets
            search.create = jest.fn(() => ({
                run: jest.fn(() => ({
                    each: jest.fn(() => false)
                }))
            }));

            shippingMatrix.onRequest(mockContext);

            expect(record.load).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'customrecord_sust_consol_ship', id: 1 })
            );
            expect(mockForm.addSubmitButton).toHaveBeenCalledWith(
                expect.objectContaining({ label: 'Save Pallets' })
            );
        });

        test('shows Mark as Shipped button for Open shipments', () => {
            mockContext.request.parameters = { mode: 'detail', csid: '1' };

            const mockCsRec = {
                getValue: jest.fn(() => ''),
                getText: jest.fn((field) => {
                    if (field === 'custrecord_sust_cs_status') return 'Open';
                    return '';
                })
            };
            record.load = jest.fn(() => mockCsRec);

            search.create = jest.fn(() => ({
                run: jest.fn(() => ({
                    each: jest.fn(() => false)
                }))
            }));

            shippingMatrix.onRequest(mockContext);

            expect(mockForm.addButton).toHaveBeenCalledWith(
                expect.objectContaining({
                    label: 'Mark as Shipped',
                    functionName: 'doAction_markShipped'
                })
            );
        });
    });

    describe('GET - BOL PDF Generation', () => {
        test('generates PDF BOL for a consolidated shipment', () => {
            mockContext.request.parameters = { mode: 'bol', csid: '1' };

            const mockCsRec = {
                getValue: jest.fn((field) => {
                    const values = {
                        custrecord_sust_cs_bol_number: 'BOL-001',
                        custrecord_sust_cs_carrier: 'FedEx Freight',
                        custrecord_sust_cs_ship_date: '3/10/2026',
                        custrecord_sust_cs_notes: 'Handle with care'
                    };
                    return values[field] || '';
                }),
                getText: jest.fn(() => 'Open')
            };
            record.load = jest.fn(() => mockCsRec);

            // No linked fulfillments
            search.create = jest.fn(() => ({
                run: jest.fn(() => ({
                    each: jest.fn(() => false)
                }))
            }));

            shippingMatrix.onRequest(mockContext);

            expect(renderMod.xmlToPdf).toHaveBeenCalledWith(
                expect.objectContaining({
                    xmlString: expect.stringContaining('BILL OF LADING')
                })
            );
            expect(mockContext.response.writeFile).toHaveBeenCalled();
        });

        test('BOL contains carrier and BOL number', () => {
            mockContext.request.parameters = { mode: 'bol', csid: '1' };

            const mockCsRec = {
                getValue: jest.fn((field) => {
                    if (field === 'custrecord_sust_cs_bol_number') return 'BOL-TEST-123';
                    if (field === 'custrecord_sust_cs_carrier') return 'XPO Logistics';
                    return '';
                }),
                getText: jest.fn(() => 'Open')
            };
            record.load = jest.fn(() => mockCsRec);

            search.create = jest.fn(() => ({
                run: jest.fn(() => ({
                    each: jest.fn(() => false)
                }))
            }));

            shippingMatrix.onRequest(mockContext);

            const xmlArg = renderMod.xmlToPdf.mock.calls[0][0].xmlString;
            expect(xmlArg).toContain('BOL-TEST-123');
            expect(xmlArg).toContain('XPO Logistics');
        });
    });

    describe('POST - Create Shipment', () => {
        test('creates consolidated shipment record', () => {
            mockContext.request.method = 'POST';
            mockContext.request.parameters = {
                custpage_action: 'create_shipment',
                custpage_ship_date: '3/10/2026',
                custpage_carrier: 'FedEx Freight',
                custpage_bol_number: 'BOL-001',
                custpage_notes: 'Test shipment'
            };
            mockContext.request.getLineCount = jest.fn(() => 0);

            const mockCsRec = {
                setValue: jest.fn(),
                setText: jest.fn(),
                save: jest.fn(() => 1)
            };
            record.create = jest.fn(() => mockCsRec);

            shippingMatrix.onRequest(mockContext);

            expect(record.create).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'customrecord_sust_consol_ship' })
            );
            expect(mockCsRec.setValue).toHaveBeenCalledWith(
                expect.objectContaining({ fieldId: 'custrecord_sust_cs_carrier', value: 'FedEx Freight' })
            );
            expect(mockCsRec.setValue).toHaveBeenCalledWith(
                expect.objectContaining({ fieldId: 'custrecord_sust_cs_bol_number', value: 'BOL-001' })
            );
            expect(mockCsRec.save).toHaveBeenCalled();
        });

        test('links selected fulfillments to new shipment', () => {
            mockContext.request.method = 'POST';
            mockContext.request.parameters = {
                custpage_action: 'create_shipment',
                custpage_ship_date: '3/10/2026',
                custpage_carrier: '',
                custpage_bol_number: '',
                custpage_notes: ''
            };
            mockContext.request.getLineCount = jest.fn(() => 2);
            mockContext.request.getSublistValue = jest.fn((opts) => {
                if (opts.name === 'custpage_ff_select' && opts.line === 0) return 'T';
                if (opts.name === 'custpage_ff_select' && opts.line === 1) return 'F';
                if (opts.name === 'custpage_ff_id' && opts.line === 0) return '100';
                if (opts.name === 'custpage_ff_id' && opts.line === 1) return '101';
                return '';
            });

            const mockCsRec = {
                setValue: jest.fn(),
                setText: jest.fn(),
                save: jest.fn(() => 1)
            };
            record.create = jest.fn(() => mockCsRec);
            record.submitFields = jest.fn();

            shippingMatrix.onRequest(mockContext);

            // Should link only the first FF (selected)
            expect(record.submitFields).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: record.Type.ITEM_FULFILLMENT,
                    id: 100,
                    values: { custbody_sust_consol_shipment: 1 }
                })
            );
            // Should NOT link the second FF
            expect(record.submitFields).not.toHaveBeenCalledWith(
                expect.objectContaining({ id: 101 })
            );
        });
    });

    describe('POST - Mark Shipped', () => {
        test('updates shipment status to Shipped', () => {
            mockContext.request.method = 'POST';
            mockContext.request.parameters = {
                custpage_action: 'mark_shipped',
                custpage_cs_id: '1'
            };

            const mockCsRec = {
                setText: jest.fn(),
                save: jest.fn(() => 1)
            };
            record.load = jest.fn(() => mockCsRec);
            record.submitFields = jest.fn();

            shippingMatrix.onRequest(mockContext);

            expect(mockCsRec.setText).toHaveBeenCalledWith(
                expect.objectContaining({ fieldId: 'custrecord_sust_cs_status', text: 'Shipped' })
            );
            expect(mockCsRec.save).toHaveBeenCalled();
        });
    });

    describe('POST - Cancel Shipment', () => {
        test('updates shipment status to Cancelled', () => {
            mockContext.request.method = 'POST';
            mockContext.request.parameters = {
                custpage_action: 'cancel_shipment',
                custpage_cs_id: '1'
            };

            const mockCsRec = {
                setText: jest.fn(),
                save: jest.fn(() => 1)
            };
            record.load = jest.fn(() => mockCsRec);

            shippingMatrix.onRequest(mockContext);

            expect(mockCsRec.setText).toHaveBeenCalledWith(
                expect.objectContaining({ fieldId: 'custrecord_sust_cs_status', text: 'Cancelled' })
            );
        });
    });

    describe('Error Handling', () => {
        test('handles errors gracefully and writes error page', () => {
            mockContext.request.parameters = { mode: 'detail', csid: '999' };
            record.load = jest.fn(() => { throw new Error('Record not found'); });

            shippingMatrix.onRequest(mockContext);

            expect(mockContext.response.write).toHaveBeenCalledWith(
                expect.stringContaining('Record not found')
            );
        });
    });
});
