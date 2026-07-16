/**
 * Mock for N/runtime module
 */

let currentUser = {
    id: 1,
    name: 'Test User',
    email: 'test@example.com',
    role: 3,
    roleId: 'administrator',
    department: 1,
    location: 1,
    subsidiary: 1
};

let currentScript = {
    id: 'customscript_test',
    deploymentId: 'customdeploy_test',
    logLevel: 'DEBUG',
    percentComplete: 0,
    getRemainingUsage: jest.fn(() => 10000)
};

module.exports = {
    getCurrentUser: jest.fn(() => ({
        id: currentUser.id,
        name: currentUser.name,
        email: currentUser.email,
        role: currentUser.role,
        roleId: currentUser.roleId,
        department: currentUser.department,
        location: currentUser.location,
        subsidiary: currentUser.subsidiary
    })),

    getCurrentScript: jest.fn(() => ({
        id: currentScript.id,
        deploymentId: currentScript.deploymentId,
        logLevel: currentScript.logLevel,
        percentComplete: currentScript.percentComplete,
        getRemainingUsage: currentScript.getRemainingUsage,
        getParameter: jest.fn((options) => null)
    })),

    executionContext: 'USERINTERFACE',

    EnvType: {
        SANDBOX: 'SANDBOX',
        PRODUCTION: 'PRODUCTION',
        BETA: 'BETA',
        INTERNAL: 'INTERNAL'
    },

    ContextType: {
        USER_INTERFACE: 'USERINTERFACE',
        WEBSERVICES: 'WEBSERVICES',
        SCHEDULED: 'SCHEDULED',
        SUITELET: 'SUITELET',
        MAP_REDUCE: 'MAPREDUCE'
    },

    // Test helper functions
    _reset: () => {
        currentUser = {
            id: 1,
            name: 'Test User',
            email: 'test@example.com',
            role: 3,
            roleId: 'administrator',
            department: 1,
            location: 1,
            subsidiary: 1
        };
    },

    _setCurrentUser: (user) => {
        currentUser = { ...currentUser, ...user };
    },

    _setCurrentScript: (script) => {
        currentScript = { ...currentScript, ...script };
    }
};
