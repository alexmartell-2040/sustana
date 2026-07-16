/**
 * Mock for N/search module
 */

const mockSearchResults = {};

const createSearchResult = (id, values = {}) => ({
    id,
    getValue: jest.fn((options) => {
        const column = typeof options === 'string' ? options : options.name;
        return values[column];
    }),
    getText: jest.fn((options) => {
        const column = typeof options === 'string' ? options : options.name;
        return values[`${column}_text`] || values[column];
    })
});

const createResultSet = (results) => ({
    each: jest.fn((callback) => {
        for (const result of results) {
            if (callback(result) === false) break;
        }
    }),
    getRange: jest.fn((options) => {
        const { start = 0, end = results.length } = options;
        return results.slice(start, end);
    })
});

module.exports = {
    Type: {
        INVENTORY_ITEM: 'inventoryitem',
        INVENTORY_NUMBER: 'inventorynumber',
        WORK_ORDER: 'workorder',
        SALES_ORDER: 'salesorder',
        EMPLOYEE: 'employee',
        LOCATION: 'location',
        CUSTOM_RECORD: 'customrecord'
    },

    Sort: {
        ASC: 'ASC',
        DESC: 'DESC'
    },

    Operator: {
        ANYOF: 'anyof',
        IS: 'is',
        STARTSWITH: 'startswith',
        CONTAINS: 'contains'
    },

    create: jest.fn((options) => {
        const searchKey = options.type;
        const stored = mockSearchResults[searchKey];
        // Backward-compatible extension: a stored FUNCTION is called with the
        // search options (type/filters/columns) and must return a results array.
        // Lets tests return different results per-search (e.g. filtered vs not).
        const results = (typeof stored === 'function')
            ? (stored(options) || [])
            : (stored || []);

        return {
            type: options.type,
            filters: options.filters || [],
            columns: options.columns || [],
            run: jest.fn(() => createResultSet(results.map(r => createSearchResult(r.id, r.values))))
        };
    }),

    createColumn: jest.fn((options) => ({
        name: options.name,
        sort: options.sort,
        join: options.join
    })),

    createFilter: jest.fn((options) => ({
        name: options.name,
        operator: options.operator,
        values: options.values
    })),

    lookupFields: jest.fn((options) => {
        const key = `${options.type}_${options.id}`;
        return mockSearchResults[key] || {};
    }),

    load: jest.fn((options) => {
        return module.exports.create({ type: options.type, id: options.id });
    }),

    // Test helper functions
    _reset: () => {
        Object.keys(mockSearchResults).forEach(key => delete mockSearchResults[key]);
    },

    /**
     * Seed results for a search type. `results` may be:
     *  - an array of { id, values } objects (original behavior), or
     *  - a function (searchOptions) => array, for per-search resolution.
     */
    _setSearchResults: (type, results) => {
        mockSearchResults[type] = results;
    },

    _setLookupResult: (type, id, values) => {
        mockSearchResults[`${type}_${id}`] = values;
    },

    _createSearchResult: createSearchResult
};
