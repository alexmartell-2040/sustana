/**
 * Mock for N/redirect module
 */

const redirectHistory = [];

module.exports = {
    toRecord: jest.fn((options) => {
        redirectHistory.push({ type: 'record', ...options });
    }),

    toSuitelet: jest.fn((options) => {
        redirectHistory.push({ type: 'suitelet', ...options });
    }),

    toTaskLink: jest.fn((options) => {
        redirectHistory.push({ type: 'taskLink', ...options });
    }),

    toSavedSearchResult: jest.fn((options) => {
        redirectHistory.push({ type: 'savedSearchResult', ...options });
    }),

    toSearch: jest.fn((options) => {
        redirectHistory.push({ type: 'search', ...options });
    }),

    // Test helper functions
    _reset: () => {
        redirectHistory.length = 0;
    },

    _getHistory: () => [...redirectHistory]
};
