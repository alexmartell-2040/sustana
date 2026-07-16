/**
 * Mock for N/https module
 */

const mockResponses = {};

module.exports = {
    get: jest.fn((options) => {
        const response = mockResponses[options.url] || { code: 200, body: '{}' };
        return {
            code: response.code,
            body: response.body,
            headers: response.headers || {}
        };
    }),

    post: jest.fn((options) => {
        const response = mockResponses[options.url] || { code: 200, body: '{}' };
        return {
            code: response.code,
            body: response.body,
            headers: response.headers || {}
        };
    }),

    put: jest.fn((options) => {
        const response = mockResponses[options.url] || { code: 200, body: '{}' };
        return {
            code: response.code,
            body: response.body,
            headers: response.headers || {}
        };
    }),

    delete: jest.fn((options) => {
        const response = mockResponses[options.url] || { code: 200, body: '{}' };
        return {
            code: response.code,
            body: response.body,
            headers: response.headers || {}
        };
    }),

    request: jest.fn((options) => {
        const response = mockResponses[options.url] || { code: 200, body: '{}' };
        return {
            code: response.code,
            body: response.body,
            headers: response.headers || {}
        };
    }),

    Method: {
        GET: 'GET',
        POST: 'POST',
        PUT: 'PUT',
        DELETE: 'DELETE',
        HEAD: 'HEAD'
    },

    // Test helper functions
    _reset: () => {
        Object.keys(mockResponses).forEach(key => delete mockResponses[key]);
    },

    _setMockResponse: (url, response) => {
        mockResponses[url] = response;
    }
};
