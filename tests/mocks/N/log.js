/**
 * Mock for N/log module
 */

const logHistory = {
    debug: [],
    audit: [],
    error: [],
    emergency: []
};

module.exports = {
    debug: jest.fn((title, details) => {
        logHistory.debug.push({ title, details });
    }),

    audit: jest.fn((title, details) => {
        logHistory.audit.push({ title, details });
    }),

    error: jest.fn((title, details) => {
        logHistory.error.push({ title, details });
    }),

    emergency: jest.fn((title, details) => {
        logHistory.emergency.push({ title, details });
    }),

    // Test helper functions
    _reset: () => {
        logHistory.debug = [];
        logHistory.audit = [];
        logHistory.error = [];
        logHistory.emergency = [];
    },

    _getHistory: () => ({ ...logHistory })
};
