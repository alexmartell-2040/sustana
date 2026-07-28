/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 */

/**
 * SUST_CS_ItemReceiptButtons.js
 *
 * Client script for Item Receipt buttons.
 * Handles "Enter Lot Quality" and "Process Material" button clicks.
 *
 * Author: Sustana Dev Team
 * Date: February 2026
 */

define(['N/currentRecord', 'N/url', 'N/log'],
    function(currentRecord, url, log) {

        const QUALITY_COLS = [
            { id: 'custcol_sust_lot_moisture',      label: 'Moisture %',      step: '0.1' },
            { id: 'custcol_sust_lot_contamination', label: 'Contamination %', step: '0.1' },
            { id: 'custcol_sust_lot_fiber',         label: 'Fiber %',         step: '0.1' },
            { id: 'custcol_sust_lot_bales',         label: 'Bale Count',      step: '1' }
        ];

        /** Are we on an entry form (create/edit) rather than a view page? */
        function isEntryMode(record) {
            if (!record.id) return true;                       // create
            return /[?&]e=T\b/i.test(window.location.search); // edit
        }

        /**
         * In-page grading panel: enter quality per line, Apply writes the
         * values back onto the receipt's quality line columns. Saving the
         * receipt then bridges them to the lots (BridgeVendorLot UE).
         */
        function openQualityPanel(rec) {
            if (document.getElementById('sust-lotq-overlay')) return;
            const lineCount = rec.getLineCount({ sublistId: 'item' });
            if (!lineCount || lineCount < 1) {
                alert('Add at least one item line first.');
                return;
            }

            const rows = [];
            for (let i = 0; i < lineCount; i++) {
                let itemText = '';
                try { itemText = rec.getSublistText({ sublistId: 'item', fieldId: 'item', line: i }) || ''; } catch (e) { /* n/a */ }
                const qty = rec.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i }) || '';
                const existing = {};
                QUALITY_COLS.forEach(function(c) {
                    existing[c.id] = rec.getSublistValue({ sublistId: 'item', fieldId: c.id, line: i });
                });
                rows.push({ line: i, itemText: itemText || ('Line ' + (i + 1)), qty: qty, existing: existing });
            }

            const inp = 'width:90px;padding:5px 7px;border:1px solid #cbd5e1;border-radius:4px;font-size:13px;';
            let body = '';
            rows.forEach(function(r) {
                body += '<tr style="border-top:1px solid #e5e7eb;">'
                    + '<td style="padding:7px 12px;font-weight:600;">' + r.itemText.replace(/</g, '&lt;')
                    + '<div style="color:#94a3b8;font-size:11px;font-weight:normal;">' + r.qty + ' lbs</div></td>'
                    + QUALITY_COLS.map(function(c) {
                        const v = (r.existing[c.id] === null || r.existing[c.id] === undefined) ? '' : r.existing[c.id];
                        return '<td style="padding:7px 8px;"><input type="number" min="0" step="' + c.step + '" style="' + inp + '"'
                            + ' id="lotq_' + r.line + '_' + c.id + '" value="' + v + '"/></td>';
                    }).join('')
                    + '</tr>';
            });

            const overlay = document.createElement('div');
            overlay.id = 'sust-lotq-overlay';
            overlay.setAttribute('style',
                'position:fixed;inset:0;background:rgba(15,23,42,0.45);z-index:9999;display:flex;align-items:center;justify-content:center;');
            overlay.innerHTML =
                '<div style="background:#fff;border-radius:10px;max-width:760px;width:92%;max-height:85vh;overflow:auto;'
                + 'box-shadow:0 20px 50px rgba(0,0,0,0.35);font-family:Arial,sans-serif;">'
                + '<div style="background:#eaf2ff;border-left:5px solid #2976F3;padding:14px 18px;">'
                + '<div style="font-weight:bold;font-size:15px;color:#0d2a52;">Lot Quality — graded at receipt</div>'
                + '<div style="font-size:12px;color:#334155;margin-top:2px;">Enter what the inspector graded. Apply writes the values onto the '
                + 'receipt lines; when you SAVE the receipt they push to the lot records automatically (Received &rarr; Yard, audit note stamped).</div>'
                + '</div>'
                + '<table style="width:100%;border-collapse:collapse;font-size:13px;">'
                + '<tr>' + ['Item'].concat(QUALITY_COLS.map(function(c) { return c.label; })).map(function(h) {
                    return '<th style="text-align:left;padding:8px 12px;font-size:11px;color:#64748b;text-transform:uppercase;">' + h + '</th>';
                }).join('') + '</tr>'
                + body
                + '</table>'
                + '<div style="padding:12px 18px;text-align:right;border-top:1px solid #e5e7eb;">'
                + '<button type="button" id="lotq_cancel" style="padding:8px 16px;margin-right:8px;background:#fff;border:1px solid #cbd5e1;'
                + 'border-radius:4px;cursor:pointer;font-size:13px;">Cancel</button>'
                + '<button type="button" id="lotq_apply" style="padding:8px 18px;background:#2976F3;border:1px solid #1F5FCC;color:#fff;'
                + 'border-radius:4px;cursor:pointer;font-weight:600;font-size:13px;">Apply to Receipt</button>'
                + '</div></div>';
            document.body.appendChild(overlay);

            document.getElementById('lotq_cancel').onclick = function() { overlay.remove(); };
            document.getElementById('lotq_apply').onclick = function() {
                let applied = 0;
                try {
                    rows.forEach(function(r) {
                        let touched = false;
                        const vals = {};
                        QUALITY_COLS.forEach(function(c) {
                            const el = document.getElementById('lotq_' + r.line + '_' + c.id);
                            if (el && el.value !== '') { vals[c.id] = parseFloat(el.value); touched = true; }
                        });
                        if (!touched) return;
                        rec.selectLine({ sublistId: 'item', line: r.line });
                        Object.keys(vals).forEach(function(fid) {
                            rec.setCurrentSublistValue({ sublistId: 'item', fieldId: fid, value: vals[fid] });
                        });
                        rec.commitLine({ sublistId: 'item' });
                        applied++;
                    });
                    overlay.remove();
                    alert('Quality applied to ' + applied + ' line(s). Save the receipt to push it to the lot record(s).');
                } catch (e) {
                    log.error('openQualityPanel apply', e.toString());
                    alert('Could not write to the receipt lines: ' + e.message);
                }
            };
        }

        /**
         * Page initialization
         */
        function pageInit(context) {
            log.debug('pageInit', 'Item Receipt buttons client script loaded');
        }

        /**
         * Unsaved receipt: the target pages need the saved receipt's lots.
         * Offer to save now; the buttons reappear on the saved record.
         * @returns {boolean} true when the record is saved and has an id
         */
        function ensureSaved(record, label) {
            if (record.id) return true;
            if (confirm(label + ' needs the receipt saved first (the lots are created at save).\n\nSave the receipt now? Then click ' + label + ' again on the saved receipt.')) {
                try {
                    const btn = document.getElementById('btn_multibutton_submitter')
                        || document.querySelector('input[id^="btn_multibutton"]');
                    if (btn) { btn.click(); return false; }
                    if (document.forms.main_form) { document.forms.main_form.submit(); return false; }
                } catch (e) { /* fall through */ }
                alert('Could not trigger the save automatically — click Save, then use the button on the saved receipt.');
            }
            return false;
        }

        /**
         * Open Lot Quality & Grade Entry Suitelet
         */
        function openLotQuality() {
            try {
                const record = currentRecord.get();

                // CREATE/EDIT: grade in-page — values write back onto the
                // receipt lines and flow to the lots on save. VIEW: the full
                // Lot Quality page (regrade audit path) as before.
                if (isEntryMode(record)) {
                    openQualityPanel(record);
                    return;
                }
                const itemReceiptId = record.id;

                const suiteletUrl = url.resolveScript({
                    scriptId: 'customscript_sust_sl_lotquality',
                    deploymentId: 'customdeploy_sust_sl_lotquality',
                    params: {
                        itemreceiptid: itemReceiptId
                    }
                });

                window.open(suiteletUrl, '_blank');
            } catch (e) {
                log.error('openLotQuality', e.toString());
                alert('Error opening Lot Quality form: ' + e.message);
            }
        }

        /**
         * Open Processing Entry Suitelet pre-populated from Item Receipt
         */
        function openProcessScrap() {
            try {
                const record = currentRecord.get();
                if (!ensureSaved(record, 'Process Material')) return;
                const itemReceiptId = record.id;

                const suiteletUrl = url.resolveScript({
                    scriptId: 'customscript_sust_sl_processingentry',
                    deploymentId: 'customdeploy_sust_sl_processingentry',
                    params: {
                        itemreceiptid: itemReceiptId
                    }
                });

                window.open(suiteletUrl, '_blank');
            } catch (e) {
                log.error('openProcessScrap', e.toString());
                alert('Error opening Processing form: ' + e.message);
            }
        }

        /**
         * Open Inspection & Regrade Suitelet scoped to this receipt's lots
         */
        function openRegrade() {
            try {
                const record = currentRecord.get();
                if (!ensureSaved(record, 'Regrade Lot')) return;
                const suiteletUrl = url.resolveScript({
                    scriptId: 'customscript_sust_sl_regrade',
                    deploymentId: 'customdeploy_sust_sl_regrade',
                    params: { ir: record.id }
                });
                window.open(suiteletUrl, '_blank');
            } catch (e) {
                log.error('openRegrade', e.toString());
                alert('Error opening Regrade form: ' + e.message);
            }
        }

        return {
            pageInit: pageInit,
            openLotQuality: openLotQuality,
            openProcessScrap: openProcessScrap,
            openRegrade: openRegrade
        };

    });
