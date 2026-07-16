/**
 * Mock for N/currentRecord module
 */

const recordMock = require('./record');

let mockCurrentRecord = null;

module.exports = {
    get: jest.fn(() => {
        if (!mockCurrentRecord) {
            mockCurrentRecord = recordMock._createMockRecord('customrecord_sust_melt_sheet');
        }
        return mockCurrentRecord;
    }),

    // Test helper functions
    _reset: () => {
        mockCurrentRecord = null;
    },

    _setCurrentRecord: (rec) => {
        mockCurrentRecord = rec;
    },

    _createMockRecord: (type, data) => {
        return recordMock._createMockRecord(type, data);
    }
};
