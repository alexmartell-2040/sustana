/**
 * Mock for N/ui/dialog module
 */

const dialogHistory = {
    alerts: [],
    confirms: [],
    creates: []
};

module.exports = {
    alert: jest.fn((options) => {
        dialogHistory.alerts.push(options);
        return Promise.resolve(true);
    }),

    confirm: jest.fn((options) => {
        dialogHistory.confirms.push(options);
        return Promise.resolve(true);
    }),

    create: jest.fn((options) => {
        dialogHistory.creates.push(options);
        return {
            addButton: jest.fn(),
            setTitle: jest.fn(),
            setContent: jest.fn()
        };
    }),

    // Test helper functions
    _reset: () => {
        dialogHistory.alerts = [];
        dialogHistory.confirms = [];
        dialogHistory.creates = [];
    },

    _getHistory: () => ({ ...dialogHistory }),

    _setConfirmResult: (result) => {
        module.exports.confirm.mockImplementation((options) => {
            dialogHistory.confirms.push(options);
            return Promise.resolve(result);
        });
    }
};
