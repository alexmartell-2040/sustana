/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 */

/**
 * SUST_Lib_LotAttributes.js
 *
 * Shared lot-quality writer. Applies quality attributes (moisture / contamination /
 * fiber content / bale count / yield / vendor lot / notes) to an inventorynumber (lot)
 * record and advances its status Received -> Yard (never regressing a later status),
 * defaulting Source Type to Purchased when unset.
 *
 * Extracted so the same behavior backs BOTH capture points:
 *   - the scale kiosk (SUST_SL_ScaleTicket) — capture-at-weigh, and
 *   - the IR-launched Lot Quality Entry (SUST_SL_LotQualityEntry) — capture-at-inspection.
 *
 * Mirrors the write semantics originally in SUST_SL_LotQualityEntry.processSubmission.
 *
 * Author: MHI
 * Date: July 2026
 */

define(['N/record', 'N/search', 'N/log'],
    function(record, search, log) {

        const NOTES_MAX = 3900;

        // Numeric lot fields (order = write order). PERCENT/FLOAT parse the same here.
        const NUM_FIELDS = [
            { key: 'moisture',      fieldId: 'custitemnumber_sust_moisture_pct',        type: 'float',   label: 'Moisture %' },
            { key: 'contamination', fieldId: 'custitemnumber_sust_contamination_pct',   type: 'float',   label: 'Contamination %' },
            { key: 'fiber',         fieldId: 'custitemnumber_sust_fiber_content_pct',   type: 'float',   label: 'Fiber Content %' },
            { key: 'baleCount',     fieldId: 'custitemnumber_sust_bale_count',          type: 'integer', label: 'Bale Count' },
            { key: 'yieldPct',      fieldId: 'custitemnumber_sust_recovery_percentage', type: 'float',   label: 'Yield %' }
        ];

        /** Resolve a lot's internal id from its number string. */
        function resolveLotId(lotNumber) {
            try {
                const res = search.create({
                    type: 'inventorynumber',
                    filters: [['inventorynumber', 'is', lotNumber]],
                    columns: ['internalid']
                }).run().getRange({ start: 0, end: 1 });
                return res.length ? parseInt(res[0].id, 10) : null;
            } catch (e) {
                log.error('resolveLotId', lotNumber + ': ' + e.message);
                return null;
            }
        }

        /** Read current quality values for a lot number (for pre-populating a form). */
        function readLotQuality(lotNumber) {
            const out = {};
            try {
                const lotId = resolveLotId(lotNumber);
                if (!lotId) return out;
                const cols = NUM_FIELDS.map(function (f) { return f.fieldId; });
                cols.push('custitemnumber_sust_vendor_lot_number', 'custitemnumber_sust_lot_notes');
                const lk = search.lookupFields({ type: 'inventorynumber', id: lotId, columns: cols });
                NUM_FIELDS.forEach(function (f) {
                    const v = lk[f.fieldId];
                    if (v !== '' && v !== null && v !== undefined) out[f.key] = v;
                });
                if (lk.custitemnumber_sust_vendor_lot_number) out.vendorLot = lk.custitemnumber_sust_vendor_lot_number;
            } catch (e) {
                log.debug('readLotQuality', lotNumber + ': ' + e.message);
            }
            return out;
        }

        function toNum(v, type) {
            if (v === null || v === undefined || v === '') return null;
            const n = type === 'integer' ? parseInt(v, 10) : parseFloat(v);
            return isNaN(n) ? null : n;
        }

        /** Display helper for audit lines: null originals render as '(none)'. */
        function fmtOriginal(v) {
            return (v === null || v === undefined) ? '(none)' : String(v);
        }

        /**
         * Apply quality attributes to a lot.
         * @param {string|number} lotRef  lot number string or inventorynumber internal id
         * @param {Object} attrs { moisture, contamination, fiber, baleCount, yieldPct,
         *                          vendorLot, sourceTypeText, notesAppend, auditRef }
         *   auditRef: label for the regrade audit note (e.g. 'IR 123'). When set and the
         *   lot already had graded values that this write revises, an
         *   '[Quality Regrade <date>, <auditRef>] original -> revised' line is appended
         *   to the lot notes — mirrors the Lot Quality Entry regrade audit.
         * @returns {Object} { ok, lotId, applied:[], error }
         */
        function writeLotQuality(lotRef, attrs) {
            attrs = attrs || {};
            const applied = [];
            try {
                const lotId = (typeof lotRef === 'number' || /^\d+$/.test(String(lotRef)))
                    ? parseInt(lotRef, 10) : resolveLotId(lotRef);
                if (!lotId) return { ok: false, error: 'Lot not found: ' + lotRef };

                const inv = record.load({ type: record.Type.INVENTORY_NUMBER, id: lotId });

                // Source Type: default Purchased when empty; honor an explicit override.
                const curSource = inv.getValue({ fieldId: 'custitemnumber_sust_lot_source_type' });
                if (!curSource || attrs.sourceTypeText) {
                    try { inv.setText({ fieldId: 'custitemnumber_sust_lot_source_type', text: attrs.sourceTypeText || 'Purchased' }); }
                    catch (eSrc) { log.debug('lot source type skipped', eSrc.message); }
                }

                // Capture originals before writing (for the regrade audit on revisions).
                const originals = {};
                let hadPriorValues = false;
                NUM_FIELDS.forEach(function (f) {
                    const orig = toNum(inv.getValue({ fieldId: f.fieldId }), f.type);
                    originals[f.key] = orig;
                    if (orig !== null) hadPriorValues = true;
                });

                const changes = [];
                NUM_FIELDS.forEach(function (f) {
                    const n = toNum(attrs[f.key], f.type);
                    if (n === null) return;
                    inv.setValue({ fieldId: f.fieldId, value: n });
                    applied.push(f.label + '=' + n);
                    if (originals[f.key] !== n) {
                        changes.push(f.label + ': ' + fmtOriginal(originals[f.key]) + ' -> ' + n);
                    }
                });

                if (attrs.vendorLot) {
                    inv.setValue({ fieldId: 'custitemnumber_sust_vendor_lot_number', value: String(attrs.vendorLot) });
                    applied.push('Vendor Lot=' + attrs.vendorLot);
                }

                let notesAppend = attrs.notesAppend || '';
                if (attrs.auditRef && hadPriorValues && changes.length > 0) {
                    const auditLine = '[Quality Regrade ' + new Date().toISOString().substring(0, 10)
                        + ', ' + attrs.auditRef + '] ' + changes.join('; ') + '.';
                    notesAppend = notesAppend ? (notesAppend + '\n' + auditLine) : auditLine;
                }
                if (notesAppend) {
                    const existing = inv.getValue({ fieldId: 'custitemnumber_sust_lot_notes' }) || '';
                    const merged = (existing ? existing + '\n' : '') + notesAppend;
                    inv.setValue({ fieldId: 'custitemnumber_sust_lot_notes', value: merged.substring(0, NOTES_MAX) });
                }

                // Quality capture moves Received/empty -> Yard; never regress a later status.
                const st = inv.getText({ fieldId: 'custitemnumber_sust_lot_status' }) || '';
                if (st === '' || st === 'Received') {
                    try { inv.setText({ fieldId: 'custitemnumber_sust_lot_status', text: 'Yard' }); }
                    catch (eSt) { log.debug('lot status advance skipped', eSt.message); }
                }

                inv.save();
                log.audit('writeLotQuality', 'Lot ' + lotId + ' updated: ' + (applied.join(', ') || '(status/source only)'));
                return { ok: true, lotId: lotId, applied: applied };
            } catch (e) {
                log.error('writeLotQuality', lotRef + ': ' + e.message + '\n' + (e.stack || ''));
                return { ok: false, error: e.message };
            }
        }

        return {
            resolveLotId: resolveLotId,
            readLotQuality: readLotQuality,
            writeLotQuality: writeLotQuality
        };
    });
