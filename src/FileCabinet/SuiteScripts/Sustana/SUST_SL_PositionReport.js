/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */

/**
 * SUST_SL_PositionReport.js
 *
 * Sustana Recovery — Fiber Position Report.
 *
 * Shows recovered-fiber position as plain tonnage by grade, combining two
 * long legs:
 *   (1) Expected inbound  = open purchase-commitment poundage (un-received)
 *   (2) On-hand inventory = quantity on hand per grade
 *
 * All stored values and math stay in POUNDS; tons (2,000 lbs) are a display
 * conversion via SUST_Lib_Units. Each grade line's measure is simply its
 * weight — no grade-quality factors.
 *
 * Open PO quantity nets out already-received qty (quantity - quantityshiprecv)
 * so a received PO line does NOT double-count against the on-hand leg.
 *
 * Subsidiary resolution: URL ?sub=<id> override, then script param
 * custscript_sust_posrpt_sub_id, then Sustana Config (usSubsidiary). If all
 * are empty the report runs unfiltered (all subsidiaries) and says so in the
 * page footer.
 *
 * Author: Sustana Dev Team
 * Date: July 2026
 */

define(['N/search', 'N/ui/serverWidget', 'N/runtime', 'N/url', 'N/log', './SUST_Lib_Units', './SUST_Lib_Config'],
    function(search, serverWidget, runtime, url, log, units, configLib) {

        const BRAND = '#2976F3';      // company brand blue
        const BRAND_DARK = '#1F5FCC';

        // Yard exception thresholds. Mirror the seeded settlement-penalty
        // definitions (moisture/contamination breach points) and the yard
        // aging expectations from the demo script.
        const EXC = Object.freeze({
            MOISTURE_PCT: 12,      // > this % = quality risk
            CONTAMINATION_PCT: 5,  // > this % = quality risk
            UNGRADED_DAYS: 2,      // still 'Received' (no quality) after N days
            AGING_DAYS: 14         // sitting in Yard/Processing Queue > N days
        });

        // Yard statuses shown in the operational view (Shipped/Depleted excluded).
        const YARD_STATUSES = ['Received', 'Yard', 'Processing Queue', 'Staged'];

        function onRequest(context) {
            try {
                if (context.request.method === 'GET') {
                    render(context);
                } else {
                    context.response.write({ output: 'POST not supported.' });
                }
            } catch (e) {
                log.error('SUST_SL_PositionReport failed', `${e.message}\n${e.stack}`);
                context.response.write({
                    output: '<h2 style="color:#dc2626;">Position Report Error</h2><pre>' +
                            String(e.message).replace(/[<>]/g, '') + '</pre>'
                });
            }
        }

        // ───────────────────────────────────────────────────────────────────────
        // Main render
        // ───────────────────────────────────────────────────────────────────────

        function render(context) {
            const sub = resolveSubsidiary(context);   // { id, source }

            // 1. Universe of fiber-grade items (also carries on-hand qty).
            const itemMap = buildGradeItemMap();

            // 2. Two long legs.
            const po = getOpenPoLines(sub.id, itemMap);   // { rows, mode }
            const onHand = buildOnHandLeg(itemMap);           // [ rows ]

            // 2b. Yard operational view — lots on hand by site/status.
            const yardAll = buildYardLots(itemMap);           // { rows, error }

            // 2c. Expected outbound (open SO lines, short) + work in process.
            const so = getOpenSoLines(sub.id, itemMap);       // { rows, mode }
            const wipAll = buildActiveProcessing();           // { rows, error }

            // Site filter (?site=<location id>) narrows the yard + WIP sections.
            const siteFilter = String(context.request.parameters.site || '');
            const siteOptions = collectSites(yardAll.rows, wipAll.rows);
            const yard = siteFilter
                ? { rows: yardAll.rows.filter(function(r) { return r.siteId === siteFilter; }), error: yardAll.error }
                : yardAll;
            const wip = siteFilter
                ? { rows: wipAll.rows.filter(function(r) { return r.siteId === siteFilter; }), error: wipAll.error }
                : wipAll;
            const siteName = siteFilter
                ? (siteOptions.filter(function(o) { return o.id === siteFilter; })[0] || { name: 'Site ' + siteFilter }).name
                : null;

            // 3. Totals (lbs — converted to tons at display time only).
            let openLbs = 0;
            po.rows.forEach(function(r) { openLbs += r.openLbs; });
            let onHandLbs = 0;
            onHand.forEach(function(r) { onHandLbs += r.onHandLbs; });
            let outLbs = 0;
            so.rows.forEach(function(r) { outLbs += r.openLbs; });
            const totalLbs = openLbs + onHandLbs;
            const netLbs = totalLbs - outLbs;

            // 4. Build the page.
            const form = serverWidget.createForm({ title: 'Sustana Recovery — Yard Operations Dashboard' });

            addInline(form, 'custpage_banner', banner());
            addInline(form, 'custpage_asof', renderAsOf());
            addInline(form, 'custpage_tiles', renderTiles({
                openLbs: openLbs,
                onHandLbs: onHandLbs,
                outLbs: outLbs,
                netLbs: netLbs,
                poCount: po.rows.length,
                soCount: so.rows.length,
                onHandCount: onHand.length,
                exceptionCount: yard.rows.filter(function(r) { return r.exceptions.length > 0; }).length
            }));
            addInline(form, 'custpage_site_selector', renderSiteSelector(siteOptions, siteFilter, siteName));
            addInline(form, 'custpage_charts', renderCharts(yard, onHand));
            addInline(form, 'custpage_yard_matrix', renderYardMatrix(yard));
            addInline(form, 'custpage_yard_detail', renderYardDetail(yard));
            addInline(form, 'custpage_wip', renderWipTable(wip));
            addInline(form, 'custpage_po', renderPoTable(po, openLbs));
            addInline(form, 'custpage_so', renderSoTable(so, outLbs));
            addInline(form, 'custpage_onhand', renderOnHandTable(onHand, onHandLbs));
            addInline(form, 'custpage_notes', notes(sub, po.mode));

            context.response.writePage(form);
        }

        // ───────────────────────────────────────────────────────────────────────
        // Data — items (grades)
        // ───────────────────────────────────────────────────────────────────────

        /**
         * Build a map of fiber-grade inventory/assembly items:
         *   { internalId: { name, onHand } }
         * Each grade's measure is simply its weight in lbs; on-hand qty is
         * captured here for the on-hand leg.
         */
        function buildGradeItemMap() {
            const map = {};
            try {
                search.create({
                    type: 'item',
                    filters: [
                        ['type', 'anyof', 'InvtPart', 'Assembly'], 'AND',
                        ['isinactive', 'is', 'F'], 'AND',
                        // Demo scope: only Sustana grade items (material category set)
                        ['custitem_sust_material_category', 'noneof', '@NONE@']
                    ],
                    columns: [
                        'itemid',
                        'displayname',
                        'quantityonhand',
                        'custitem_sust_material_category'
                    ]
                }).run().each(function(r) {
                    map[r.id] = {
                        name: r.getValue({ name: 'itemid' }) || r.getValue({ name: 'displayname' }) || ('Item ' + r.id),
                        onHand: parseFloat(r.getValue({ name: 'quantityonhand' })) || 0,
                        category: r.getText({ name: 'custitem_sust_material_category' }) || ''
                    };
                    return true;
                });
            } catch (e) {
                log.error('buildGradeItemMap failed', e.message);
            }
            return map;
        }

        // ───────────────────────────────────────────────────────────────────────
        // Data — expected inbound leg (open POs, long)
        // ───────────────────────────────────────────────────────────────────────

        function getOpenPoLines(subId, itemMap) {
            // Primary: formula nets already-received qty so we don't double-count
            // against on-hand. Fallback: status-based, full qty (received column
            // unavailable) — flagged in the footnote.
            try {
                return { rows: runPoSearch(subId, itemMap, true), mode: 'net' };
            } catch (e1) {
                log.error('open-PO net search failed, falling back', e1.message);
                try {
                    return { rows: runPoSearch(subId, itemMap, false), mode: 'gross' };
                } catch (e2) {
                    log.error('open-PO fallback search failed', e2.message);
                    return { rows: [], mode: 'error' };
                }
            }
        }

        function runPoSearch(subId, itemMap, useFormula) {
            const filters = [
                ['mainline', 'is', 'F'], 'AND',
                ['taxline', 'is', 'F'], 'AND',
                ['shipping', 'is', 'F']
            ];
            if (subId) { filters.push('AND', ['subsidiary', 'anyof', subId]); }

            const columns = ['tranid', 'entity', 'trandate', 'item', 'quantity'];

            if (useFormula) {
                filters.push('AND', [
                    'formulanumeric: ABS(NVL({quantity},0)) - ABS(NVL({quantityshiprecv},0))',
                    'greaterthan', 0
                ]);
                columns.push('quantityshiprecv');
            } else {
                // open / partially-received PO statuses
                filters.push('AND', ['status', 'anyof',
                    'PurchOrd:A', 'PurchOrd:B', 'PurchOrd:D', 'PurchOrd:E']);
            }

            const rows = [];
            search.create({ type: 'purchaseorder', filters: filters, columns: columns })
                .run().each(function(r) {
                    const itemId = r.getValue({ name: 'item' });
                    const info = itemMap[itemId];
                    if (!info) return true; // not an inventory grade item

                    const gross = Math.abs(parseFloat(r.getValue({ name: 'quantity' })) || 0);
                    const recv = useFormula
                        ? Math.abs(parseFloat(r.getValue({ name: 'quantityshiprecv' })) || 0)
                        : 0;
                    const openQty = Math.max(gross - recv, 0);
                    if (!(openQty > 0)) return true;

                    rows.push({
                        poId: r.id,
                        tranid: r.getValue({ name: 'tranid' }) || ('PO ' + r.id),
                        vendor: r.getText({ name: 'entity' }) || '—',
                        date: r.getValue({ name: 'trandate' }) || '',
                        itemName: info.name,
                        openLbs: openQty
                    });
                    return true;
                });

            rows.sort(function(a, b) { return b.openLbs - a.openLbs; });
            return rows;
        }

        // ───────────────────────────────────────────────────────────────────────
        // Data — expected outbound leg (open SOs, short)
        // ───────────────────────────────────────────────────────────────────────

        function getOpenSoLines(subId, itemMap) {
            try {
                return { rows: runSoSearch(subId, itemMap, true), mode: 'net' };
            } catch (e1) {
                log.error('open-SO net search failed, falling back', e1.message);
                try {
                    return { rows: runSoSearch(subId, itemMap, false), mode: 'gross' };
                } catch (e2) {
                    log.error('open-SO fallback search failed', e2.message);
                    return { rows: [], mode: 'error' };
                }
            }
        }

        function runSoSearch(subId, itemMap, useFormula) {
            const filters = [
                ['mainline', 'is', 'F'], 'AND',
                ['taxline', 'is', 'F'], 'AND',
                ['shipping', 'is', 'F']
            ];
            if (subId) { filters.push('AND', ['subsidiary', 'anyof', subId]); }

            const columns = ['tranid', 'entity', 'trandate', 'item', 'quantity'];
            if (useFormula) {
                filters.push('AND', [
                    'formulanumeric: ABS(NVL({quantity},0)) - ABS(NVL({quantityshiprecv},0))',
                    'greaterthan', 0
                ]);
                columns.push('quantityshiprecv');
            } else {
                // open / partially-fulfilled SO statuses
                filters.push('AND', ['status', 'anyof',
                    'SalesOrd:A', 'SalesOrd:B', 'SalesOrd:D', 'SalesOrd:E']);
            }

            const rows = [];
            search.create({ type: 'salesorder', filters: filters, columns: columns })
                .run().each(function(r) {
                    const itemId = r.getValue({ name: 'item' });
                    const info = itemMap[itemId];
                    if (!info) return true;

                    const gross = Math.abs(parseFloat(r.getValue({ name: 'quantity' })) || 0);
                    const shipped = useFormula
                        ? Math.abs(parseFloat(r.getValue({ name: 'quantityshiprecv' })) || 0)
                        : 0;
                    const openQty = Math.max(gross - shipped, 0);
                    if (!(openQty > 0)) return true;

                    rows.push({
                        soId: r.id,
                        tranid: r.getValue({ name: 'tranid' }) || ('SO ' + r.id),
                        customer: r.getText({ name: 'entity' }) || '—',
                        date: r.getValue({ name: 'trandate' }) || '',
                        itemName: info.name,
                        openLbs: openQty
                    });
                    return true;
                });

            rows.sort(function(a, b) { return b.openLbs - a.openLbs; });
            return rows;
        }

        // ───────────────────────────────────────────────────────────────────────
        // Data — work in process (equipment & labor)
        // ───────────────────────────────────────────────────────────────────────

        /**
         * Non-completed processing records: who is running what on which
         * equipment, and how much material is tied up in WIP.
         */
        function buildActiveProcessing() {
            const rows = [];
            try {
                search.create({
                    type: 'customrecord_sust_processing_record',
                    filters: [['isinactive', 'is', 'F']],
                    columns: [
                        'name',
                        'custrecord_sust_processing_status',
                        'custrecord_sust_processing_type',
                        'custrecord_sust_proc_equipment',
                        'custrecord_sust_processing_operator',
                        'custrecord_sust_processing_location',
                        'custrecord_sust_processing_input_lbs',
                        'custrecord_sust_processing_date'
                    ]
                }).run().each(function(r) {
                    const status = r.getText({ name: 'custrecord_sust_processing_status' }) || '';
                    if (status === 'Completed') return true; // only live work
                    rows.push({
                        procId: r.id,
                        name: r.getValue({ name: 'name' }) || ('PROC ' + r.id),
                        status: status || 'Draft',
                        type: r.getText({ name: 'custrecord_sust_processing_type' }) || '—',
                        equipment: r.getText({ name: 'custrecord_sust_proc_equipment' }) || '—',
                        operator: r.getText({ name: 'custrecord_sust_processing_operator' }) || 'Unassigned',
                        site: r.getText({ name: 'custrecord_sust_processing_location' }) || '—',
                        siteId: String(r.getValue({ name: 'custrecord_sust_processing_location' }) || ''),
                        inputLbs: Math.abs(parseFloat(r.getValue({ name: 'custrecord_sust_processing_input_lbs' })) || 0),
                        date: r.getValue({ name: 'custrecord_sust_processing_date' }) || ''
                    });
                    return true;
                });
            } catch (e) {
                log.error('buildActiveProcessing failed', e.message);
                return { rows: [], error: e.message };
            }
            rows.sort(function(a, b) { return b.inputLbs - a.inputLbs; });
            return { rows: rows, error: null };
        }

        // ───────────────────────────────────────────────────────────────────────
        // Data — on-hand leg (long)
        // ───────────────────────────────────────────────────────────────────────

        function buildOnHandLeg(itemMap) {
            const rows = [];
            Object.keys(itemMap).forEach(function(id) {
                const info = itemMap[id];
                if (info.onHand > 0) {
                    rows.push({
                        itemName: info.name,
                        onHandLbs: info.onHand
                    });
                }
            });
            rows.sort(function(a, b) { return b.onHandLbs - a.onHandLbs; });
            return rows;
        }

        // ───────────────────────────────────────────────────────────────────────
        // Data — yard operational view (lots on hand, by site/status)
        // ───────────────────────────────────────────────────────────────────────

        /**
         * All on-hand lots with their yard status, site, and quality reads.
         * Source: inventorynumber (lot) records — the same records the kiosk
         * and Lot Quality Entry write to.
         * @returns {Object} { rows: [...], error: string|null }
         */
        function buildYardLots(itemMap) {
            const rows = [];
            try {
                search.create({
                    type: 'inventorynumber',
                    filters: [['quantityonhand', 'greaterthan', 0]],
                    columns: [
                        'inventorynumber', 'item', 'location', 'quantityonhand',
                        'custitemnumber_sust_lot_status',
                        'custitemnumber_sust_moisture_pct',
                        'custitemnumber_sust_contamination_pct',
                        'custitemnumber_sust_received_date'
                    ]
                }).run().each(function(r) {
                    const status = r.getText({ name: 'custitemnumber_sust_lot_status' }) || 'Received';
                    if (YARD_STATUSES.indexOf(status) === -1) return true; // Shipped/Depleted out of scope

                    const itemId = r.getValue({ name: 'item' });
                    const info = itemMap[itemId] || {};
                    const row = {
                        lotId: r.id,
                        lotNumber: r.getValue({ name: 'inventorynumber' }) || ('Lot ' + r.id),
                        itemName: info.name || r.getText({ name: 'item' }) || '—',
                        category: info.category || '',
                        site: r.getText({ name: 'location' }) || 'Unassigned',
                        siteId: String(r.getValue({ name: 'location' }) || ''),
                        status: status,
                        onHandLbs: Math.abs(parseFloat(r.getValue({ name: 'quantityonhand' })) || 0),
                        moisture: numOrNull(r.getValue({ name: 'custitemnumber_sust_moisture_pct' })),
                        contamination: numOrNull(r.getValue({ name: 'custitemnumber_sust_contamination_pct' })),
                        receivedDate: r.getValue({ name: 'custitemnumber_sust_received_date' }) || ''
                    };
                    row.ageDays = ageInDays(row.receivedDate);
                    row.exceptions = lotExceptions(row);
                    rows.push(row);
                    return true;
                });
            } catch (e) {
                log.error('buildYardLots failed', e.message);
                return { rows: [], error: e.message };
            }
            // Exceptions first, then largest tonnage.
            rows.sort(function(a, b) {
                if ((b.exceptions.length > 0) !== (a.exceptions.length > 0)) {
                    return b.exceptions.length > 0 ? 1 : -1;
                }
                return b.onHandLbs - a.onHandLbs;
            });
            return { rows: rows, error: null };
        }

        /**
         * Risk rules a yard manager can act on. Each exception carries the
         * action to take.
         */
        function lotExceptions(row) {
            const exc = [];
            if (row.moisture !== null && row.moisture > EXC.MOISTURE_PCT) {
                exc.push({
                    label: 'Moisture ' + row.moisture + '% > ' + EXC.MOISTURE_PCT + '%',
                    action: 'Settlement penalty applies — verify grading and review the supplier settlement.'
                });
            }
            if (row.contamination !== null && row.contamination > EXC.CONTAMINATION_PCT) {
                exc.push({
                    label: 'Contamination ' + row.contamination + '% > ' + EXC.CONTAMINATION_PCT + '%',
                    action: 'Settlement penalty applies — consider re-grade or reject-to-vendor.'
                });
            }
            const ungraded = row.moisture === null && row.contamination === null;
            if (ungraded && row.status === 'Received' && row.ageDays !== null && row.ageDays > EXC.UNGRADED_DAYS) {
                exc.push({
                    label: 'Ungraded ' + row.ageDays + 'd',
                    action: 'No quality on file — capture at the kiosk (correction) or via Lot Quality Entry on the Item Receipt.'
                });
            }
            if (row.ageDays !== null && row.ageDays > EXC.AGING_DAYS &&
                (row.status === 'Yard' || row.status === 'Processing Queue')) {
                exc.push({
                    label: 'Aging ' + row.ageDays + 'd',
                    action: 'Sitting in the yard beyond ' + EXC.AGING_DAYS + ' days — schedule processing or staging.'
                });
            }
            return exc;
        }

        function numOrNull(v) {
            if (v === null || v === undefined || v === '') return null;
            const n = parseFloat(v);
            return isNaN(n) ? null : n;
        }

        function ageInDays(dateStr) {
            if (!dateStr) return null;
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return null;
            return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
        }

        // ───────────────────────────────────────────────────────────────────────
        // Subsidiary resolution
        // ───────────────────────────────────────────────────────────────────────

        /**
         * @returns {object} { id: string|null, source: 'url'|'param'|'config'|null }
         */
        function resolveSubsidiary(context) {
            const urlSub = context.request.parameters.sub;
            if (urlSub) return { id: String(urlSub), source: 'url' };
            try {
                const p = runtime.getCurrentScript().getParameter({ name: 'custscript_sust_posrpt_sub_id' });
                if (p) return { id: String(p), source: 'param' };
            } catch (e) { /* param not configured */ }
            const cfgSub = configLib.get('usSubsidiary');
            if (cfgSub) return { id: String(cfgSub), source: 'config' };
            log.audit('Position Report — no subsidiary filter',
                'Script param custscript_sust_posrpt_sub_id and Sustana Config usSubsidiary are both empty; running unfiltered (all subsidiaries).');
            return { id: null, source: null };
        }

        // ───────────────────────────────────────────────────────────────────────
        // Rendering
        // ───────────────────────────────────────────────────────────────────────

        function addInline(form, id, html) {
            form.addField({ id: id, type: serverWidget.FieldType.INLINEHTML, label: ' ' }).defaultValue = html;
        }

        function banner() {
            return ''
                + '<div style="border:2px solid ' + BRAND + '; background:#eaf2ff; color:#0d2a52;'
                + ' padding:14px 16px; margin:8px 0; border-radius:6px; font-family:Arial,sans-serif;">'
                + '  <div style="font-weight:bold; font-size:15px; margin-bottom:6px; color:' + BRAND_DARK + ';">'
                + '    Yard Operations &amp; Fiber Position (tons)</div>'
                + '  <div style="font-size:13px; line-height:1.5;">'
                + '    Fiber tonnage by grade: expected inbound (open purchase commitments) <b>+</b> on-hand inventory <b>&minus;</b> expected outbound (open sales commitments), '
                + '    with the yard operational view and live work-in-process below. '
                + '    All quantities are stored in pounds; tons (2,000 lbs) are shown for readability. Dollar mark-to-market is a later phase.'
                + '  </div>'
                + '</div>';
        }

        function renderAsOf() {
            const now = new Date();
            const stamp = now.toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
            return ''
                + '<div style="font-family:Arial,sans-serif; font-size:12px; color:#475569; background:#f8fafc;'
                + ' border:1px solid #e2e8f0; border-radius:6px; padding:8px 12px; margin:4px 0 8px;'
                + ' display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px;">'
                + '  <span><b>Data as of ' + esc(stamp) + '</b> — computed live on page load from item, open-PO, and lot searches (no cache).</span>'
                + '  <a href="javascript:location.reload()" style="color:' + BRAND + '; font-weight:bold; text-decoration:none;">&#8635; Refresh now</a>'
                + '</div>';
        }

        function renderTiles(t) {
            const excColors = t.exceptionCount > 0
                ? { bg: '#fef2f2', border: '#dc2626', text: '#7f1d1d' }
                : { bg: '#f0fdf4', border: '#16a34a', text: '#14532d' };
            return ''
                + '<div style="display:flex; gap:12px; flex-wrap:wrap; font-family:Arial,sans-serif; font-size:13px; margin:6px 0 4px;">'
                + tile('Expected Inbound (tons)', esc(units.formatTons(t.openLbs)), '#eaf2ff', BRAND, '#0d2a52')
                + tile('On Hand (tons)', esc(units.formatTons(t.onHandLbs)), '#eaf2ff', BRAND, '#0d2a52')
                + tile('Expected Outbound (tons)', esc(units.formatTons(t.outLbs)), '#fff7ed', '#ea580c', '#7c2d12')
                + tile('Net Position (tons)', esc(units.formatTons(t.netLbs)), BRAND, BRAND_DARK, '#ffffff', true)
                + tile('Lot Exceptions', String(t.exceptionCount), excColors.bg, excColors.border, excColors.text)
                + '</div>'
                + '<div style="font-family:Arial,sans-serif; font-size:11px; color:#64748b; margin-bottom:8px;">'
                + '  ' + t.poCount + ' open PO line(s) &middot; ' + t.soCount + ' open SO line(s) &middot; ' + t.onHandCount + ' on-hand grade(s). '
                + '  Net = inbound + on hand &minus; outbound. 1 ton = 2,000 lbs; stored values remain in pounds.'
                + '</div>';
        }

        function tile(label, value, bg, border, text, big) {
            return ''
                + '<div style="flex:1; min-width:150px; border:2px solid ' + border + '; background:' + bg + '; color:' + text + ';'
                + ' padding:12px; border-radius:6px; text-align:center;">'
                + '  <div style="font-size:11px; opacity:0.9;">' + label + '</div>'
                + '  <div style="font-size:' + (big ? '26' : '22') + 'px; font-weight:bold; margin-top:4px;">' + value + '</div>'
                + '</div>';
        }

        /** Distinct sites present in yard + WIP data, for the site selector. */
        function collectSites(yardRows, wipRows) {
            const seen = {};
            const sites = [];
            (yardRows || []).concat(wipRows || []).forEach(function(r) {
                if (r.siteId && !seen[r.siteId]) {
                    seen[r.siteId] = true;
                    sites.push({ id: r.siteId, name: r.site });
                }
            });
            sites.sort(function(a, b) { return a.name < b.name ? -1 : 1; });
            return sites;
        }

        /** Site dropdown — reloads the page with ?site=<id> (keeps other params). */
        function renderSiteSelector(siteOptions, siteFilter, siteName) {
            const opts = ['<option value="">All Sites</option>'].concat(siteOptions.map(function(o) {
                return '<option value="' + esc(o.id) + '"' + (o.id === siteFilter ? ' selected' : '') + '>' + esc(o.name) + '</option>';
            })).join('');
            const scopeNote = siteFilter
                ? '<span style="margin-left:12px; padding:2px 10px; background:#eaf2ff; border:1px solid ' + BRAND + '; border-radius:10px; color:#0d2a52; font-weight:bold;">Showing: ' + esc(siteName) + '</span>'
                + '<span style="margin-left:8px; color:#94a3b8; font-size:11px;">(yard, charts &amp; WIP sections; the position legs stay company-wide)</span>'
                : '';
            return '<div style="font-family:Arial,sans-serif; font-size:13px; margin:4px 0 8px; display:flex; align-items:center;">'
                + '<b style="margin-right:10px;">Site:</b>'
                + '<select style="padding:6px 10px; border:1px solid #cbd5e1; border-radius:4px; font-size:13px;" '
                + 'onchange="var u=new URL(window.location.href); if(this.value){u.searchParams.set(\'site\',this.value);}else{u.searchParams.delete(\'site\');} window.location=u.toString();">'
                + opts + '</select>'
                + scopeNote
                + '</div>';
        }

        /**
         * CSS-only chart cards: tons by site (bars), yard status mix (stacked
         * bar), on-hand grade mix (bars). No libraries — pure divs.
         */
        function renderCharts(yard, onHand) {
            const STATUS_COLORS = {
                'Received': '#ca8a04', 'Yard': BRAND,
                'Processing Queue': '#9333ea', 'Staged': '#16a34a'
            };

            // Tons by site
            const bySite = {};
            yard.rows.forEach(function(r) { bySite[r.site] = (bySite[r.site] || 0) + r.onHandLbs; });
            const siteMax = Math.max.apply(null, Object.keys(bySite).map(function(k) { return bySite[k]; }).concat([1]));
            const siteBars = Object.keys(bySite).sort().map(function(site) {
                const pct = (bySite[site] / siteMax) * 100;
                return '<div style="margin:6px 0;">'
                    + '<div style="display:flex; justify-content:space-between; font-size:11px; color:#475569;"><span>' + esc(site) + '</span><b>' + esc(units.formatTons(bySite[site])) + ' t</b></div>'
                    + '<div style="height:14px; background:#eef2f7; border-radius:4px; overflow:hidden;"><div style="height:14px; width:' + pct.toFixed(0) + '%; background:' + BRAND + '; border-radius:4px;"></div></div>'
                    + '</div>';
            }).join('') || '<div style="color:#94a3b8; font-size:12px;">No yard lots.</div>';

            // Status mix (stacked bar + legend)
            const byStatus = {};
            let statusTotal = 0;
            yard.rows.forEach(function(r) { byStatus[r.status] = (byStatus[r.status] || 0) + r.onHandLbs; statusTotal += r.onHandLbs; });
            const segs = YARD_STATUSES.filter(function(st) { return byStatus[st] > 0; });
            const stackedBar = statusTotal > 0
                ? '<div style="display:flex; height:22px; border-radius:5px; overflow:hidden; margin:8px 0;">'
                    + segs.map(function(st) {
                        return '<div title="' + esc(st) + '" style="width:' + ((byStatus[st] / statusTotal) * 100).toFixed(1) + '%; background:' + STATUS_COLORS[st] + ';"></div>';
                    }).join('') + '</div>'
                    + segs.map(function(st) {
                        return '<div style="display:flex; justify-content:space-between; font-size:11px; margin:3px 0; color:#475569;">'
                            + '<span><span style="display:inline-block; width:10px; height:10px; background:' + STATUS_COLORS[st] + '; border-radius:2px; margin-right:6px;"></span>' + esc(st) + '</span>'
                            + '<b>' + esc(units.formatTons(byStatus[st])) + ' t (' + ((byStatus[st] / statusTotal) * 100).toFixed(0) + '%)</b></div>';
                    }).join('')
                : '<div style="color:#94a3b8; font-size:12px;">No yard lots.</div>';

            // On-hand grade mix
            const gradeMax = Math.max.apply(null, onHand.map(function(r) { return r.onHandLbs; }).concat([1]));
            const gradeBars = onHand.map(function(r) {
                const pct = (r.onHandLbs / gradeMax) * 100;
                return '<div style="margin:6px 0;">'
                    + '<div style="display:flex; justify-content:space-between; font-size:11px; color:#475569;"><span>' + esc(r.itemName) + '</span><b>' + esc(units.formatTons(r.onHandLbs)) + ' t</b></div>'
                    + '<div style="height:14px; background:#eef2f7; border-radius:4px; overflow:hidden;"><div style="height:14px; width:' + pct.toFixed(0) + '%; background:#16a34a; border-radius:4px;"></div></div>'
                    + '</div>';
            }).join('') || '<div style="color:#94a3b8; font-size:12px;">No on-hand inventory.</div>';

            const card = function(title, body) {
                return '<div style="flex:1; min-width:260px; border:1px solid #cbd5e1; border-radius:8px; padding:12px 14px; background:#ffffff;">'
                    + '<div style="font-size:12px; font-weight:bold; color:' + BRAND_DARK + '; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:4px;">' + title + '</div>'
                    + body + '</div>';
            };
            return '<div style="display:flex; gap:12px; flex-wrap:wrap; font-family:Arial,sans-serif; margin:4px 0 10px;">'
                + card('Yard Tons by Site', siteBars)
                + card('Yard Status Mix', stackedBar)
                + card('On-Hand Grade Mix (company-wide)', gradeBars)
                + '</div>';
        }

        // ── Yard operational view ──────────────────────────────────────────────

        function renderYardMatrix(yard) {
            const head = sectionHead('Yard Operations — Tons by Site &amp; Status',
                'On-hand lots only (Shipped/Depleted excluded). Source: lot records written by the scale kiosk and Lot Quality Entry.');
            if (yard.error) return head + emptyMsg('Lot search failed: ' + yard.error);
            if (yard.rows.length === 0) return head + emptyMsg('No on-hand lots found. Run the demo seeder or receive a scale ticket.');

            // site -> status -> lbs
            const sites = {};
            yard.rows.forEach(function(r) {
                sites[r.site] = sites[r.site] || {};
                sites[r.site][r.status] = (sites[r.site][r.status] || 0) + r.onHandLbs;
            });

            const colTotals = {};
            let grand = 0;
            const body = Object.keys(sites).sort().map(function(site) {
                let rowTotal = 0;
                const cells = YARD_STATUSES.map(function(st) {
                    const lbs = sites[site][st] || 0;
                    rowTotal += lbs;
                    colTotals[st] = (colTotals[st] || 0) + lbs;
                    return tdR(lbs > 0 ? esc(units.formatTons(lbs)) : '<span style="color:#cbd5e1;">—</span>');
                }).join('');
                grand += rowTotal;
                return '<tr>' + td('<b>' + esc(site) + '</b>') + cells
                    + tdR('<b>' + esc(units.formatTons(rowTotal)) + '</b>') + '</tr>';
            }).join('');

            const foot = '<tr style="background:#eaf2ff; font-weight:bold;">'
                + td('All Sites')
                + YARD_STATUSES.map(function(st) { return tdR(esc(units.formatTons(colTotals[st] || 0))); }).join('')
                + tdR(esc(units.formatTons(grand)))
                + '</tr>';

            return head + tableWrap(['Site'].concat(YARD_STATUSES).concat(['Total']), body + foot, 1);
        }

        function renderYardDetail(yard) {
            const head = sectionHead('Yard Lots — Grade, Status &amp; Exceptions',
                'Exception lots sort first. Click a lot to open its record; the Action column says what to do about the risk.');
            if (yard.error || yard.rows.length === 0) return ''; // matrix section already carries the message

            const body = yard.rows.map(function(r) {
                const hasExc = r.exceptions.length > 0;
                const excHtml = hasExc
                    ? r.exceptions.map(function(x) { return badge(esc(x.label), '#fef2f2', '#dc2626', '#7f1d1d'); }).join(' ')
                    : badge('OK', '#f0fdf4', '#16a34a', '#14532d');
                const actionHtml = hasExc
                    ? r.exceptions.map(function(x) { return esc(x.action); }).join('<br/>')
                    : '<span style="color:#94a3b8;">—</span>';
                const quality = (r.moisture !== null ? 'M ' + r.moisture + '%' : '')
                    + (r.moisture !== null && r.contamination !== null ? ' / ' : '')
                    + (r.contamination !== null ? 'C ' + r.contamination + '%' : '');
                return '<tr' + (hasExc ? ' style="background:#fff7f7;"' : '') + '>'
                    + td(recordLink('inventorynumber', r.lotId, esc(r.lotNumber)))
                    + td(esc(r.site))
                    + td(esc(r.itemName) + (r.category ? '<br/><span style="color:#94a3b8; font-size:11px;">' + esc(r.category) + '</span>' : ''))
                    + td(statusBadge(r.status))
                    + tdR('<b>' + esc(units.formatTons(r.onHandLbs)) + '</b>')
                    + td(quality || '<span style="color:#94a3b8;">not graded</span>')
                    + td(excHtml)
                    + td('<span style="font-size:11px;">' + actionHtml + '</span>')
                    + '</tr>';
            }).join('');

            return head + tableWrap(
                ['Lot #', 'Site', 'Grade', 'Status', 'Tons', 'Quality', 'Exception', 'Action'],
                body, 4);
        }

        function statusBadge(status) {
            const colors = {
                'Received':         { bg: '#fefce8', border: '#ca8a04', text: '#713f12' },
                'Yard':             { bg: '#eaf2ff', border: BRAND,     text: '#0d2a52' },
                'Processing Queue': { bg: '#faf5ff', border: '#9333ea', text: '#581c87' },
                'Staged':           { bg: '#f0fdf4', border: '#16a34a', text: '#14532d' }
            };
            const c = colors[status] || { bg: '#f8fafc', border: '#94a3b8', text: '#334155' };
            return badge(esc(status), c.bg, c.border, c.text);
        }

        function badge(html, bg, border, text) {
            return '<span style="display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px;'
                + ' background:' + bg + '; border:1px solid ' + border + '; color:' + text + '; white-space:nowrap;">'
                + html + '</span>';
        }

        function renderWipTable(wip) {
            const head = sectionHead('Work in Process — Equipment &amp; Labor',
                'Open processing runs (Draft / In Process / Awaiting Cost): which operator is on which equipment, and the tonnage tied up. Click a run to open it.');
            if (wip.error) return head + emptyMsg('Processing search failed: ' + wip.error);
            if (wip.rows.length === 0) {
                return head + emptyMsg('No open processing runs. Start one from SUST - Processing Entry or an Item Receipt "Process Material" button.');
            }
            const body = wip.rows.map(function(r) {
                return '<tr>'
                    + td(recordLink('customrecord_sust_processing_record', r.procId, esc(r.name)))
                    + td(esc(r.site))
                    + td(esc(r.type))
                    + td(esc(r.equipment))
                    + td(r.operator === 'Unassigned'
                        ? '<span style="color:#ca8a04;">Unassigned</span>' : esc(r.operator))
                    + td(statusBadge(r.status))
                    + tdR('<b>' + esc(units.formatTons(r.inputLbs)) + '</b>')
                    + '</tr>';
            }).join('');
            return head + tableWrap(
                ['Run #', 'Site', 'Type', 'Equipment', 'Operator', 'Status', 'Input Tons'],
                body, 6);
        }

        function renderSoTable(so, totalLbs) {
            const head = sectionHead('Expected Outbound — Open Sales Commitments (short)',
                'Committed fiber not yet shipped, by customer and grade. Quantity is net of fulfillments.');

            if (so.rows.length === 0) {
                return head + emptyMsg('No open sales commitments found.');
            }

            const body = so.rows.map(function(r) {
                return '<tr>'
                    + td(recordLink('salesorder', r.soId, esc(r.tranid)))
                    + td(esc(r.customer))
                    + td(esc(r.date))
                    + td(esc(r.itemName))
                    + tdR(commas(r.openLbs, 0))
                    + tdR('<b>' + esc(units.formatTons(r.openLbs)) + '</b>')
                    + '</tr>';
            }).join('');

            const foot = '<tr style="background:#fff7ed; font-weight:bold;">'
                + td('Subtotal — Expected Outbound') + td('') + td('') + td('')
                + tdR(commas(totalLbs, 0)) + tdR(esc(units.formatTons(totalLbs)))
                + '</tr>';

            return head + tableWrap(
                ['SO #', 'Customer', 'Order Date', 'Grade', 'Open Lbs', 'Open Tons'],
                body + foot, 4);
        }

        function renderPoTable(po, totalLbs) {
            const head = sectionHead('Expected Inbound — Open Purchase Commitments (long)',
                'Committed fiber not yet received, by vendor and grade. Quantity is net of receipts so it does not overlap the on-hand leg.');

            if (po.rows.length === 0) {
                return head + emptyMsg('No open purchase commitments found.');
            }

            const body = po.rows.map(function(r) {
                return '<tr>'
                    + td(recordLink('purchaseorder', r.poId, esc(r.tranid)))
                    + td(esc(r.vendor))
                    + td(esc(r.date))
                    + td(esc(r.itemName))
                    + tdR(commas(r.openLbs, 0))
                    + tdR('<b>' + esc(units.formatTons(r.openLbs)) + '</b>')
                    + '</tr>';
            }).join('');

            const foot = '<tr style="background:#eaf2ff; font-weight:bold;">'
                + td('Subtotal — Expected Inbound') + td('') + td('') + td('')
                + tdR(commas(totalLbs, 0)) + tdR(esc(units.formatTons(totalLbs)))
                + '</tr>';

            return head + tableWrap(
                ['PO #', 'Vendor', 'Order Date', 'Grade', 'Open Lbs', 'Open Tons'],
                body + foot, 4);
        }

        function renderOnHandTable(rows, totalLbs) {
            const head = sectionHead('On-Hand Inventory (long)',
                'Physical fiber currently in inventory, by grade, across all locations.');

            if (rows.length === 0) {
                return head + emptyMsg('No on-hand inventory found.');
            }

            const body = rows.map(function(r) {
                return '<tr>'
                    + td(esc(r.itemName))
                    + tdR(commas(r.onHandLbs, 0))
                    + tdR('<b>' + esc(units.formatTons(r.onHandLbs)) + '</b>')
                    + '</tr>';
            }).join('');

            const foot = '<tr style="background:#eaf2ff; font-weight:bold;">'
                + td('Subtotal — On-Hand')
                + tdR(commas(totalLbs, 0)) + tdR(esc(units.formatTons(totalLbs)))
                + '</tr>';

            return head + tableWrap(
                ['Grade', 'On-Hand Lbs', 'On-Hand Tons'],
                body + foot, 1);
        }

        function sectionHead(title, sub) {
            return '<div style="font-family:Arial,sans-serif; margin:18px 0 6px;">'
                + '<div style="font-size:15px; font-weight:bold; color:' + BRAND_DARK + ';">' + esc(title) + '</div>'
                + '<div style="font-size:12px; color:#64748b;">' + esc(sub) + '</div>'
                + '</div>';
        }

        function tableWrap(headers, bodyHtml, rightFrom) {
            const ths = headers.map(function(h, i) {
                return '<th style="padding:8px 10px; text-align:' + (i >= rightFrom ? 'right' : 'left') + '; color:#fff;">' + esc(h) + '</th>';
            }).join('');
            return '<div style="font-family:Arial,sans-serif; font-size:13px;">'
                + '<table style="width:100%; border-collapse:collapse; border:1px solid #cbd5e1;">'
                + '<thead style="background:' + BRAND + ';"><tr>' + ths + '</tr></thead>'
                + '<tbody>' + bodyHtml + '</tbody></table></div>';
        }

        /**
         * Drill-down link to any record via N/url (correct URL per record type
         * and account). Falls back to plain text if resolution fails.
         */
        function recordLink(recordType, id, labelHtml) {
            try {
                const u = url.resolveRecord({ recordType: recordType, recordId: id });
                return '<a href="' + u + '" style="color:' + BRAND + ';">' + labelHtml + '</a>';
            } catch (e) {
                return labelHtml;
            }
        }

        function td(html) { return '<td style="padding:6px 10px; border-bottom:1px solid #e5e7eb;">' + html + '</td>'; }
        function tdR(html) { return '<td style="padding:6px 10px; border-bottom:1px solid #e5e7eb; text-align:right;">' + html + '</td>'; }

        function emptyMsg(msg) {
            return '<div style="padding:16px; color:#6b7280; font-style:italic; font-family:Arial,sans-serif;">' + esc(msg)
                + ' Check that inventory grade items are active and that the subsidiary filter is correct.</div>';
        }

        function notes(sub, mode) {
            const grossNote = (mode === 'gross')
                ? '<li><b>Note:</b> received-quantity netting was unavailable, so open PO lines show full PO quantity — partially received POs may overlap the on-hand leg.</li>'
                : '';
            let subNote;
            if (sub.id) {
                const sourceLabel = sub.source === 'url' ? 'URL override'
                    : sub.source === 'param' ? 'script parameter'
                    : 'Sustana Config (usSubsidiary)';
                subNote = 'internal id <b>' + esc(sub.id) + '</b> (from ' + sourceLabel + ')';
            } else {
                subNote = '<b>none — running unfiltered across all subsidiaries</b>. Set script parameter '
                    + '<code>custscript_sust_posrpt_sub_id</code> or the Sustana Config US subsidiary to filter';
            }
            return '<div style="font-family:Arial,sans-serif; font-size:12px; color:#475569; margin-top:18px; border-top:1px solid #e5e7eb; padding-top:10px;">'
                + '<div style="font-weight:bold; color:' + BRAND_DARK + '; margin-bottom:4px;">Methodology &amp; scope</div>'
                + '<ul style="margin:0 0 0 18px; padding:0; line-height:1.6;">'
                + '<li>Position = plain fiber tonnage by grade. Each grade line\'s measure is simply its weight; tons are a display conversion (1 ton = 2,000 lbs) — stored values and math stay in pounds.</li>'
                + '<li>Net position = inbound + on hand &minus; outbound (price-up = gain on the net long). Dollar mark-to-market is a later phase.</li>'
                + '<li>Expected inbound = open PO quantity net of receipts; expected outbound = open SO quantity net of fulfillments; on-hand = item quantity on hand across locations. Work in Process lists non-completed processing records (equipment, operator, input tonnage).</li>'
                + '<li><b>KPI data source &amp; refresh:</b> every figure is computed live on page load — grades/on-hand from an item search, expected inbound from an open-PO search, yard view from lot (inventory number) records. Nothing is cached or scheduled; reload the page to refresh.</li>'
                + '<li><b>Exception rules:</b> Moisture &gt; ' + EXC.MOISTURE_PCT + '% or Contamination &gt; ' + EXC.CONTAMINATION_PCT + '% (settlement-penalty breach), Ungraded after ' + EXC.UNGRADED_DAYS + ' days in Received, Aging after ' + EXC.AGING_DAYS + ' days in Yard/Processing Queue.</li>'
                + '<li>Subsidiary filter: ' + subNote + '. Override with <code>?sub=&lt;id&gt;</code>. The yard view is location-based and unaffected by the subsidiary filter.</li>'
                + grossNote
                + '</ul></div>';
        }

        // ───────────────────────────────────────────────────────────────────────
        // Helpers
        // ───────────────────────────────────────────────────────────────────────

        function commas(n, dec) {
            const num = Number(n) || 0;
            const f = Math.pow(10, dec);
            const x = (Math.round(num * f) / f).toFixed(dec);
            const parts = x.split('.');
            parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
            return parts.join('.');
        }

        function esc(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
        }

        return { onRequest: onRequest };
    });
