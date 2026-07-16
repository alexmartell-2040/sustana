/**
 * Mock for N/render module
 */

module.exports = {
    xmlToPdf: jest.fn((options) => {
        return {
            name: 'rendered.pdf',
            getContents: jest.fn(() => 'mock-pdf-contents'),
            getValue: jest.fn(() => 'mock-pdf-value')
        };
    }),

    create: jest.fn(() => ({
        setTemplateByScriptId: jest.fn(),
        setTemplateById: jest.fn(),
        addRecord: jest.fn(),
        addSearchResults: jest.fn(),
        addCustomDataSource: jest.fn(),
        renderAsPdf: jest.fn(() => ({
            name: 'rendered.pdf',
            getContents: jest.fn(() => 'mock-pdf-contents')
        })),
        renderAsString: jest.fn(() => '<html>rendered</html>')
    })),

    _reset: () => {
        // No state to reset
    }
};
