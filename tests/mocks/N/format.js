/**
 * Mock for N/format module
 */

module.exports = {
    Type: {
        DATE: 'date',
        DATETIME: 'datetime',
        DATETIMETZ: 'datetimetz',
        TIME: 'time',
        TIMEOFDAY: 'timeofday',
        TIMETRACK: 'timetrack',
        INTEGER: 'integer',
        POSINTEGER: 'posinteger',
        NONNEGINT: 'nonnegint',
        FLOAT: 'float',
        POSFLOAT: 'posfloat',
        NONNEGFLOAT: 'nonnegfloat',
        PCTCOMPLETE: 'pctcomplete',
        PERCENT: 'percent',
        RATEHIGHPRECISION: 'ratehighprecision',
        RATE: 'rate',
        CURRENCY: 'currency',
        CURRENCY2: 'currency2',
        CHECKBOX: 'checkbox',
        CCNUMBER: 'ccnumber',
        PHONE: 'phone',
        FULLPHONE: 'fullphone',
        URL: 'url',
        EMAIL: 'email',
        IDENTIFIER: 'identifier',
        FUNCTION: 'function',
        QUOTEDFUNCTION: 'quotedfunction',
        MMYYDATE: 'mmyydate',
        CCEXPDATE: 'ccexpdate',
        CCVALIDFROM: 'ccvalidfrom'
    },

    format: jest.fn((options) => {
        const { value, type } = options;
        if (type === 'date' && value instanceof Date) {
            return value.toLocaleDateString();
        }
        if (type === 'datetime' && value instanceof Date) {
            return value.toLocaleString();
        }
        return String(value);
    }),

    parse: jest.fn((options) => {
        const { value, type } = options;
        if (type === 'date' && typeof value === 'string') {
            return new Date(value);
        }
        if (type === 'integer') {
            return parseInt(value, 10);
        }
        if (type === 'float') {
            return parseFloat(value);
        }
        return value;
    })
};
