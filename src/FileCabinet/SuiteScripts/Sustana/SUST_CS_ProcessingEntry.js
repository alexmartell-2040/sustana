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

        const MAT_SUBLIST = 'custpage_material_lines';

        /** Sum grid weights (tons) for one direction ('input'|'output'). */
        const sumDirection = (record, direction) => {
            const lineCount = record.getLineCount({ sublistId: MAT_SUBLIST });
            let total = 0;
            for (let i = 0; i < lineCount; i++) {
                const dir = record.getSublistValue({ sublistId: MAT_SUBLIST, fieldId: 'custpage_mat_direction', line: i });
                if (dir !== direction) continue;
                total += parseFloat(record.getSublistValue({ sublistId: MAT_SUBLIST, fieldId: 'custpage_mat_weight', line: i })) || 0;
            }
            return total;
        };

        /** First grid row matching a direction, or null. */
        const firstDirectionValue = (record, direction, fieldId) => {
            const lineCount = record.getLineCount({ sublistId: MAT_SUBLIST });
            for (let i = 0; i < lineCount; i++) {
                const dir = record.getSublistValue({ sublistId: MAT_SUBLIST, fieldId: 'custpage_mat_direction', line: i });
                if (dir === direction) {
                    return record.getSublistValue({ sublistId: MAT_SUBLIST, fieldId: fieldId, line: i });
                }
            }
            return null;
        };

        /**
         * Field changed event handler
         * @param {Object} context
         */
        const fieldChanged = (context) => {
            const record = context.currentRecord;
            const fieldId = context.fieldId;

            try {
                if (fieldId === 'custpage_mat_weight' || fieldId === 'custpage_mat_direction') {
                    // % recomputed on commit via sublistChanged; nothing per-keystroke
                    log.debug('fieldChanged', 'Materials grid edit');
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
                if (sublistId === MAT_SUBLIST) {
                    // Recalculate every row's % of total input when the grid changes
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
                // The Materials grid needs at least one Input and one Output row.
                const inputWeight = sumDirection(record, 'input');
                const totalOutputWeight = sumDirection(record, 'output');

                if (inputWeight <= 0) {
                    dialog.alert({
                        title: 'Validation Error',
                        message: 'Add at least one Input row (Direction = Input) to the Materials grid.'
                    });
                    return false;
                }
                if (totalOutputWeight <= 0) {
                    dialog.alert({
                        title: 'Validation Error',
                        message: 'Add at least one Output row (Direction = Output) to the Materials grid.'
                    });
                    return false;
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
            // Primary input = first Input row on the Materials grid (header fallback)
            const inputItem = firstDirectionValue(record, 'input', 'custpage_mat_item')
                || record.getValue({ fieldId: 'custpage_input_item' });

            if (!inputItem) {
                dialog.alert({
                    title: 'Missing Input',
                    message: 'Add an Input row to the Materials grid first (Direction = Input, item, lot, weight).'
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

                // Clear existing OUTPUT rows only (inputs stay)
                clearOutputLines();

                // Template %s apply to TOTAL input tons across all Input rows
                const inputWeight = sumDirection(record, 'input');

                results.forEach((template) => {
                    record.selectNewLine({ sublistId: MAT_SUBLIST });
                    record.setCurrentSublistValue({ sublistId: MAT_SUBLIST, fieldId: 'custpage_mat_direction', value: 'output' });
                    record.setCurrentSublistValue({ sublistId: MAT_SUBLIST, fieldId: 'custpage_mat_item', value: template.outputItem });
                    if (template.outputType) {
                        record.setCurrentSublistValue({ sublistId: MAT_SUBLIST, fieldId: 'custpage_mat_type', value: template.outputType });
                    }
                    // Weight from % — TONS in, TONS out (POST converts to lbs)
                    const outWeight = inputWeight * (template.defaultPct / 100);
                    record.setCurrentSublistValue({ sublistId: MAT_SUBLIST, fieldId: 'custpage_mat_weight', value: outWeight.toFixed(4) });
                    record.setCurrentSublistValue({ sublistId: MAT_SUBLIST, fieldId: 'custpage_mat_pct', value: template.defaultPct });
                    if (template.disposition) {
                        record.setCurrentSublistValue({ sublistId: MAT_SUBLIST, fieldId: 'custpage_mat_disposition', value: template.disposition });
                    }
                    record.commitLine({ sublistId: MAT_SUBLIST });
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
            const lineCount = record.getLineCount({ sublistId: MAT_SUBLIST });

            for (let i = lineCount - 1; i >= 0; i--) {
                const dir = record.getSublistValue({ sublistId: MAT_SUBLIST, fieldId: 'custpage_mat_direction', line: i });
                if (dir === 'output') {
                    record.removeLine({ sublistId: MAT_SUBLIST, line: i });
                }
            }

            log.debug('clearOutputLines', 'Cleared output rows (input rows kept)');
        };

        /**
         * Recalculate output percentages based on input weight
         * (ton ÷ ton ratio — unit-agnostic)
         * @param {Record} record
         */
        const recalculateOutputPercentages = (record) => {
            const inputWeight = sumDirection(record, 'input');
            if (inputWeight <= 0) return;

            const lineCount = record.getLineCount({ sublistId: MAT_SUBLIST });
            for (let i = 0; i < lineCount; i++) {
                const w = parseFloat(record.getSublistValue({
                    sublistId: MAT_SUBLIST, fieldId: 'custpage_mat_weight', line: i
                })) || 0;
                record.setSublistValue({
                    sublistId: MAT_SUBLIST,
                    fieldId: 'custpage_mat_pct',
                    line: i,
                    value: ((w / inputWeight) * 100).toFixed(2)
                });
            }
            log.debug('recalculateOutputPercentages', 'Recalculated grid percentages');
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
