/**
 * Mock for N/record module
 */

const mockRecordData = {};
const mockTransformResults = {};
let recordIdCounter = 1;

const createMockRecord = (type, data = {}, sublists = {}) => {
    const values = { ...data };
    const sublistData = {};
    // Seed initial sublist lines (deep-ish copy so tests can't be mutated from outside)
    Object.keys(sublists).forEach((sublistId) => {
        sublistData[sublistId] = (sublists[sublistId] || []).map(line => ({ ...line }));
    });
    const subrecords = {};

    return {
        type,
        id: data.id || null,
        getValue: jest.fn((options) => {
            const fieldId = typeof options === 'string' ? options : options.fieldId;
            return values[fieldId];
        }),
        setValue: jest.fn((options) => {
            const fieldId = typeof options === 'string' ? options : options.fieldId;
            const value = typeof options === 'string' ? arguments[1] : options.value;
            values[fieldId] = value;
        }),
        getText: jest.fn((options) => {
            const fieldId = typeof options === 'string' ? options : options.fieldId;
            return values[`${fieldId}_text`] || values[fieldId];
        }),
        setText: jest.fn((options) => {
            const fieldId = typeof options === 'string' ? options : options.fieldId;
            const text = typeof options === 'string' ? arguments[1] : options.text;
            values[`${fieldId}_text`] = text;
        }),
        getLineCount: jest.fn((options) => {
            const sublistId = typeof options === 'string' ? options : options.sublistId;
            return sublistData[sublistId]?.length || 0;
        }),
        getSublistValue: jest.fn((options) => {
            const { sublistId, fieldId, line } = options;
            return sublistData[sublistId]?.[line]?.[fieldId];
        }),
        setSublistValue: jest.fn((options) => {
            const { sublistId, fieldId, line, value } = options;
            if (!sublistData[sublistId]) sublistData[sublistId] = [];
            if (!sublistData[sublistId][line]) sublistData[sublistId][line] = {};
            sublistData[sublistId][line][fieldId] = value;
        }),
        getSublistText: jest.fn((options) => {
            const { sublistId, fieldId, line } = options;
            const lineData = sublistData[sublistId]?.[line] || {};
            return lineData[`${fieldId}_text`] || lineData[fieldId];
        }),
        getCurrentSublistValue: jest.fn((options) => {
            const { sublistId, fieldId } = options;
            const currentLine = sublistData[`${sublistId}_current`] || {};
            return currentLine[fieldId];
        }),
        setCurrentSublistValue: jest.fn((options) => {
            const { sublistId, fieldId, value } = options;
            if (!sublistData[`${sublistId}_current`]) sublistData[`${sublistId}_current`] = {};
            sublistData[`${sublistId}_current`][fieldId] = value;
        }),
        selectLine: jest.fn(),
        selectNewLine: jest.fn((options) => {
            const { sublistId } = options;
            sublistData[`${sublistId}_current`] = {};
        }),
        commitLine: jest.fn((options) => {
            const { sublistId } = options;
            if (!sublistData[sublistId]) sublistData[sublistId] = [];
            sublistData[sublistId].push({ ...sublistData[`${sublistId}_current`] });
            sublistData[`${sublistId}_current`] = {};
        }),
        removeLine: jest.fn((options) => {
            const { sublistId, line } = options;
            if (sublistData[sublistId]) {
                sublistData[sublistId].splice(line, 1);
            }
        }),
        getCurrentSublistSubrecord: jest.fn(() => createMockRecord('subrecord')),
        // Cached per (sublistId, fieldId, line) so tests can inspect what the
        // script wrote to the subrecord (e.g. inventorydetail lot assignment).
        getSublistSubrecord: jest.fn((options) => {
            const { sublistId, fieldId, line } = options;
            const key = `${sublistId}_${fieldId}_${line}`;
            if (!subrecords[key]) subrecords[key] = createMockRecord('subrecord');
            return subrecords[key];
        }),
        getSubrecord: jest.fn(() => createMockRecord('subrecord')),
        save: jest.fn(() => {
            // Reuse the existing id when the record was loaded (real NetSuite
            // behavior); assign a fresh incremental id for new records.
            const id = values.id || recordIdCounter++;
            values.id = id;
            mockRecordData[`${type}_${id}`] = { type, id, values: { ...values } };
            return id;
        }),
        _values: values,
        _sublistData: sublistData,
        _subrecords: subrecords
    };
};

module.exports = {
    Type: {
        INVENTORY_ITEM: 'inventoryitem',
        INVENTORY_NUMBER: 'inventorynumber',
        WORK_ORDER: 'workorder',
        WORK_ORDER_COMPLETION: 'workordercompletion',
        SALES_ORDER: 'salesorder',
        PURCHASE_ORDER: 'purchaseorder',
        ITEM_RECEIPT: 'itemreceipt',
        ITEM_FULFILLMENT: 'itemfulfillment',
        VENDOR_BILL: 'vendorbill',
        VENDOR_CREDIT: 'vendorcredit',
        INVOICE: 'invoice',
        EMPLOYEE: 'employee',
        LOCATION: 'location',
        WORK_ORDER_ISSUE: 'workorderissue',
        WORK_ORDER_CLOSE: 'workorderclose'
    },

    create: jest.fn((options) => {
        return createMockRecord(options.type);
    }),

    load: jest.fn((options) => {
        const key = `${options.type}_${options.id}`;
        if (mockRecordData[key]) {
            return createMockRecord(options.type, { id: options.id, ...mockRecordData[key].values });
        }
        return createMockRecord(options.type, { id: options.id });
    }),

    delete: jest.fn((options) => {
        const key = `${options.type}_${options.id}`;
        delete mockRecordData[key];
        return options.id;
    }),

    transform: jest.fn((options) => {
        // Backward-compatible extension: results seeded via _setMockTransform
        // (keyed fromType_fromId_toType) come back with values + sublist lines,
        // so scripts that iterate transformed lines (e.g. PO -> IR) can run.
        const key = `${options.fromType}_${options.fromId}_${options.toType}`;
        const seeded = mockTransformResults[key];
        if (seeded) {
            return createMockRecord(
                options.toType,
                { createdfrom: options.fromId, ...(seeded.values || {}) },
                seeded.sublists || {}
            );
        }
        return createMockRecord(options.toType, { createdfrom: options.fromId });
    }),

    submitFields: jest.fn((options) => {
        const key = `${options.type}_${options.id}`;
        if (!mockRecordData[key]) {
            mockRecordData[key] = { type: options.type, id: options.id, values: {} };
        }
        Object.assign(mockRecordData[key].values, options.values);
        return options.id;
    }),

    // Test helper functions
    _reset: () => {
        Object.keys(mockRecordData).forEach(key => delete mockRecordData[key]);
        Object.keys(mockTransformResults).forEach(key => delete mockTransformResults[key]);
        recordIdCounter = 1;
    },

    _setMockRecord: (type, id, data) => {
        mockRecordData[`${type}_${id}`] = { type, id, values: data };
    },

    _getMockRecord: (type, id) => {
        return mockRecordData[`${type}_${id}`];
    },

    /**
     * Seed the result of record.transform({fromType, fromId, toType}).
     * config: { values: {fieldId: value}, sublists: {sublistId: [{fieldId: value}, ...]} }
     */
    _setMockTransform: (fromType, fromId, toType, config) => {
        mockTransformResults[`${fromType}_${fromId}_${toType}`] = config || {};
    },

    _createMockRecord: createMockRecord
};
