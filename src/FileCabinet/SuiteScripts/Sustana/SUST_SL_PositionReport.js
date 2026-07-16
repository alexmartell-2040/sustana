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

define(['N/search', 'N/ui/serverWidget', 'N/runtime', 'N/log', './SUST_Lib_Units', './SUST_Lib_Config'],
    function(search, serverWidget, runtime, log, units, configLib) {

        const BRAND = '#2976F3';      // company brand blue
        const BRAND_DARK = '#1F5FCC';

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

            // 3. Totals (lbs — converted to tons at display time only).
            let openLbs = 0;
            po.rows.forEach(function(r) { openLbs += r.openLbs; });
            let onHandLbs = 0;
            onHand.forEach(function(r) { onHandLbs += r.onHandLbs; });
            const totalLbs = openLbs + onHandLbs;

            // 4. Build the page.
            const form = serverWidget.createForm({ title: 'Sustana Recovery — Fiber Position Report' });

            addInline(form, 'custpage_banner', banner());
            addInline(form, 'custpage_tiles', renderTiles({
                openLbs: openLbs,
                onHandLbs: onHandLbs,
                totalLbs: totalLbs,
                poCount: po.rows.length,
                onHandCount: onHand.length
            }));
            addInline(form, 'custpage_po', renderPoTable(po, openLbs));
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
                        ['isinactive', 'is', 'F']
                    ],
                    columns: [
                        'itemid',
                        'displayname',
                        'quantityonhand'
                    ]
                }).run().each(function(r) {
                    map[r.id] = {
                        name: r.getValue({ name: 'itemid' }) || r.getValue({ name: 'displayname' }) || ('Item ' + r.id),
                        onHand: parseFloat(r.getValue({ name: 'quantityonhand' })) || 0
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
                + '    Recovered Fiber Position (tons)</div>'
                + '  <div style="font-size:13px; line-height:1.5;">'
                + '    Fiber tonnage by grade across <b>two long legs</b>: expected inbound (open purchase commitments, un-received) <b>+</b> on-hand inventory. '
                + '    All quantities are stored in pounds; tons (2,000 lbs) are shown for readability. '
                + '    The sales (short) leg and dollar mark-to-market are later phases.'
                + '  </div>'
                + '</div>';
        }

        function renderTiles(t) {
            return ''
                + '<div style="display:flex; gap:12px; flex-wrap:wrap; font-family:Arial,sans-serif; font-size:13px; margin:6px 0 4px;">'
                + tile('Expected Inbound (tons)', esc(units.formatTons(t.openLbs)), '#eaf2ff', BRAND, '#0d2a52')
                + tile('On Hand (tons)', esc(units.formatTons(t.onHandLbs)), '#eaf2ff', BRAND, '#0d2a52')
                + tile('Total Position (tons)', esc(units.formatTons(t.totalLbs)), BRAND, BRAND_DARK, '#ffffff', true)
                + '</div>'
                + '<div style="font-family:Arial,sans-serif; font-size:11px; color:#64748b; margin-bottom:8px;">'
                + '  ' + t.poCount + ' open PO line(s) &middot; ' + t.onHandCount + ' on-hand grade(s). '
                + '  1 ton = 2,000 lbs; stored values remain in pounds.'
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

        function renderPoTable(po, totalLbs) {
            const head = sectionHead('Expected Inbound — Open Purchase Commitments (long)',
                'Committed fiber not yet received, by vendor and grade. Quantity is net of receipts so it does not overlap the on-hand leg.');

            if (po.rows.length === 0) {
                return head + emptyMsg('No open purchase commitments found.');
            }

            const body = po.rows.map(function(r) {
                return '<tr>'
                    + td('<a href="/app/accounting/transactions/purchord.nl?id=' + r.poId + '" style="color:' + BRAND + ';">' + esc(r.tranid) + '</a>')
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
                + '<li>Both legs are <b>long</b> (price-up = gain). The <b>sales/short leg</b> and dollar mark-to-market are later phases.</li>'
                + '<li>Expected inbound = open PO quantity net of receipts; on-hand = item quantity on hand across locations.</li>'
                + '<li>Subsidiary filter: ' + subNote + '. Override with <code>?sub=&lt;id&gt;</code>.</li>'
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
