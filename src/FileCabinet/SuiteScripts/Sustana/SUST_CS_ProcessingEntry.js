/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 * @description Client script for Processing Entry Suitelet - handles dynamic interactions
 */
define(['N/currentRecord', 'N/search', 'N/ui/dialog', 'N/log', 'N/ui/message'],
    (currentRecord, search, dialog, log, message) => {

        // UNITS: all quantity fields on this form are TONS. The client script works
        // on the form's ton values directly (ratios and comparisons are unit-agnostic);
        // the Suitelet POST handler converts to POUNDS before any record write.

        /**
         * Page initialization
         * @param {Object} context
         */
        const pageInit = (context) => {
            log.debug('pageInit', 'Processing Entry form loaded');
        };

        /**
         * Field changed event handler
         * @param {Object} context
         */
        const fieldChanged = (context) => {
            const record = context.currentRecord;
            const fieldId = context.fieldId;

            try {
                if (fieldId === 'custpage_input_item') {
                    // When input item changes, could trigger default output loading
                    log.debug('fieldChanged', 'Input item changed');
                } else if (fieldId === 'custpage_input_weight') {
                    // Recalculate output percentages
                    recalculateOutputPercentages(record);
                }
            } catch (e) {
                log.error('fieldChanged', {
                    error: e.message,
                    fieldId: fieldId
                });
            }
        };

        /**
         * Sublist line changed event handler
         * @param {Object} context
         */
        const sublistChanged = (context) => {
            const record = context.currentRecord;
            const sublistId = context.sublistId;

            try {
                if (sublistId === 'custpage_output_lines') {
                    // Recalculate percentages when output weights change
                    recalculateOutputPercentages(record);
                }
            } catch (e) {
                log.error('sublistChanged', {
                    error: e.message,
                    sublistId: sublistId
                });
            }
        };

        /**
         * Validate form submission
         * @param {Object} context
         * @returns {boolean}
         */
        const saveRecord = (context) => {
            const record = context.currentRecord;

            try {
                // Validate that we have at least one output line
                const lineCount = record.getLineCount({ sublistId: 'custpage_output_lines' });
                if (lineCount === 0) {
                    dialog.alert({
                        title: 'Validation Error',
                        message: 'At least one output line is required.'
                    });
                    return false;
                }

                // Validate that total output weight doesn't exceed input weight.
                // Both values are the form's TON entries — the comparison is unit-agnostic.
                const inputWeight = parseFloat(record.getValue({ fieldId: 'custpage_input_weight' })) || 0;
                let totalOutputWeight = 0;

                for (let i = 0; i < lineCount; i++) {
                    const outWeight = parseFloat(record.getSublistValue({
                        sublistId: 'custpage_output_lines',
                        fieldId: 'custpage_out_weight',
                        line: i
                    })) || 0;
                    totalOutputWeight += outWeight;
                }

                if (totalOutputWeight > inputWeight) {
                    dialog.alert({
                        title: 'Validation Error',
                        message: `Total output weight (${totalOutputWeight.toFixed(2)} tons) exceeds input weight (${inputWeight.toFixed(2)} tons).`
                    });
                    return false;
                }

                return true;
            } catch (e) {
                log.error('saveRecord', {
                    error: e.message,
                    stack: e.stack
                });
                return false;
            }
        };

        /**
         * Load default output items from item_output_template
         */
        const loadDefaultOutputs = () => {
            const record = currentRecord.get();
            const inputItem = record.getValue({ fieldId: 'custpage_input_item' });

            if (!inputItem) {
                dialog.alert({
                    title: 'Missing Input Item',
                    message: 'Please select an input item first.'
                });
                return;
            }

            try {
                // Search for default output templates for this input item
                const templateSearch = search.create({
                    type: 'customrecord_sust_item_output_template',
                    filters: [
                        ['custrecord_sust_template_input_item', 'anyof', inputItem],
                        'AND',
                        ['custrecord_sust_template_active', 'is', 'T']
                    ],
                    columns: [
                        'custrecord_sust_template_sequence',
                        'custrecord_sust_template_output_item',
                        'custrecord_sust_template_output_type',
                        'custrecord_sust_template_default_pct',
                        'custrecord_sust_template_disposition'
                    ]
                });

                const results = [];
                templateSearch.run().each(result => {
                    results.push({
                        sequence: result.getValue('custrecord_sust_template_sequence') || 0,
                        outputItem: result.getValue('custrecord_sust_template_output_item'),
                        outputItemText: result.getText('custrecord_sust_template_output_item'),
                        outputType: result.getValue('custrecord_sust_template_output_type'),
                        outputTypeText: result.getText('custrecord_sust_template_output_type'),
                        defaultPct: parseFloat(result.getValue('custrecord_sust_template_default_pct')) || 0,
                        disposition: result.getValue('custrecord_sust_template_disposition')
                    });
                    return true;
                });

                if (results.length === 0) {
                    dialog.alert({
                        title: 'No Templates Found',
                        message: 'No default output templates found for this input item. Add lines manually or configure templates in Item Output Template records.'
                    });
                    return;
                }

                // Sort by sequence
                results.sort((a, b) => a.sequence - b.sequence);

                // Clear existing lines
                clearOutputLines();

                // Add template lines
                const inputWeight = parseFloat(record.getValue({ fieldId: 'custpage_input_weight' })) || 0;

                results.forEach((template, index) => {
                    record.selectNewLine({ sublistId: 'custpage_output_lines' });

                    record.setCurrentSublistValue({
                        sublistId: 'custpage_output_lines',
                        fieldId: 'custpage_line_num',
                        value: index + 1
                    });

                    record.setCurrentSublistValue({
                        sublistId: 'custpage_output_lines',
                        fieldId: 'custpage_out_item',
                        value: template.outputItem
                    });

                    record.setCurrentSublistValue({
                        sublistId: 'custpage_output_lines',
                        fieldId: 'custpage_out_type',
                        value: template.outputType
                    });

                    // Calculate weight from percentage — inputWeight is TONS, so this
                    // stays in TONS (4 decimals ≈ 0.2 lb; POST converts to lbs)
                    const outWeight = inputWeight * (template.defaultPct / 100);
                    record.setCurrentSublistValue({
                        sublistId: 'custpage_output_lines',
                        fieldId: 'custpage_out_weight',
                        value: outWeight.toFixed(4)
                    });

                    record.setCurrentSublistValue({
                        sublistId: 'custpage_output_lines',
                        fieldId: 'custpage_out_pct',
                        value: template.defaultPct
                    });

                    if (template.disposition) {
                        record.setCurrentSublistValue({
                            sublistId: 'custpage_output_lines',
                            fieldId: 'custpage_disposition',
                            value: template.disposition
                        });
                    }

                    record.commitLine({ sublistId: 'custpage_output_lines' });
                });

                // Show success message
                const msg = message.create({
                    title: 'Default Outputs Loaded',
                    message: `Loaded ${results.length} default output lines from templates.`,
                    type: message.Type.CONFIRMATION
                });
                msg.show({ duration: 3000 });

                log.audit('loadDefaultOutputs', `Loaded ${results.length} template lines`);
            } catch (e) {
                log.error('loadDefaultOutputs', {
                    error: e.message,
                    stack: e.stack
                });
                dialog.alert({
                    title: 'Error',
                    message: 'Error loading default outputs: ' + e.message
                });
            }
        };

        /**
         * Clear all output lines
         */
        const clearOutputLines = () => {
            const record = currentRecord.get();
            const lineCount = record.getLineCount({ sublistId: 'custpage_output_lines' });

            for (let i = lineCount - 1; i >= 0; i--) {
                record.removeLine({
                    sublistId: 'custpage_output_lines',
                    line: i
                });
            }

            log.debug('clearOutputLines', 'Cleared all output lines');
        };

        /**
         * Recalculate output percentages based on input weight
         * (ton ÷ ton ratio — unit-agnostic)
         * @param {Record} record
         */
        const recalculateOutputPercentages = (record) => {
            const inputWeight = parseFloat(record.getValue({ fieldId: 'custpage_input_weight' })) || 0;

            if (inputWeight <= 0) {
                return;
            }

            const lineCount = record.getLineCount({ sublistId: 'custpage_output_lines' });

            for (let i = 0; i < lineCount; i++) {
                const outWeight = parseFloat(record.getSublistValue({
                    sublistId: 'custpage_output_lines',
                    fieldId: 'custpage_out_weight',
                    line: i
                })) || 0;

                const outPct = (outWeight / inputWeight) * 100;

                record.setSublistValue({
                    sublistId: 'custpage_output_lines',
                    fieldId: 'custpage_out_pct',
                    line: i,
                    value: outPct.toFixed(2)
                });
            }

            log.debug('recalculateOutputPercentages', 'Recalculated output percentages');
        };

        return {
            pageInit: pageInit,
            fieldChanged: fieldChanged,
            sublistChanged: sublistChanged,
            saveRecord: saveRecord,
            loadDefaultOutputs: loadDefaultOutputs,
            clearOutputLines: clearOutputLines
        };
    });
