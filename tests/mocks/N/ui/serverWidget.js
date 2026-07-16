/**
 * Mock for N/ui/serverWidget module
 */

const createMockField = (options) => ({
    id: options.id,
    type: options.type,
    label: options.label,
    source: options.source,
    container: options.container,
    isMandatory: false,
    defaultValue: null,
    updateDisplayType: jest.fn(),
    addSelectOption: jest.fn(),
    setHelpText: jest.fn()
});

const createMockSublist = (options) => ({
    id: options.id,
    type: options.type,
    label: options.label,
    addField: jest.fn((fieldOptions) => createMockField(fieldOptions)),
    setSublistValue: jest.fn(),
    getSublistValue: jest.fn()
});

const createMockFieldGroup = (options) => ({
    id: options.id,
    label: options.label,
    isBorderHidden: false,
    isCollapsible: false,
    isCollapsed: false
});

const createMockForm = () => {
    const fields = {};
    const sublists = {};
    const fieldGroups = {};
    const buttons = [];

    return {
        title: '',
        clientScriptModulePath: null,

        addField: jest.fn((options) => {
            const field = createMockField(options);
            fields[options.id] = field;
            return field;
        }),

        getField: jest.fn((options) => {
            const id = typeof options === 'string' ? options : options.id;
            return fields[id];
        }),

        addSublist: jest.fn((options) => {
            const sublist = createMockSublist(options);
            sublists[options.id] = sublist;
            return sublist;
        }),

        getSublist: jest.fn((options) => {
            const id = typeof options === 'string' ? options : options.id;
            return sublists[id];
        }),

        addFieldGroup: jest.fn((options) => {
            const group = createMockFieldGroup(options);
            fieldGroups[options.id] = group;
            return group;
        }),

        addSubmitButton: jest.fn((options) => {
            buttons.push({ type: 'submit', ...options });
        }),

        addButton: jest.fn((options) => {
            buttons.push({ type: 'button', ...options });
        }),

        addResetButton: jest.fn((options) => {
            buttons.push({ type: 'reset', ...options });
        }),

        _fields: fields,
        _sublists: sublists,
        _fieldGroups: fieldGroups,
        _buttons: buttons
    };
};

module.exports = {
    FieldType: {
        TEXT: 'TEXT',
        TEXTAREA: 'TEXTAREA',
        LONGTEXT: 'LONGTEXT',
        EMAIL: 'EMAIL',
        URL: 'URL',
        PHONE: 'PHONE',
        INTEGER: 'INTEGER',
        FLOAT: 'FLOAT',
        CURRENCY: 'CURRENCY',
        PERCENT: 'PERCENT',
        CHECKBOX: 'CHECKBOX',
        DATE: 'DATE',
        DATETIME: 'DATETIME',
        DATETIMETZ: 'DATETIMETZ',
        TIMEOFDAY: 'TIMEOFDAY',
        SELECT: 'SELECT',
        MULTISELECT: 'MULTISELECT',
        INLINEHTML: 'INLINEHTML',
        RICHTEXT: 'RICHTEXT',
        PASSWORD: 'PASSWORD',
        HELP: 'HELP',
        LABEL: 'LABEL',
        FILE: 'FILE',
        RADIO: 'RADIO',
        IMAGE: 'IMAGE'
    },

    FieldDisplayType: {
        NORMAL: 'NORMAL',
        HIDDEN: 'HIDDEN',
        READONLY: 'READONLY',
        DISABLED: 'DISABLED',
        ENTRY: 'ENTRY',
        INLINE: 'INLINE'
    },

    SublistType: {
        INLINEEDITOR: 'INLINEEDITOR',
        EDITOR: 'EDITOR',
        LIST: 'LIST',
        STATICLIST: 'STATICLIST'
    },

    FieldLayoutType: {
        NORMAL: 'NORMAL',
        STARTROW: 'STARTROW',
        MIDROW: 'MIDROW',
        ENDROW: 'ENDROW',
        OUTSIDE: 'OUTSIDE',
        OUTSIDEBELOW: 'OUTSIDEBELOW',
        OUTSIDEABOVE: 'OUTSIDEABOVE'
    },

    FieldBreakType: {
        NONE: 'NONE',
        STARTCOL: 'STARTCOL',
        STARTROW: 'STARTROW'
    },

    createForm: jest.fn((options) => {
        const form = createMockForm();
        form.title = options.title;
        return form;
    }),

    _createMockForm: createMockForm,
    _createMockField: createMockField
};
