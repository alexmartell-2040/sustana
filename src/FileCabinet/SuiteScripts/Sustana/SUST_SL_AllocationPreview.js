/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */

/**
 * SUST_SL_AllocationPreview.js
 *
 * Multi-receiver settlement allocation preview (Sustana Recovery).
 *
 * SETTLE-013 — when a processing run consumed multiple receivers (multi-source
 * batching), the recovered fiber must be proportionally allocated back to
 * each contributing receiver for per-PO settlement.
 *
 * This Suitelet takes a processing record ID and displays:
 *   - All input lines (receivers) feeding the processing run
 *   - Each receiver's weight contribution + % share
 *   - The run's total recovered fiber weight
 *   - Per-receiver allocated recovered weight + value (using the run's total
 *     input cost as basis)
 *
 * Allocation rule is weight-proportional — the Sustana default allocation
 * mode. Weights are stored and computed in lbs; tons are display-only.
 *
 * Operator uses this table as reference when creating per-PO settlements
 * (typically one per source receiver/PO).
 *
 * Future enhancement: button to auto-create N settlements from the preview.
 *
 * Author: Sustana Dev Team
 * Date: July 2026
 */

define(['N/record', 'N/search', 'N/ui/serverWidget', 'N/log', './SUST_Lib_Units'],
    function(record, search, serverWidget, log, units) {

        function onRequest(context) {
            try {
                if (context.request.method === 'GET') {
                    renderPreview(context);
                } else {
                    context.response.write({ output: 'POST not supported.' });
                }
            } catch (e) {
                log.error('SUST_SL_AllocationPreview failed', `${e.message}\n${e.stack}`);
                context.response.write({
                    output: '<h2 style="color:#dc2626;">Error</h2><pre>' +
                            String(e.message).replace(/[<>]/g, '') + '</pre>'
                });
            }
        }

        function renderPreview(context) {
            const procId = context.request.parameters.proc;

            const form = serverWidget.createForm({
                title: 'Sustana Recovery — Multi-Receiver Allocation Preview'
            });

            // Help banner
            const banner = form.addField({
                id: 'custpage_help',
                type: serverWidget.FieldType.INLINEHTML,
                label: ' '
            });
            banner.defaultValue =
                '<div style="border: 2px solid #2563eb; background: #dbeafe; color: #1e3a8a;' +
                ' padding: 12px 16px; margin: 8px 0; border-radius: 6px; font-family: Arial, sans-serif;">' +
                '  <div style="font-weight: bold; font-size: 14px; margin-bottom: 6px;">Multi-Receiver Allocation Preview</div>' +
                '  <div style="font-size: 13px;">' +
                '    Reference table for splitting a processing run\'s recovered fiber back across multiple source receivers (multi-source batching, ~1% of receipts). ' +
                '    Create one settlement per receiver — each gets the proportional weight + value shown below. ' +
                '    Single-receiver runs (~99%) settle normally without this tool.' +
                '  </div>' +
                '</div>';

            // Processing record selector
            const procField = form.addField({
                id: 'custpage_proc',
                type: serverWidget.FieldType.SELECT,
                label: 'Processing Record',
                source: 'customrecord_sust_processing_record'
            });
            if (procId) procField.defaultValue = procId;

            form.addSubmitButton({ label: 'Refresh Preview' });
            form.clientScriptModulePath = ''; // none — pure server

            if (!procId) {
                const noProc = form.addField({
                    id: 'custpage_no_proc',
                    type: serverWidget.FieldType.INLINEHTML,
                    label: ' '
                });
                noProc.defaultValue =
                    '<div style="padding: 20px; color: #6b7280; font-style: italic;">' +
                    'Select a processing record and click Refresh Preview.' +
                    '</div>';
                context.response.writePage(form);
                return;
            }

            // Load processing record + input lines
            const procData = loadProcessing(procId);
            if (!procData) {
                const noData = form.addField({
                    id: 'custpage_no_data',
                    type: serverWidget.FieldType.INLINEHTML,
                    label: ' '
                });
                noData.defaultValue =
                    '<div style="padding: 20px; color: #dc2626;">Could not load processing record ' + procId + '</div>';
                context.response.writePage(form);
                return;
            }

            // Header summary
            const headerSummary = form.addField({
                id: 'custpage_summary',
                type: serverWidget.FieldType.INLINEHTML,
                label: 'Processing Run Summary'
            });
            headerSummary.defaultValue = renderHeaderSummary(procData);

            // Allocation table
            const allocationTable = form.addField({
                id: 'custpage_allocation',
                type: serverWidget.FieldType.INLINEHTML,
                label: 'Per-Receiver Allocation'
            });
            allocationTable.defaultValue = renderAllocationTable(procData);

            context.response.writePage(form);
        }

        // ───────────────────────────────────────────────────────────────────────
        // Data loading
        // ───────────────────────────────────────────────────────────────────────

        function loadProcessing(procId) {
            try {
                const lookup = search.lookupFields({
                    type: 'customrecord_sust_processing_record',
                    id: procId,
                    columns: [
                        'name',
                        'custrecord_sust_processing_input_lbs',
                        'custrecord_sust_proc_true_net_lbs',
                        'custrecord_sust_proc_total_output_lbs',
                        'custrecord_sust_proc_total_input_cost',
                        'custrecord_sust_proc_mass_balance_pct'
                    ]
                });

                // Try to load input lines (multi-receiver support)
                const inputLines = loadInputLines(procId);

                // If no multi-receiver input lines, treat the single primary input as the only line
                if (inputLines.length === 0) {
                    const primaryLot = search.lookupFields({
                        type: 'customrecord_sust_processing_record',
                        id: procId,
                        columns: ['custrecord_sust_processing_input_lot']
                    });
                    const lotArr = primaryLot.custrecord_sust_processing_input_lot;
                    const lotId = (Array.isArray(lotArr) && lotArr.length) ? lotArr[0].value : null;
                    const lotName = (Array.isArray(lotArr) && lotArr.length) ? lotArr[0].text : 'Primary lot';
                    inputLines.push({
                        id: null,
                        lotId: lotId,
                        lotName: lotName || 'Primary lot',
                        qty: parseFloat(lookup.custrecord_sust_processing_input_lbs) || 0,
                        weightPct: 100,
                        inputCost: parseFloat(lookup.custrecord_sust_proc_total_input_cost) || 0,
                        itemReceipt: null
                    });
                }

                // Output lines for total recovered fiber weight
                const outputLines = loadOutputLines(procId);

                return {
                    id: procId,
                    name: lookup.name,
                    inputLines: inputLines,
                    outputLines: outputLines,
                    trueNet: parseFloat(lookup.custrecord_sust_proc_true_net_lbs) || 0,
                    totalOutput: parseFloat(lookup.custrecord_sust_proc_total_output_lbs) || 0,
                    totalInputCost: parseFloat(lookup.custrecord_sust_proc_total_input_cost) || 0,
                    massBalancePct: parseFloat(lookup.custrecord_sust_proc_mass_balance_pct) || 0
                };
            } catch (e) {
                log.error('loadProcessing failed', `${procId}: ${e.message}`);
                return null;
            }
        }

        function loadInputLines(procId) {
            const lines = [];
            try {
                search.create({
                    type: 'customrecord_sust_proc_input_line',
                    filters: [['custrecord_sust_pil_processing', 'anyof', procId]],
                    columns: [
                        'internalid',
                        'custrecord_sust_pil_lot',
                        'custrecord_sust_pil_item_receipt',
                        'custrecord_sust_pil_qty_consumed',
                        'custrecord_sust_pil_weight_pct',
                        'custrecord_sust_pil_input_cost'
                    ]
                }).run().each(function(row) {
                    const lotRef = row.getValue({ name: 'custrecord_sust_pil_lot' });
                    const lotText = row.getText({ name: 'custrecord_sust_pil_lot' });
                    const irRef = row.getValue({ name: 'custrecord_sust_pil_item_receipt' });
                    const irText = row.getText({ name: 'custrecord_sust_pil_item_receipt' });
                    lines.push({
                        id: row.id,
                        lotId: lotRef,
                        lotName: lotText || ('Lot ' + lotRef),
                        itemReceipt: irRef,
                        itemReceiptText: irText,
                        qty: parseFloat(row.getValue({ name: 'custrecord_sust_pil_qty_consumed' })) || 0,
                        weightPct: parseFloat(row.getValue({ name: 'custrecord_sust_pil_weight_pct' })) || 0,
                        inputCost: parseFloat(row.getValue({ name: 'custrecord_sust_pil_input_cost' })) || 0
                    });
                    return true;
                });
            } catch (e) {
                log.error('loadInputLines failed', `${procId}: ${e.message}`);
            }
            return lines;
        }

        function loadOutputLines(procId) {
            const lines = [];
            try {
                search.create({
                    type: 'customrecord_sust_processing_output_line',
                    filters: [['custrecord_sust_output_processing', 'anyof', procId]],
                    columns: [
                        'internalid',
                        'custrecord_sust_output_item',
                        'custrecord_sust_output_weight',
                        'custrecord_sust_pol_stream'
                    ]
                }).run().each(function(row) {
                    lines.push({
                        id: row.id,
                        itemText: row.getText({ name: 'custrecord_sust_output_item' }),
                        weight: parseFloat(row.getValue({ name: 'custrecord_sust_output_weight' })) || 0,
                        streamText: row.getText({ name: 'custrecord_sust_pol_stream' })
                    });
                    return true;
                });
            } catch (e) {
                log.error('loadOutputLines failed', `${procId}: ${e.message}`);
            }
            return lines;
        }

        // ───────────────────────────────────────────────────────────────────────
        // Rendering
        // ───────────────────────────────────────────────────────────────────────

        /**
         * Sum the recovered-fiber output weight (lbs). Fiber-stream lines (or
         * lines with no stream set) count as recovered; if no line qualifies,
         * fall back to total output so the preview stays usable.
         */
        function sumRecoveredFiberLbs(outputLines) {
            let fiberSum = 0;
            let total = 0;
            outputLines.forEach(function(ol) {
                total += ol.weight;
                const stream = (ol.streamText || '').toLowerCase();
                if (stream === '' || stream.indexOf('fiber') !== -1) {
                    fiberSum += ol.weight;
                }
            });
            return fiberSum > 0 ? fiberSum : total;
        }

        /** Display helper: "1,200 lb (0.60 tons)" — storage stays in lbs. */
        function lbsWithTons(lbs) {
            return round2(lbs) + ' lb (' + units.formatTons(lbs) + ')';
        }

        function renderHeaderSummary(d) {
            const recoveredFiber = sumRecoveredFiberLbs(d.outputLines);

            return ''
                + '<div style="background: #f9fafb; border: 1px solid #d1d5db; padding: 14px 16px; border-radius: 6px; font-family: Arial, sans-serif; font-size: 13px;">'
                + '  <table style="width: 100%; border-collapse: collapse;">'
                + '    <tr><td style="padding: 4px 8px;"><b>Processing Record:</b></td><td style="padding: 4px 8px;">' + escapeHtml(d.name) + '</td></tr>'
                + '    <tr><td style="padding: 4px 8px;"><b>True Net Input:</b></td><td style="padding: 4px 8px;">' + lbsWithTons(d.trueNet) + '</td></tr>'
                + '    <tr><td style="padding: 4px 8px;"><b>Total Output:</b></td><td style="padding: 4px 8px;">' + lbsWithTons(d.totalOutput) + '</td></tr>'
                + '    <tr><td style="padding: 4px 8px;"><b>Mass Balance:</b></td><td style="padding: 4px 8px;">' + d.massBalancePct + '%</td></tr>'
                + '    <tr><td style="padding: 4px 8px;"><b>Recovered Fiber (sum of fiber-stream outputs):</b></td><td style="padding: 4px 8px;">' + lbsWithTons(recoveredFiber) + '</td></tr>'
                + '    <tr><td style="padding: 4px 8px;"><b>Total Input Cost:</b></td><td style="padding: 4px 8px;">$' + round2(d.totalInputCost) + '</td></tr>'
                + '    <tr><td style="padding: 4px 8px;"><b># Source Receivers:</b></td><td style="padding: 4px 8px;">' + d.inputLines.length + (d.inputLines.length > 1 ? ' — multi-receiver (batched)' : ' — single (standard)') + '</td></tr>'
                + '  </table>'
                + '</div>';
        }

        function renderAllocationTable(d) {
            // Sum recovered fiber (fiber-stream outputs)
            const recoveredFiber = sumRecoveredFiberLbs(d.outputLines);

            // Compute uniform (weight-proportional) allocation
            const totalInputWeight = d.inputLines.reduce(function(sum, ip) { return sum + ip.qty; }, 0);
            const totalInputCost = d.totalInputCost;

            let rows = '';
            d.inputLines.forEach(function(ip, idx) {
                const pct = totalInputWeight > 0 ? (ip.qty / totalInputWeight) * 100 : 0;
                const allocatedRecovered = round2(recoveredFiber * (pct / 100));
                const allocatedCost = round2(totalInputCost * (pct / 100));
                rows += ''
                    + '<tr>'
                    + '  <td style="padding: 6px 10px; border-bottom: 1px solid #e5e7eb;">' + (idx + 1) + '</td>'
                    + '  <td style="padding: 6px 10px; border-bottom: 1px solid #e5e7eb;">' + escapeHtml(ip.lotName) + '</td>'
                    + '  <td style="padding: 6px 10px; border-bottom: 1px solid #e5e7eb;">' + (ip.itemReceiptText || (ip.itemReceipt || '<i style="color:#9ca3af">none</i>')) + '</td>'
                    + '  <td style="padding: 6px 10px; border-bottom: 1px solid #e5e7eb; text-align: right;">' + lbsWithTons(ip.qty) + '</td>'
                    + '  <td style="padding: 6px 10px; border-bottom: 1px solid #e5e7eb; text-align: right;">' + round2(pct) + '%</td>'
                    + '  <td style="padding: 6px 10px; border-bottom: 1px solid #e5e7eb; text-align: right; font-weight: bold;">' + lbsWithTons(allocatedRecovered) + '</td>'
                    + '  <td style="padding: 6px 10px; border-bottom: 1px solid #e5e7eb; text-align: right; font-weight: bold;">$' + allocatedCost + '</td>'
                    + '</tr>';
            });

            return ''
                + '<div style="font-family: Arial, sans-serif; font-size: 13px;">'
                + '  <table style="width: 100%; border-collapse: collapse; border: 1px solid #d1d5db;">'
                + '    <thead style="background: #f3f4f6;">'
                + '      <tr>'
                + '        <th style="padding: 8px 10px; text-align: left;">#</th>'
                + '        <th style="padding: 8px 10px; text-align: left;">Source Receiver Lot</th>'
                + '        <th style="padding: 8px 10px; text-align: left;">Item Receipt</th>'
                + '        <th style="padding: 8px 10px; text-align: right;">Input Qty</th>'
                + '        <th style="padding: 8px 10px; text-align: right;">% Share</th>'
                + '        <th style="padding: 8px 10px; text-align: right;">Allocated Recovered</th>'
                + '        <th style="padding: 8px 10px; text-align: right;">Allocated Cost</th>'
                + '      </tr>'
                + '    </thead>'
                + '    <tbody>' + rows + '</tbody>'
                + '  </table>'
                + '  <p style="margin-top: 10px; color: #6b7280; font-size: 12px;">'
                + '    Allocation rule (Weight mode — the Sustana default): each receiver receives a share of recovered fiber and total input cost in proportion to its share of total input weight. Create one settlement per receiver using these allocated values.'
                + '  </p>'
                + '</div>';
        }

        function round2(n) { return Math.round(n * 100) / 100; }

        function escapeHtml(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
        }

        return {
            onRequest: onRequest
        };
    });
