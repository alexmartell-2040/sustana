/**
 * Mock for N/url module
 */

module.exports = {
    resolveRecord: jest.fn((options) => {
        return `/app/common/custom/custrecord.nl?rectype=${options.recordType}&id=${options.recordId}`;
    }),

    resolveScript: jest.fn((options) => {
        return `/app/site/hosting/scriptlet.nl?script=${options.scriptId}&deploy=${options.deploymentId}`;
    }),

    resolveTaskLink: jest.fn((options) => {
        return `/app/center/card.nl?tasktype=${options.id}`;
    }),

    resolveDomain: jest.fn((options) => {
        return `https://account.netsuite.com`;
    }),

    format: jest.fn((options) => {
        let url = options.domain || '';
        if (options.params) {
            const params = Object.entries(options.params)
                .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
                .join('&');
            url += `?${params}`;
        }
        return url;
    })
};
