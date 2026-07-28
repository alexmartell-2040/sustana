/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */

/**
 * SUST_SL_SeedSustanaDemo.js
 *
 * Idempotent demo-data seeder for the Sustana Recovery demo account.
 *
 * GET  — form with one checkbox per seed group plus a summary of what already
 *        exists in the account.
 * POST — runs the selected groups in order and renders a per-group results
 *        list with links to every created/updated record.
 *
 * Seed groups:
 *   0. PRECHECK   — subsidiaries 'Sustana Recovery US' / 'Sustana Recovery Canada'
 *                   must already exist (verify only — fail fast when missing).
 *   1. Config     — one active customrecord_sust_config record wired to the GL
 *                   accounts, settlement fee item, and default location.
 *   2. Locations  — Markham (CA), Cincinnati, Buffalo, St Joseph (US).
 *   3. Items      — 5 lot-numbered grade items (White Ledger, Mixed Paper,
 *                   Mixed Office Paper, SOP, Mill Residuals).
 *   4. Entities   — vendor Fox Valley Recycling, customer Packaging Mill A.
 *   5. Prices     — RISI SOP + RISI White Ledger monthly index values
 *                   (Feb–Jul 2026, $/ton) via SUST_Lib_MarketPrice.
 *   6. Schedules  — supplier (Purchase) and customer (Sale) '% of Index'
 *                   settlement schedules.
 *   7. PO-10001   — open purchase order, 40,000 lbs White Ledger, pricing
 *                   'Determined on Arrival'. Left un-received on purpose.
 *   8. On-hand    — one inventory adjustment creating three yard lots
 *                   (WL/MP/SOP) with quality fields set on each lot.
 *   9. Planning   — OPTIONAL: 7 sales orders + 3 estimates for the SOP
 *                   planning story (default unchecked).
 *
 * Idempotency: every seeded standard record carries an externalid beginning
 * SUSTDEMO_ (e.g. SUSTDEMO_ITEM_WL, SUSTDEMO_VENDOR_FOXVALLEY) — re-running
 * finds and updates instead of duplicating. Custom records have no externalid,
 * so they are matched by natural key: config = first active record, schedules
 * = vendor/customer + item + direction, index prices = date + source (the
 * market price lib upserts). The on-hand inventory adjustment group is skipped
 * outright when its externalid already exists — adjustments are not safely
 * re-runnable. Quantities are pounds by convention throughout.
 *
 * Author: MHI
 * Date: July 2026
 */

define(['N/record', 'N/search', 'N/log', 'N/ui/serverWidget', 'N/format', 'N/url',
        './SUST_Lib_MarketPrice', './SUST_Lib_Config', './SUST_Lib_SettlementCreate'],
    function(record, search, log, serverWidget, format, url, marketPriceLib, configLib, settlementLib) {

        const EXT_PREFIX = 'SUSTDEMO_';
        const US_SUB_NAME = 'Sustana Recovery US';
        const CA_SUB_NAME = 'Sustana Recovery Canada';
        const LOT_ITEM_TYPE = 'lotnumberedinventoryitem';
        const SCHEDULE_TYPE = 'customrecord_sust_settlement_schedule';
        const MARKET_PRICE_TYPE = 'customrecord_sust_market_price';

        const COLOR = {
            blue: '#2976F3',
            darkBlue: '#1f5fcc',
            green: '#059669',
            red: '#dc2626',
            gray: '#64748b',
            ink: '#0d2a52'
        };

        const LOCATIONS = [
            { key: 'MARKHAM',    name: 'Markham',    extid: EXT_PREFIX + 'LOC_MARKHAM',    sub: 'CA' },
            { key: 'CINCINNATI', name: 'Cincinnati', extid: EXT_PREFIX + 'LOC_CINCINNATI', sub: 'US' },
            { key: 'BUFFALO',    name: 'Buffalo',    extid: EXT_PREFIX + 'LOC_BUFFALO',    sub: 'US' },
            { key: 'STJOSEPH',   name: 'St Joseph',  extid: EXT_PREFIX + 'LOC_STJOSEPH',   sub: 'US' },
            { key: 'SAVAGE',     name: 'Savage',     extid: EXT_PREFIX + 'LOC_SAVAGE',     sub: 'US' },
            { key: 'MANSFIELD',  name: 'Mansfield',  extid: EXT_PREFIX + 'LOC_MANSFIELD',  sub: 'US' },
            { key: 'LACHINE',    name: 'Lachine',    extid: EXT_PREFIX + 'LOC_LACHINE',    sub: 'CA' }
        ];

        // Grade items. marketSource/category/allocClass are DISPLAY TEXTS of the
        // corresponding custom lists (set with setText, never numeric ids).
        const GRADE_ITEMS = [
            { key: 'WL',    name: 'White Ledger',              extid: EXT_PREFIX + 'ITEM_WL',    marketSource: 'RISI White Ledger',       category: 'Recovered Paper', allocClass: 'Primary',   typicalRecovery: 95,   stdBaleLbs: 1200, scrap: true },
            { key: 'MP',    name: 'Mixed Paper',               extid: EXT_PREFIX + 'ITEM_MP',    marketSource: 'RISI Mixed Paper',        category: 'Recovered Paper', allocClass: 'Primary',   typicalRecovery: 90,   stdBaleLbs: 1300, scrap: true },
            { key: 'MOP',   name: 'Mixed Office Paper',        extid: EXT_PREFIX + 'ITEM_MOP',   marketSource: 'RISI Mixed Office Paper', category: 'Recovered Paper', allocClass: 'Primary',   typicalRecovery: 92,   stdBaleLbs: 1250, scrap: true },
            { key: 'SOP',   name: 'SOP (Sorted Office Paper)', extid: EXT_PREFIX + 'ITEM_SOP',   marketSource: 'RISI SOP',                category: 'Finished Fiber',  allocClass: 'Primary',   typicalRecovery: 96,   stdBaleLbs: 1100, scrap: true },
            { key: 'RESID', name: 'Mill Residuals',            extid: EXT_PREFIX + 'ITEM_RESID', marketSource: null,                      category: 'Residual',        allocClass: 'Byproduct', typicalRecovery: null, stdBaleLbs: 1500, scrap: false }
        ];

        const FEE_ITEM = { name: 'Settlement Fee', extid: EXT_PREFIX + 'ITEM_SETTLEFEE' };
        const VENDOR = { name: 'Fox Valley Recycling', extid: EXT_PREFIX + 'VENDOR_FOXVALLEY' };
        const CUSTOMER = { name: 'Packaging Mill A', extid: EXT_PREFIX + 'CUST_PACKMILLA' };

        // Published index values in $/ton (the market price lib converts to $/lb).
        // Six first-of-month observations, Feb 2026 – Jul 2026.
        const INDEX_START = { year: 2026, month: 1 }; // month is 0-based → Feb
        const INDEX_PRICES = [
            { sourceText: 'RISI SOP',                values: [185, 190, 195, 200, 205, 200] },
            { sourceText: 'RISI White Ledger',       values: [310, 315, 320, 318, 325, 330] },
            { sourceText: 'RISI Mixed Office Paper', values: [140, 142, 145, 143, 148, 150] }
        ];

        // Yard variety: lots across Buffalo/St Joseph with mixed statuses,
        // quality (incl. exception triggers), and ages — feeds the Yard
        // Operations Dashboard site matrix, charts, and exception list.
        const YARD_VARIETY_LOTS = [
            { site: 'BUFFALO',  itemKey: 'MOP', qty: 24000, lot: 'MOP-SEED-B01', unitCost: 0.07, status: 'Received',         daysAgo: 4,  quality: null },                                             // ungraded exception
            { site: 'BUFFALO',  itemKey: 'WL',  qty: 36000, lot: 'WL-SEED-B02',  unitCost: 0.15, status: 'Processing Queue', daysAgo: 6,  quality: { moisture: 13, contamination: 3, fiber: 90, bales: 30 } }, // moisture exception
            { site: 'BUFFALO',  itemKey: 'SOP', qty: 18000, lot: 'SOP-SEED-B03', unitCost: 0.09, status: 'Staged',           daysAgo: 2,  quality: { moisture: 6,  contamination: 1, fiber: 95, bales: 16 } },
            { site: 'STJOSEPH', itemKey: 'MP',  qty: 28000, lot: 'MP-SEED-S01',  unitCost: 0.05, status: 'Yard',             daysAgo: 5,  quality: { moisture: 9,  contamination: 6, fiber: 84, bales: 22 } }, // contamination exception
            { site: 'STJOSEPH', itemKey: 'WL',  qty: 40000, lot: 'WL-SEED-S02',  unitCost: 0.15, status: 'Yard',             daysAgo: 20, quality: { moisture: 8,  contamination: 2, fiber: 92, bales: 33 } }, // aging exception
            { site: 'STJOSEPH', itemKey: 'MOP', qty: 22000, lot: 'MOP-SEED-S03', unitCost: 0.07, status: 'Received',         daysAgo: 1,  quality: { moisture: 7,  contamination: 2, fiber: 91, bales: 18 } },
            { site: 'SAVAGE',    itemKey: 'WL',  qty: 32000, lot: 'WL-SEED-V01',  unitCost: 0.15, status: 'Yard',             daysAgo: 3,  form: 'Loose', quality: { moisture: 8,  contamination: 2, fiber: 93, bales: 27 } },
            { site: 'SAVAGE',    itemKey: 'SOP', qty: 16000, lot: 'SOP-SEED-V02', unitCost: 0.09, status: 'Staged',           daysAgo: 1,  form: 'Baled', quality: { moisture: 6,  contamination: 1, fiber: 96, bales: 15 } },
            { site: 'MANSFIELD', itemKey: 'MP',  qty: 26000, lot: 'MP-SEED-M01',  unitCost: 0.05, status: 'Yard',             daysAgo: 7,  form: 'Loose', quality: { moisture: 10, contamination: 4, fiber: 86, bales: 20 } },
            { site: 'MANSFIELD', itemKey: 'SOP', qty: 20000, lot: 'SOP-SEED-M02', unitCost: 0.09, status: 'Processing Queue', daysAgo: 4,  form: 'Baled', quality: { moisture: 6,  contamination: 1, fiber: 95, bales: 18 } },
            // Demo stock at Cincinnati — sized for the 5.5 script (consume
            // 30t WL + 15t MP + 10t SOP) with headroom for dry runs.
            { site: 'CINCINNATI', itemKey: 'WL',  qty: 80000, lot: 'WL-DEMO-001',  unitCost: 0.15, status: 'Yard', daysAgo: 2, form: 'Loose', quality: { moisture: 8,  contamination: 2, fiber: 92, bales: 66 } },
            { site: 'CINCINNATI', itemKey: 'MP',  qty: 44000, lot: 'MP-DEMO-001',  unitCost: 0.05, status: 'Yard', daysAgo: 2, form: 'Loose', quality: { moisture: 9,  contamination: 4, fiber: 86, bales: 34 } },
            { site: 'CINCINNATI', itemKey: 'SOP', qty: 30000, lot: 'SOP-DEMO-001', unitCost: 0.09, status: 'Yard', daysAgo: 1, form: 'Loose', quality: { moisture: 6,  contamination: 1, fiber: 95, bales: 27 } }
        ];

        const PO_EXTID = EXT_PREFIX + 'PO_10001';

        // Additional open POs — a realistic expected-inbound book across
        // grades and sites for the Yard Operations Dashboard.
        const EXTRA_POS = [
            { num: 'PO-10002', itemKey: 'MP',  qty: 30000, rate: 0.05, site: 'BUFFALO',   daysOut: 1 },
            { num: 'PO-10003', itemKey: 'MOP', qty: 24000, rate: 0.07, site: 'SAVAGE',    daysOut: 2 },
            { num: 'PO-10004', itemKey: 'WL',  qty: 44000, rate: 0.15, site: 'MANSFIELD', daysOut: 3 },
            { num: 'PO-10005', itemKey: 'SOP', qty: 18000, rate: 0.09, site: 'STJOSEPH',  daysOut: 4 }
        ];
        const IA_EXTID = EXT_PREFIX + 'IA_ONHAND';

        // On-hand yard lots for the processing scenario (quantities in lbs).
        const ONHAND_LOTS = [
            { itemKey: 'WL',  qty: 60000, lot: 'WL-SEED-001',  unitCost: 0.15, bales: 60, moisture: 8,  contamination: 2, fiber: 92, vendorLot: 'FV-2026-0142' },
            { itemKey: 'MP',  qty: 30000, lot: 'MP-SEED-001',  unitCost: 0.05, bales: 30, moisture: 10, contamination: 5, fiber: 85, vendorLot: null },
            { itemKey: 'SOP', qty: 20000, lot: 'SOP-SEED-001', unitCost: 0.09, bales: 20, moisture: 6,  contamination: 1, fiber: 95, vendorLot: null }
        ];

        const PLANNING_QTY_LBS = 40000;
        const PLANNING_ESTIMATES = [
            { extid: EXT_PREFIX + 'EST_08', reason: 'Delayed - Customer Request' },
            { extid: EXT_PREFIX + 'EST_09', reason: 'Delayed - Customer Request' },
            { extid: EXT_PREFIX + 'EST_10', reason: 'Cancelled - Price Disagreement' }
        ];

        const GROUPS = [
            { paramId: 'custpage_grp_config',    label: 'Group 1 - Config record (GL accounts, settlement fee item, default location)', defaultChecked: true },
            { paramId: 'custpage_grp_locations', label: 'Group 2 - Locations (Markham, Cincinnati, Buffalo, St Joseph)',                defaultChecked: true },
            { paramId: 'custpage_grp_items',     label: 'Group 3 - Items (5 lot-numbered grades)',                                      defaultChecked: true },
            { paramId: 'custpage_grp_entities',  label: 'Group 4 - Entities (Fox Valley Recycling, Packaging Mill A)',                  defaultChecked: true },
            { paramId: 'custpage_grp_prices',    label: 'Group 5 - Index prices (RISI SOP + RISI White Ledger, Feb-Jul 2026)',          defaultChecked: true },
            { paramId: 'custpage_grp_schedules', label: 'Group 6 - Settlement schedules (supplier Purchase + customer Sale)',           defaultChecked: true },
            { paramId: 'custpage_grp_po',        label: 'Group 7 - Open PO-10001 (left un-received for the receiving demo)',            defaultChecked: true },
            { paramId: 'custpage_grp_onhand',    label: 'Group 8 - On-hand lots (inventory adjustment + lot quality)',                  defaultChecked: true },
            { paramId: 'custpage_grp_planning',  label: 'Group 9 - Planning scenario (7 confirmed SOs + 2 delayed + 1 cancelled)',      defaultChecked: true },
            { paramId: 'custpage_grp_templates', label: 'Group 10 - Item output templates (default outputs for Processing Entry)',      defaultChecked: true },
            { paramId: 'custpage_grp_settlements', label: 'Group 11 - Sample settlements (feed the Close-Out dashboard)',                defaultChecked: true },
            { paramId: 'custpage_grp_monthly',     label: 'Group 12 - Monthly blanket settlement scenario (2 POs -> 2 receipts -> 1 blanket settlement + deductions). RUN ALONE.', defaultChecked: false }
        ];

        function onRequest(context) {
            try {
                if (context.request.method === 'GET') {
                    renderForm(context);
                } else {
                    runSeed(context);
                }
            } catch (e) {
                log.error('SUST_SL_SeedSustanaDemo failed', errText(e) + '\n' + (e.stack || '(no stack)'));
                context.response.write({
                    output: '<h2 style="color:' + COLOR.red + ';">Seeder Error (top level)</h2>'
                        + '<pre>name: ' + esc(String((e && e.name) || '(none)'))
                        + '\nmessage: ' + esc(errText(e))
                        + '\n\nstack:\n' + esc(String((e && e.stack) || '(no stack)')) + '</pre>'
                });
            }
        }

        // ─── GET: form ────────────────────────────────────────────────────────

        function renderForm(context) {
            const form = serverWidget.createForm({ title: 'Sustana Demo Data Seeder' });

            const banner = form.addField({ id: 'custpage_banner', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            banner.defaultValue = bannerHtml();

            const summary = form.addField({ id: 'custpage_summary', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
            summary.defaultValue = currentStateHtml();

            GROUPS.forEach(function(g) {
                const f = form.addField({ id: g.paramId, type: serverWidget.FieldType.CHECKBOX, label: g.label });
                f.defaultValue = g.defaultChecked ? 'T' : 'F';
            });

            form.addSubmitButton({ label: 'Run Selected Groups' });
            context.response.writePage(form);
        }

        function bannerHtml() {
            return '<div style="border:2px solid ' + COLOR.blue + '; background:#eaf2ff; color:' + COLOR.ink + '; padding:14px 16px; margin:8px 0; border-radius:6px; font-family:Arial,sans-serif;">'
                + '<div style="font-weight:bold; font-size:14px; margin-bottom:6px; color:' + COLOR.darkBlue + ';">Sustana Recovery - Demo Data Seeder</div>'
                + '<div style="font-size:13px; line-height:1.5;">'
                + 'Seeds the recovered-fiber demo dataset. <strong>Idempotent</strong> - every seeded record carries an '
                + 'externalid beginning <code>SUSTDEMO_</code> (custom records are matched by natural key), so re-running '
                + 'updates existing records instead of duplicating them. The on-hand inventory adjustment group is skipped '
                + 'entirely once seeded. Quantities are pounds by convention.<br/><br/>'
                + 'Prerequisite: subsidiaries named exactly <code>' + esc(US_SUB_NAME) + '</code> and '
                + '<code>' + esc(CA_SUB_NAME) + '</code> must already exist - the seeder verifies and stops if they are missing.'
                + '</div></div>';
        }

        function currentStateHtml() {
            const lines = [];
            const pre = findDemoSubsidiaries();
            if (pre.ok) {
                lines.push(stateLine(COLOR.green, 'Subsidiaries: ' + US_SUB_NAME + ' (id ' + pre.usId + ') and ' + CA_SUB_NAME + ' (id ' + pre.caId + ') found'));
            } else {
                lines.push(stateLine(COLOR.red, 'Subsidiaries MISSING - create "' + US_SUB_NAME + '" and "' + CA_SUB_NAME + '" (Setup > Company > Subsidiaries) before running'));
            }

            const cfgId = findActiveConfigId();
            lines.push(stateLine(cfgId ? COLOR.green : COLOR.gray, 'Config: ' + (cfgId ? 'active Sustana Config record present (id ' + cfgId + ')' : 'no active config record yet')));

            const locFound = Object.keys(findExistingByExternalIds('location', pluck(LOCATIONS, 'extid'))).length;
            lines.push(stateLine(locFound === LOCATIONS.length ? COLOR.green : COLOR.gray, 'Locations: ' + locFound + ' of ' + LOCATIONS.length + ' seeded'));

            const itemExtids = pluck(GRADE_ITEMS, 'extid').concat([FEE_ITEM.extid]);
            const itemsFound = Object.keys(findExistingByExternalIds('item', itemExtids)).length;
            lines.push(stateLine(itemsFound === itemExtids.length ? COLOR.green : COLOR.gray, 'Items: ' + itemsFound + ' of ' + itemExtids.length + ' seeded (5 grades + settlement fee item)'));

            const vendorOk = !!findByExternalId('vendor', VENDOR.extid);
            const custOk = !!findByExternalId('customer', CUSTOMER.extid);
            lines.push(stateLine(vendorOk && custOk ? COLOR.green : COLOR.gray, 'Entities: vendor ' + (vendorOk ? 'seeded' : 'not seeded') + ', customer ' + (custOk ? 'seeded' : 'not seeded')));

            const priceCount = runPagedCount(MARKET_PRICE_TYPE, []);
            lines.push(stateLine(priceCount > 0 ? COLOR.green : COLOR.gray, 'Index prices: ' + priceCount + ' market price row(s) on file (12 seeded by Group 5)'));

            const schedCount = runPagedCount(SCHEDULE_TYPE, [['isinactive', 'is', 'F']]);
            lines.push(stateLine(schedCount > 0 ? COLOR.green : COLOR.gray, 'Settlement schedules: ' + schedCount + ' on file (2 seeded by Group 6)'));

            const poId = findByExternalId('purchaseorder', PO_EXTID);
            lines.push(stateLine(poId ? COLOR.green : COLOR.gray, 'PO-10001: ' + (poId ? 'seeded - leave it open (un-received) for the receiving demo' : 'not seeded yet')));

            const iaId = findByExternalId('inventoryadjustment', IA_EXTID);
            lines.push(stateLine(iaId ? COLOR.green : COLOR.gray, 'On-hand lots: ' + (iaId ? 'seeded (group will be skipped on re-run)' : 'not seeded yet')));

            const soFound = Object.keys(findExistingByExternalIds('salesorder', planningSoExtids())).length;
            const estFound = Object.keys(findExistingByExternalIds('estimate', pluck(PLANNING_ESTIMATES, 'extid'))).length;
            lines.push(stateLine(soFound + estFound > 0 ? COLOR.green : COLOR.gray, 'Planning scenario: ' + soFound + ' of 7 sales orders, ' + estFound + ' of 3 estimates seeded'));

            return '<div style="font-family:Arial,sans-serif; background:#f9fafb; border:1px solid #d1d5db; border-radius:6px; padding:12px 16px; margin:8px 0;">'
                + '<div style="font-weight:bold; font-size:13px; color:' + COLOR.ink + '; margin-bottom:6px;">Current state</div>'
                + '<ul style="margin:0; padding-left:18px; font-size:12px; line-height:1.7;">' + lines.join('') + '</ul>'
                + '</div>';
        }

        function stateLine(color, text) {
            return '<li style="color:' + color + ';">' + esc(text) + '</li>';
        }

        // ─── POST: run the selected groups ────────────────────────────────────

        function runSeed(context) {
            const params = context.request.parameters;
            const checked = function(paramId) { return params[paramId] === 'T'; };

            const out = { sections: [] };
            const ctx = {
                usSubId: null, caSubId: null,
                locIds: {}, itemIds: {},
                vendorId: null, customerId: null,
                invAdjAcctId: null, settleExpAcctId: null, feeItemId: null,
                itemDefaults: null
            };

            // Group 0 — PRECHECK (always runs; everything stops when it fails)
            const pre = findDemoSubsidiaries();
            if (!pre.ok) {
                log.audit('Seed precheck failed', 'Missing subsidiaries: '
                    + (pre.usId ? '' : US_SUB_NAME + ' ') + (pre.caId ? '' : CA_SUB_NAME));
                context.response.write({ output: failFastHtml(pre) });
                return;
            }
            ctx.usSubId = pre.usId;
            ctx.caSubId = pre.caId;
            const preSection = newSection(out, 'Group 0 - Precheck (subsidiaries)');
            addRow(preSection, 'info', US_SUB_NAME + ' - subsidiary id ' + pre.usId, 'subsidiary', pre.usId);
            addRow(preSection, 'info', CA_SUB_NAME + ' - subsidiary id ' + pre.caId, 'subsidiary', pre.caId);

            // Every group is individually guarded: one group blowing up (even with
            // a null-message Java error) can no longer kill the whole run — the
            // results page renders with an error section naming the group + stack.
            const GROUP_FNS = [
                ['custpage_grp_config',      'Group 1 - Config',            seedConfig],
                ['custpage_grp_locations',   'Group 2 - Locations',         seedLocations],
                ['custpage_grp_items',       'Group 3 - Items',             seedItems],
                ['custpage_grp_entities',    'Group 4 - Entities',          seedEntities],
                ['custpage_grp_prices',      'Group 5 - Index prices',      seedIndexPrices],
                ['custpage_grp_schedules',   'Group 6 - Schedules',         seedSchedules],
                ['custpage_grp_po',          'Group 7 - Open PO',           seedOpenPO],
                ['custpage_grp_onhand',      'Group 8 - On-hand lots',      seedOnHandLots],
                ['custpage_grp_planning',    'Group 9 - Planning',          seedPlanning],
                ['custpage_grp_templates',   'Group 10 - Output templates', seedItemOutputTemplates],
                ['custpage_grp_settlements', 'Group 11 - Settlements',      seedSampleSettlements],
                ['custpage_grp_monthly',     'Group 12 - Monthly scenario', seedMonthlyScenario]
            ];
            GROUP_FNS.forEach(function(g) {
                if (!checked(g[0])) return;
                try {
                    g[2](ctx, out);
                } catch (e) {
                    const sec = newSection(out, g[1] + ' — CRASHED');
                    addRow(sec, 'error', 'Uncaught error in ' + g[1] + ': ' + errText(e));
                    addRow(sec, 'error', 'Stack: ' + String((e && e.stack) || '(no stack)').substring(0, 900));
                    log.error('Seed group crashed', g[1] + ': ' + errText(e) + '\n' + (e && e.stack));
                }
            });

            context.response.write({ output: resultsHtml(out) });
        }

        // ─── Programmatic entry point (used by the SUST_RL_SeedDemo RESTlet) ──────
        // Runs the FULL seed (all groups) and returns a JSON-safe summary instead of
        // HTML. Same ctx + dispatch as runSeed, so behavior is identical — it just has
        // no request/response, so it can be driven by a RESTlet or scheduled script.
        function runSeedAll() {
            const out = { sections: [] };
            const ctx = {
                usSubId: null, caSubId: null,
                locIds: {}, itemIds: {},
                vendorId: null, customerId: null,
                invAdjAcctId: null, settleExpAcctId: null, feeItemId: null,
                itemDefaults: null
            };

            const pre = findDemoSubsidiaries();
            if (!pre.ok) {
                const missing = [];
                if (!pre.usId) missing.push(US_SUB_NAME);
                if (!pre.caId) missing.push(CA_SUB_NAME);
                return { ok: false, error: 'Subsidiaries missing: ' + missing.join(', '), sections: [] };
            }
            ctx.usSubId = pre.usId;
            ctx.caSubId = pre.caId;

            seedConfig(ctx, out);
            seedLocations(ctx, out);
            seedItems(ctx, out);
            seedEntities(ctx, out);
            seedIndexPrices(ctx, out);
            seedSchedules(ctx, out);
            seedOpenPO(ctx, out);
            seedOnHandLots(ctx, out);
            seedPlanning(ctx, out);
            seedItemOutputTemplates(ctx, out);
            seedSampleSettlements(ctx, out);

            return { ok: true, ranAt: new Date().toISOString(), sections: out.sections };
        }

        // ─── Group 0: precheck ────────────────────────────────────────────────

        function findDemoSubsidiaries() {
            const out = { ok: false, usId: null, caId: null };
            try {
                search.create({
                    type: 'subsidiary',
                    filters: [['isinactive', 'is', 'F']],
                    columns: ['name', 'namenohierarchy']
                }).run().each(function(res) {
                    const plain = res.getValue({ name: 'namenohierarchy' }) || res.getValue({ name: 'name' }) || '';
                    if (plain === US_SUB_NAME) out.usId = parseInt(res.id, 10);
                    if (plain === CA_SUB_NAME) out.caId = parseInt(res.id, 10);
                    return !(out.usId && out.caId);
                });
            } catch (e) {
                log.error('findDemoSubsidiaries', e.message);
            }
            out.ok = !!(out.usId && out.caId);
            return out;
        }

        function failFastHtml(pre) {
            const missing = [];
            if (!pre.usId) missing.push(US_SUB_NAME);
            if (!pre.caId) missing.push(CA_SUB_NAME);
            return '<div style="font-family:Arial,sans-serif; max-width:720px; margin:40px auto; padding:20px 24px; border:2px solid ' + COLOR.red + '; border-radius:8px; background:#fef2f2;">'
                + '<h2 style="color:' + COLOR.red + '; margin-top:0;">Cannot seed - subsidiaries missing</h2>'
                + '<p style="font-size:14px; color:#334155;">Missing: <strong>' + esc(missing.join(', ')) + '</strong></p>'
                + '<p style="font-size:14px; color:#334155;">Create subsidiaries named exactly &#39;' + esc(US_SUB_NAME) + '&#39; and &#39;' + esc(CA_SUB_NAME) + '&#39; (Setup &gt; Company &gt; Subsidiaries), then re-run.</p>'
                + '<p style="font-size:14px; color:#334155;">No seed group was run.</p>'
                + '<p style="font-size:13px;"><a href="javascript:history.back()" style="color:' + COLOR.blue + '; font-weight:bold;">Back to the seeder form</a></p>'
                + '</div>';
        }

        // ─── Group 1: config record ───────────────────────────────────────────

        function seedConfig(ctx, out) {
            const section = newSection(out, 'Group 1 - Config record');
            try {
                ctx.invAdjAcctId = ensureExpenseAccount(ctx, 'Inventory Adjustment - Processing', EXT_PREFIX + 'ACCT_INVADJ', 'Inventory Adjustment', section);
                ctx.settleExpAcctId = ensureExpenseAccount(ctx, 'Material Settlement Expense', EXT_PREFIX + 'ACCT_SETTLEEXP', 'Material Settlement', section);
                ctx.feeItemId = ensureSettlementFeeItem(ctx, section);
                const defaultLocId = ensureLocation(ctx, locationSpec('CINCINNATI'), section); // lazy — Group 2 re-reports it as existing

                let cfgId = findActiveConfigId();
                let cfg;
                let action = 'updated';
                if (cfgId) {
                    cfg = record.load({ type: configLib.RECORD_TYPE, id: cfgId });
                } else {
                    cfg = record.create({ type: configLib.RECORD_TYPE });
                    cfg.setValue({ fieldId: 'name', value: 'Sustana Config' });
                    action = 'created';
                }
                cfg.setValue({ fieldId: 'custrecord_sustcfg_active', value: true });
                cfg.setValue({ fieldId: configLib.FIELDS.usSubsidiary, value: ctx.usSubId });
                cfg.setValue({ fieldId: configLib.FIELDS.caSubsidiary, value: ctx.caSubId });
                if (ctx.invAdjAcctId) cfg.setValue({ fieldId: configLib.FIELDS.invAdjAccount, value: ctx.invAdjAcctId });
                if (ctx.settleExpAcctId) cfg.setValue({ fieldId: configLib.FIELDS.settlementExpenseAccount, value: ctx.settleExpAcctId });
                if (ctx.feeItemId) cfg.setValue({ fieldId: configLib.FIELDS.settlementFeeItem, value: ctx.feeItemId });
                if (defaultLocId) cfg.setValue({ fieldId: configLib.FIELDS.defaultLocation, value: defaultLocId });
                cfgId = cfg.save();

                configLib.reset(); // drop the lib cache so later groups read the fresh values
                addRow(section, action, 'Sustana Config (single active config record)', configLib.RECORD_TYPE, cfgId);
            } catch (e) {
                addRow(section, 'error', 'Config record: ' + e.message);
                log.error('seedConfig', e.message + '\n' + e.stack);
            }
        }

        function findActiveConfigId() {
            try {
                const res = search.create({
                    type: configLib.RECORD_TYPE,
                    filters: [['custrecord_sustcfg_active', 'is', 'T'], 'AND', ['isinactive', 'is', 'F']],
                    columns: ['internalid']
                }).run().getRange({ start: 0, end: 1 });
                return res.length ? parseInt(res[0].id, 10) : null;
            } catch (e) {
                log.error('findActiveConfigId', e.message);
                return null;
            }
        }

        /**
         * Ensure an Expense account. Order: externalid → exact name → create →
         * fall back to any Expense account whose name starts with fallbackPrefix.
         */
        function ensureExpenseAccount(ctx, name, extid, fallbackPrefix, section) {
            try {
                let id = findByExternalId('account', extid);
                if (id) {
                    addRow(section, 'exists', 'Account ' + name, 'account', id);
                    return parseInt(id, 10);
                }
                id = findExpenseAccountByName(name, 'is');
                if (id) {
                    try {
                        record.submitFields({ type: 'account', id: id, values: { externalid: extid } });
                    } catch (eAdopt) {
                        log.debug('ensureExpenseAccount', 'Could not stamp externalid on account ' + id + ': ' + eAdopt.message);
                    }
                    addRow(section, 'exists', 'Account ' + name + ' (matched by name)', 'account', id);
                    return parseInt(id, 10);
                }
                try {
                    const acct = record.create({ type: 'account' });
                    acct.setValue({ fieldId: 'acctname', value: name });
                    acct.setValue({ fieldId: 'accttype', value: 'Expense' });
                    acct.setValue({ fieldId: 'externalid', value: extid });
                    // Match the widest subsidiary restriction anything downstream (the
                    // settlement fee item, IA transactions) will need — an item/transaction's
                    // subsidiary set must be a subset of its account's.
                    setSubsidiaryField(acct, [ctx.usSubId, ctx.caSubId]);
                    id = acct.save({ ignoreMandatoryFields: true });
                    addRow(section, 'created', 'Account ' + name + ' (Expense)', 'account', id);
                    return parseInt(id, 10);
                } catch (eCreate) {
                    log.error('ensureExpenseAccount', 'Creation of "' + name + '" failed: ' + eCreate.message
                        + ' - falling back to an existing "' + fallbackPrefix + '%" Expense account');
                    id = findExpenseAccountByName(fallbackPrefix, 'startswith') || findAccountIdByType(['Expense']);
                    if (id) {
                        log.audit('ensureExpenseAccount', 'Using existing account id ' + id + ' in place of "' + name + '"');
                        addRow(section, 'info', 'Account "' + name + '" could not be created (' + eCreate.message + ') - using existing Expense account id ' + id + ' instead', 'account', id);
                        return parseInt(id, 10);
                    }
                    addRow(section, 'error', 'Account "' + name + '": ' + eCreate.message + ' (and no fallback Expense account was found)');
                    return null;
                }
            } catch (e) {
                addRow(section, 'error', 'Account ' + name + ': ' + e.message);
                log.error('ensureExpenseAccount', name + ': ' + e.message);
                return null;
            }
        }

        function findExpenseAccountByName(value, operator) {
            try {
                const res = search.create({
                    type: 'account',
                    filters: [['name', operator, value], 'AND', ['type', 'anyof', 'Expense'], 'AND', ['isinactive', 'is', 'F']],
                    columns: ['internalid']
                }).run().getRange({ start: 0, end: 1 });
                return res.length ? res[0].id : null;
            } catch (e) {
                log.debug('findExpenseAccountByName', value + ': ' + e.message);
                return null;
            }
        }

        function ensureSettlementFeeItem(ctx, section) {
            try {
                let id = findByExternalId('item', FEE_ITEM.extid);
                if (id) {
                    addRow(section, 'exists', 'Item ' + FEE_ITEM.name + ' (non-inventory, purchase)', 'noninventorypurchaseitem', id);
                    return parseInt(id, 10);
                }
                id = findItemByName(FEE_ITEM.name);
                if (id) {
                    try {
                        record.submitFields({ type: 'noninventorypurchaseitem', id: id, values: { externalid: FEE_ITEM.extid } });
                    } catch (eAdopt) {
                        log.debug('ensureSettlementFeeItem', 'Could not stamp externalid on item ' + id + ': ' + eAdopt.message);
                    }
                    addRow(section, 'exists', 'Item ' + FEE_ITEM.name + ' (matched by name)', 'noninventorypurchaseitem', id);
                    return parseInt(id, 10);
                }
                const item = record.create({ type: 'noninventorypurchaseitem', isDynamic: false });
                item.setValue({ fieldId: 'itemid', value: FEE_ITEM.name });
                item.setValue({ fieldId: 'externalid', value: FEE_ITEM.extid });
                setSubsidiaryField(item, [ctx.usSubId, ctx.caSubId]);
                if (ctx.settleExpAcctId) {
                    try {
                        item.setValue({ fieldId: 'expenseaccount', value: ctx.settleExpAcctId });
                    } catch (eAcct) {
                        log.debug('ensureSettlementFeeItem', 'expenseaccount not set: ' + eAcct.message);
                    }
                }
                id = item.save({ ignoreMandatoryFields: true });
                addRow(section, 'created', 'Item ' + FEE_ITEM.name + ' (non-inventory, purchase)', 'noninventorypurchaseitem', id);
                return parseInt(id, 10);
            } catch (e) {
                addRow(section, 'error', 'Item ' + FEE_ITEM.name + ': ' + e.message);
                log.error('ensureSettlementFeeItem', e.message);
                return null;
            }
        }

        // ─── Group 2: locations ───────────────────────────────────────────────

        function seedLocations(ctx, out) {
            const section = newSection(out, 'Group 2 - Locations');
            LOCATIONS.forEach(function(spec) {
                ensureLocation(ctx, spec, section);
            });
        }

        function locationSpec(key) {
            return LOCATIONS.filter(function(l) { return l.key === key; })[0];
        }

        function ensureLocation(ctx, spec, section) {
            if (ctx.locIds[spec.key]) {
                if (section) addRow(section, 'exists', 'Location ' + spec.name + ' (ensured earlier in this run)', 'location', ctx.locIds[spec.key]);
                return ctx.locIds[spec.key];
            }
            try {
                let id = findByExternalId('location', spec.extid);
                if (id) {
                    ctx.locIds[spec.key] = parseInt(id, 10);
                    if (section) addRow(section, 'exists', 'Location ' + spec.name, 'location', id);
                    return ctx.locIds[spec.key];
                }
                const subId = spec.sub === 'CA' ? ctx.caSubId : ctx.usSubId;
                try {
                    const loc = record.create({ type: 'location', isDynamic: false });
                    loc.setValue({ fieldId: 'name', value: spec.name });
                    loc.setValue({ fieldId: 'subsidiary', value: subId }); // single-select on Location (unlike Item)
                    loc.setValue({ fieldId: 'externalid', value: spec.extid });
                    id = loc.save({ ignoreMandatoryFields: true });
                } catch (eCreate) {
                    // A same-named location may already exist without our externalid — adopt it.
                    id = findLocationByName(spec.name);
                    if (!id) throw eCreate;
                    try {
                        record.submitFields({ type: 'location', id: id, values: { externalid: spec.extid } });
                    } catch (eAdopt) {
                        log.debug('ensureLocation', 'Could not stamp externalid on location ' + id + ': ' + eAdopt.message);
                    }
                    ctx.locIds[spec.key] = parseInt(id, 10);
                    if (section) addRow(section, 'exists', 'Location ' + spec.name + ' (matched by name)', 'location', id);
                    return ctx.locIds[spec.key];
                }
                ctx.locIds[spec.key] = parseInt(id, 10);
                if (section) addRow(section, 'created', 'Location ' + spec.name + ' (' + (spec.sub === 'CA' ? CA_SUB_NAME : US_SUB_NAME) + ')', 'location', id);
                return ctx.locIds[spec.key];
            } catch (e) {
                if (section) addRow(section, 'error', 'Location ' + spec.name + ': ' + e.message);
                log.error('ensureLocation', spec.name + ': ' + e.message);
                return null;
            }
        }

        function findLocationByName(name) {
            try {
                const res = search.create({
                    type: 'location',
                    filters: [['name', 'is', name]],
                    columns: ['internalid']
                }).run().getRange({ start: 0, end: 1 });
                return res.length ? res[0].id : null;
            } catch (e) {
                return null;
            }
        }

        // ─── Group 3: grade items ─────────────────────────────────────────────

        function seedItems(ctx, out) {
            const section = newSection(out, 'Group 3 - Items (grades)');
            const existing = findExistingByExternalIds('item', pluck(GRADE_ITEMS, 'extid'));
            GRADE_ITEMS.forEach(function(spec) {
                ensureGradeItem(ctx, spec, existing[spec.extid] || null, section);
            });

            // Units of measure: type 5 = Lbs. Applied as its own pass so a
            // NetSuite refusal (units type is locked once an item has
            // transactions) can never break the regular item-field updates.
            GRADE_ITEMS.forEach(function(spec) {
                const itemId = ctx.itemIds[spec.key];
                if (!itemId) return;
                try {
                    const lk = search.lookupFields({ type: 'item', id: itemId, columns: ['unitstype'] });
                    const cur = Array.isArray(lk.unitstype) && lk.unitstype.length ? String(lk.unitstype[0].value) : '';
                    if (cur === '5') {
                        addRow(section, 'exists', 'Item ' + spec.name + ' - units type already Lbs (5)', 'item', itemId);
                        return;
                    }
                    record.submitFields({ type: LOT_ITEM_TYPE, id: itemId, values: { unitstype: 5 } });
                    addRow(section, 'updated', 'Item ' + spec.name + ' - units type set to Lbs (5)', 'item', itemId);
                } catch (eUnits) {
                    addRow(section, 'error', 'Item ' + spec.name + ' - units type NOT changed: ' + errText(eUnits)
                        + ' (NetSuite locks units type once an item has transactions - change requires zero-transaction items or manual UI edit)');
                }
            });
        }

        function applyGradeItemFields(item, spec, ctx) {
            setSubsidiaryField(item, [ctx.usSubId, ctx.caSubId]); // both subs (multiselect)
            item.setValue({ fieldId: 'custitem_sust_is_scrap_material', value: spec.scrap === true });
            item.setText({ fieldId: 'custitem_sust_material_category', text: spec.category });
            item.setText({ fieldId: 'custitem_sust_cost_alloc_class', text: spec.allocClass });
            if (spec.marketSource) {
                item.setText({ fieldId: 'custitem_sust_market_price_source', text: spec.marketSource });
            }
            if (spec.typicalRecovery !== null && spec.typicalRecovery !== undefined) {
                item.setValue({ fieldId: 'custitem_sust_typical_recovery', value: spec.typicalRecovery }); // PERCENT: 0-100
            }
            if (spec.stdBaleLbs) {
                try { item.setValue({ fieldId: 'custitem_sust_std_bale_lbs', value: spec.stdBaleLbs }); }
                catch (eBale) { log.debug('std bale weight skipped', eBale.message); }
            }
        }

        function ensureGradeItem(ctx, spec, existingId, section) {
            try {
                if (existingId) {
                    const existingItem = record.load({ type: LOT_ITEM_TYPE, id: existingId, isDynamic: false });
                    applyGradeItemFields(existingItem, spec, ctx);
                    existingItem.save({ ignoreMandatoryFields: true });
                    ctx.itemIds[spec.key] = parseInt(existingId, 10);
                    addRow(section, 'updated', 'Item ' + spec.name, LOT_ITEM_TYPE, existingId);
                    return;
                }

                // A same-named item may already exist without our externalid — adopt it.
                const byNameId = findItemByName(spec.name);
                if (byNameId) {
                    let adopted;
                    try {
                        adopted = record.load({ type: LOT_ITEM_TYPE, id: byNameId, isDynamic: false });
                    } catch (eLoad) {
                        addRow(section, 'error', 'Item ' + spec.name + ': an item with this name already exists (id ' + byNameId
                            + ') but is not a lot-numbered inventory item - rename or remove it, then re-run');
                        return;
                    }
                    adopted.setValue({ fieldId: 'externalid', value: spec.extid });
                    applyGradeItemFields(adopted, spec, ctx);
                    adopted.save({ ignoreMandatoryFields: true });
                    ctx.itemIds[spec.key] = parseInt(byNameId, 10);
                    addRow(section, 'updated', 'Item ' + spec.name + ' (adopted existing item by name)', LOT_ITEM_TYPE, byNameId);
                    return;
                }

                const item = record.create({ type: LOT_ITEM_TYPE, isDynamic: false });
                item.setValue({ fieldId: 'itemid', value: spec.name });
                item.setValue({ fieldId: 'externalid', value: spec.extid });
                applyGradeItemFields(item, spec, ctx);
                let id;
                try {
                    id = item.save({ ignoreMandatoryFields: true });
                } catch (eFirstSave) {
                    // The account may require GL accounts at item creation — retry once with defaults.
                    log.audit('ensureGradeItem', spec.name + ': first save failed (' + eFirstSave.message + ') - retrying with default GL accounts');
                    const d = getItemAccountDefaults(ctx);
                    if (d.asset) item.setValue({ fieldId: 'assetaccount', value: d.asset });
                    if (d.cogs) item.setValue({ fieldId: 'cogsaccount', value: d.cogs });
                    if (d.income) item.setValue({ fieldId: 'incomeaccount', value: d.income });
                    id = item.save({ ignoreMandatoryFields: true }); // a second failure lands in the outer catch
                }
                ctx.itemIds[spec.key] = parseInt(id, 10);
                addRow(section, 'created', 'Item ' + spec.name + ' (lot-numbered)', LOT_ITEM_TYPE, id);
            } catch (e) {
                addRow(section, 'error', 'Item ' + spec.name + ': ' + e.message);
                log.error('ensureGradeItem', spec.name + ': ' + e.message);
            }
        }

        function getItemAccountDefaults(ctx) {
            if (ctx.itemDefaults) return ctx.itemDefaults;
            const out = { asset: null, cogs: null, income: null, source: 'account-type lookup' };
            const cloneTypes = [LOT_ITEM_TYPE, 'inventoryitem'];
            for (let i = 0; i < cloneTypes.length && !out.asset; i++) {
                try {
                    const res = search.create({
                        type: cloneTypes[i],
                        filters: [['isinactive', 'is', 'F']],
                        columns: ['internalid']
                    }).run().getRange({ start: 0, end: 1 });
                    if (res.length) {
                        const ref = record.load({ type: cloneTypes[i], id: res[0].getValue({ name: 'internalid' }) });
                        out.asset = ref.getValue({ fieldId: 'assetaccount' });
                        out.cogs = ref.getValue({ fieldId: 'cogsaccount' });
                        out.income = ref.getValue({ fieldId: 'incomeaccount' });
                        out.source = 'cloned from existing ' + cloneTypes[i];
                    }
                } catch (e) {
                    log.debug('getItemAccountDefaults', cloneTypes[i] + ': ' + e.message);
                }
            }
            if (!out.asset) out.asset = findAccountIdByType(['OthCurrAsset', 'FixedAsset', 'Bank']);
            if (!out.cogs) out.cogs = findAccountIdByType(['COGS', 'Expense', 'OthExpense']);
            if (!out.income) out.income = findAccountIdByType(['Income', 'OthIncome']);
            log.audit('getItemAccountDefaults', 'Item GL defaults ' + out.source
                + ' (asset ' + out.asset + ', cogs ' + out.cogs + ', income ' + out.income + ')');
            ctx.itemDefaults = out;
            return out;
        }

        function findAccountIdByType(types) {
            try {
                const res = search.create({
                    type: 'account',
                    filters: [['type', 'anyof'].concat(types), 'AND', ['isinactive', 'is', 'F']],
                    columns: ['internalid']
                }).run().getRange({ start: 0, end: 1 });
                return res.length ? res[0].id : null;
            } catch (e) {
                return null;
            }
        }

        function findItemByName(name) {
            try {
                const res = search.create({
                    type: 'item',
                    filters: [['itemid', 'is', name]],
                    columns: ['internalid']
                }).run().getRange({ start: 0, end: 1 });
                return res.length ? res[0].id : null;
            } catch (e) {
                return null;
            }
        }

        // ─── Group 4: entities ────────────────────────────────────────────────

        function seedEntities(ctx, out) {
            const section = newSection(out, 'Group 4 - Entities');
            ctx.vendorId = ensureEntity({
                recordType: 'vendor', label: 'Vendor',
                name: VENDOR.name, extid: VENDOR.extid, subId: ctx.usSubId
            }, section) || ctx.vendorId;
            ctx.customerId = ensureEntity({
                recordType: 'customer', label: 'Customer',
                name: CUSTOMER.name, extid: CUSTOMER.extid, subId: ctx.usSubId
            }, section) || ctx.customerId;

            // Settlement cadence: make the demo vendor Weekly so receipts in the
            // same ISO week roll into one aggregated draft settlement.
            if (ctx.vendorId) {
                try {
                    const v = record.load({ type: 'vendor', id: ctx.vendorId });
                    const current = v.getText({ fieldId: 'custentity_sust_settlement_cadence' }) || '';
                    if (!current) {
                        v.setText({ fieldId: 'custentity_sust_settlement_cadence', text: 'Weekly' });
                        v.save({ ignoreMandatoryFields: true });
                        addRow(section, 'created', 'Vendor ' + VENDOR.name + ' settlement cadence -> Weekly', 'vendor', ctx.vendorId);
                    } else {
                        addRow(section, 'exists', 'Vendor ' + VENDOR.name + ' settlement cadence already ' + current, 'vendor', ctx.vendorId);
                    }
                } catch (eCad) {
                    addRow(section, 'error', 'Vendor cadence: ' + eCad.message);
                    log.error('seedEntities cadence', eCad.message);
                }
            }
        }

        function ensureEntity(spec, section) {
            try {
                let id = findByExternalId(spec.recordType, spec.extid);
                if (id) {
                    addRow(section, 'exists', spec.label + ' ' + spec.name, spec.recordType, id);
                    return parseInt(id, 10);
                }
                id = findEntityByCompanyName(spec.recordType, spec.name);
                if (id) {
                    try {
                        record.submitFields({ type: spec.recordType, id: id, values: { externalid: spec.extid } });
                    } catch (eAdopt) {
                        log.debug('ensureEntity', 'Could not stamp externalid on ' + spec.recordType + ' ' + id + ': ' + eAdopt.message);
                    }
                    addRow(section, 'exists', spec.label + ' ' + spec.name + ' (matched by name)', spec.recordType, id);
                    return parseInt(id, 10);
                }
                const ent = record.create({ type: spec.recordType, isDynamic: false });
                ent.setValue({ fieldId: 'entityid', value: spec.name });
                ent.setValue({ fieldId: 'companyname', value: spec.name });
                ent.setValue({ fieldId: 'isperson', value: 'F' });
                try {
                    ent.setValue({ fieldId: 'subsidiary', value: spec.subId });
                } catch (eSub) {
                    log.debug('ensureEntity', 'subsidiary not set on ' + spec.recordType + ': ' + eSub.message);
                }
                ent.setValue({ fieldId: 'externalid', value: spec.extid });
                id = ent.save({ ignoreMandatoryFields: true });
                addRow(section, 'created', spec.label + ' ' + spec.name + ' (' + US_SUB_NAME + ')', spec.recordType, id);
                return parseInt(id, 10);
            } catch (e) {
                addRow(section, 'error', spec.label + ' ' + spec.name + ': ' + e.message);
                log.error('ensureEntity', spec.name + ': ' + e.message);
                return null;
            }
        }

        function findEntityByCompanyName(searchType, name) {
            try {
                const res = search.create({
                    type: searchType,
                    filters: [['companyname', 'is', name], 'AND', ['isinactive', 'is', 'F']],
                    columns: ['internalid']
                }).run().getRange({ start: 0, end: 1 });
                return res.length ? res[0].id : null;
            } catch (e) {
                return null;
            }
        }

        // ─── Group 5: index prices ────────────────────────────────────────────

        function seedIndexPrices(ctx, out) {
            const section = newSection(out, 'Group 5 - Index prices (RISI, $/ton)');
            INDEX_PRICES.forEach(function(idx) {
                let okCount = 0;
                let failCount = 0;
                let lastId = null;
                idx.values.forEach(function(pricePerTon, i) {
                    const effectiveDate = new Date(INDEX_START.year, INDEX_START.month + i, 1);
                    // Correction month guard: the last WL month is deliberately
                    // corrected (+$6). Once that correction is active, re-seeding
                    // the base value would "correct" it back down and ping-pong a
                    // new correction pair on every run — skip it instead.
                    if (idx.sourceText === 'RISI White Ledger' && i === idx.values.length - 1) {
                        const active = marketPriceLib.getPriceForDate(idx.sourceText, effectiveDate);
                        const correctedPerLb = (pricePerTon + 6) / 2000;
                        if (active && Math.abs(active.pricePerLb - correctedPerLb) < 0.0000001) {
                            okCount++;
                            return; // correction already in place — leave the chain alone
                        }
                    }
                    // The lib upserts by date + source and converts $/ton → $/lb.
                    const savedId = marketPriceLib.storeIndexPrice({
                        sourceText: idx.sourceText,
                        date: effectiveDate,
                        pricePerTon: pricePerTon
                    });
                    if (savedId) {
                        okCount++;
                        lastId = savedId;
                    } else {
                        failCount++;
                    }
                });
                // Correction/version-control example: the last published month of
                // RISI White Ledger is corrected upward. storeIndexPrice detects the
                // changed value, keeps the original (superseded), and creates a
                // correction record — original vs corrected stays visible.
                if (idx.sourceText === 'RISI White Ledger') {
                    const lastIdx = idx.values.length - 1;
                    const corrDate = new Date(INDEX_START.year, INDEX_START.month + lastIdx, 1);
                    const corrId = marketPriceLib.storeIndexPrice({
                        sourceText: idx.sourceText,
                        date: corrDate,
                        pricePerTon: idx.values[lastIdx] + 6   // published correction +$6/ton
                    });
                    if (corrId) {
                        addRow(section, 'updated', idx.sourceText + ' ' + formatDate(corrDate)
                            + ': CORRECTION staged $' + idx.values[lastIdx] + ' -> $' + (idx.values[lastIdx] + 6)
                            + '/ton (original kept, superseded)', MARKET_PRICE_TYPE, corrId);
                    }
                }
                const rangeText = formatDate(new Date(INDEX_START.year, INDEX_START.month, 1))
                    + ' - ' + formatDate(new Date(INDEX_START.year, INDEX_START.month + idx.values.length - 1, 1));
                if (failCount === 0) {
                    addRow(section, 'updated', idx.sourceText + ': ' + okCount + ' monthly values stored/updated (' + rangeText + ')', MARKET_PRICE_TYPE, lastId);
                } else {
                    addRow(section, 'error', idx.sourceText + ': ' + okCount + ' stored, ' + failCount + ' failed - see the script execution log', lastId ? MARKET_PRICE_TYPE : null, lastId);
                }
            });
        }

        function formatDate(d) {
            try {
                return format.format({ value: d, type: format.Type.DATE });
            } catch (e) {
                return String(d);
            }
        }

        // ─── Group 6: settlement schedules ────────────────────────────────────

        function seedSchedules(ctx, out) {
            const section = newSection(out, 'Group 6 - Settlement schedules');
            const vendorId = resolveVendorId(ctx);
            const customerId = resolveCustomerId(ctx);
            const wlId = resolveItemId(ctx, 'WL');
            const sopId = resolveItemId(ctx, 'SOP');

            if (vendorId && wlId) {
                const supplierSchedId = ensureSchedule({
                    label: 'Supplier schedule: ' + VENDOR.name + ' / White Ledger - Purchase, % of Index (100% of RISI White Ledger - $0.0075/lb)',
                    entityField: 'custrecord_sust_schedule_vendor',
                    entityId: vendorId,
                    itemId: wlId,
                    direction: 'Purchase',
                    marketRef: 'RISI White Ledger',
                    marketPct: 100,
                    marketAdj: -0.0075
                }, section);
                seedPenalties(supplierSchedId, section);
            } else {
                addRow(section, 'error', 'Supplier schedule skipped - missing '
                    + missingList([[vendorId, 'vendor (run the Entities group)'], [wlId, 'White Ledger item (run the Items group)']]));
            }

            // MOP purchase schedule: the target when a WL lot is regraded to
            // Mixed Office Paper — the regrade/settlement re-price lands here.
            const mopId = resolveItemId(ctx, 'MOP');
            if (vendorId && mopId) {
                ensureSchedule({
                    label: 'Supplier schedule: ' + VENDOR.name + ' / Mixed Office Paper - Purchase, % of Index (100% of RISI Mixed Office Paper - $0.0075/lb)',
                    entityField: 'custrecord_sust_schedule_vendor',
                    entityId: vendorId,
                    itemId: mopId,
                    direction: 'Purchase',
                    marketRef: 'RISI Mixed Office Paper',
                    marketPct: 100,
                    marketAdj: -0.0075
                }, section);
            } else {
                addRow(section, 'error', 'MOP supplier schedule skipped - missing '
                    + missingList([[vendorId, 'vendor (run the Entities group)'], [mopId, 'Mixed Office Paper item (run the Items group)']]));
            }

            if (customerId && sopId) {
                ensureSchedule({
                    label: 'Customer schedule: ' + CUSTOMER.name + ' / SOP - Sale, % of Index (100% of RISI SOP + $0.005/lb)',
                    entityField: 'custrecord_sust_sched_customer',
                    entityId: customerId,
                    itemId: sopId,
                    direction: 'Sale',
                    marketRef: 'RISI SOP',
                    marketPct: 100,
                    marketAdj: 0.005
                }, section);
            } else {
                addRow(section, 'error', 'Customer schedule skipped - missing '
                    + missingList([[customerId, 'customer (run the Entities group)'], [sopId, 'SOP item (run the Items group)']]));
            }
        }

        function ensureSchedule(spec, section) {
            try {
                const existingId = findScheduleByNaturalKey(spec.entityField, spec.entityId, spec.itemId, spec.direction);
                let sched;
                let action = 'updated';
                if (existingId) {
                    sched = record.load({ type: SCHEDULE_TYPE, id: existingId });
                } else {
                    sched = record.create({ type: SCHEDULE_TYPE });
                    action = 'created';
                }
                sched.setValue({ fieldId: spec.entityField, value: spec.entityId });
                sched.setValue({ fieldId: 'custrecord_sust_schedule_item', value: spec.itemId });
                sched.setText({ fieldId: 'custrecord_sust_sched_direction', text: spec.direction });
                sched.setText({ fieldId: 'custrecord_sust_schedule_method', text: '% of Index' });
                sched.setText({ fieldId: 'custrecord_sust_schedule_market_ref', text: spec.marketRef });
                sched.setValue({ fieldId: 'custrecord_sust_schedule_market_pct', value: spec.marketPct }); // PERCENT: 0-100
                sched.setValue({ fieldId: 'custrecord_sust_schedule_market_adj', value: spec.marketAdj }); // $/lb
                sched.setValue({ fieldId: 'custrecord_sust_schedule_active', value: true });
                sched.setValue({ fieldId: 'custrecord_sust_schedule_effective_date', value: new Date(INDEX_START.year, INDEX_START.month, 1) });
                const id = sched.save();
                addRow(section, action, spec.label, SCHEDULE_TYPE, id);
                return id;
            } catch (e) {
                addRow(section, 'error', spec.label + ': ' + e.message);
                log.error('ensureSchedule', spec.label + ': ' + e.message);
                return null;
            }
        }

        // ─── Group 6b: quality-deduction / penalty definitions (children of a schedule) ──
        // Penalty RULES live on the settlement SCHEDULE. The Settlement Calculator applies
        // them when a lot's measured moisture/contamination exceeds the threshold. Element
        // text must be exactly 'Moisture %' / 'Contamination %' or the calculator skips it.
        const SUPPLIER_PENALTIES = [
            { element: 'Moisture %',      threshold: 12, rate: 0.001, calc: 'Per Percentage Point' },
            { element: 'Contamination %', threshold: 5,  rate: 0.002, calc: 'Per Percentage Point' }
        ];

        function seedPenalties(scheduleId, section) {
            if (!scheduleId) return;
            SUPPLIER_PENALTIES.forEach(function(spec) {
                try {
                    if (findPenaltyByKey(scheduleId, spec.element)) {
                        addRow(section, 'exists', 'Penalty rule: ' + spec.element + ' > ' + spec.threshold + '% (already defined)',
                            'customrecord_sust_settlement_penalty', null);
                        return;
                    }
                    const pen = record.create({ type: 'customrecord_sust_settlement_penalty' });
                    pen.setValue({ fieldId: 'custrecord_sust_penalty_schedule', value: scheduleId });
                    pen.setText({ fieldId: 'custrecord_sust_penalty_element', text: spec.element });
                    pen.setValue({ fieldId: 'custrecord_sust_penalty_threshold', value: spec.threshold }); // PERCENT 0-100
                    pen.setValue({ fieldId: 'custrecord_sust_penalty_rate', value: spec.rate });           // $/lb per point
                    pen.setText({ fieldId: 'custrecord_sust_penalty_calculation', text: spec.calc });
                    const id = pen.save();
                    addRow(section, 'created', 'Penalty rule: ' + spec.element + ' > ' + spec.threshold + '% @ $' + spec.rate + '/lb/pt (' + spec.calc + ')',
                        'customrecord_sust_settlement_penalty', id);
                } catch (e) {
                    addRow(section, 'error', 'Penalty rule ' + spec.element + ': ' + e.message);
                    log.error('seedPenalties', spec.element + ': ' + e.message);
                }
            });
        }

        function findPenaltyByKey(scheduleId, elementText) {
            try {
                let found = null;
                search.create({
                    type: 'customrecord_sust_settlement_penalty',
                    filters: [['custrecord_sust_penalty_schedule', 'anyof', scheduleId]],
                    columns: ['internalid', 'custrecord_sust_penalty_element']
                }).run().each(function(res) {
                    if ((res.getText({ name: 'custrecord_sust_penalty_element' }) || '') === elementText) {
                        found = parseInt(res.id, 10);
                        return false;
                    }
                    return true;
                });
                return found;
            } catch (e) {
                log.error('findPenaltyByKey', e.message);
                return null;
            }
        }

        /**
         * Custom records carry no externalid — the schedule natural key is
         * vendor/customer + item + direction (matched by display text; a blank
         * direction on a legacy record counts as Purchase, the default).
         */
        function findScheduleByNaturalKey(entityField, entityId, itemId, directionText) {
            try {
                let found = null;
                search.create({
                    type: SCHEDULE_TYPE,
                    filters: [
                        [entityField, 'anyof', entityId], 'AND',
                        ['custrecord_sust_schedule_item', 'anyof', itemId], 'AND',
                        ['isinactive', 'is', 'F']
                    ],
                    columns: ['internalid', 'custrecord_sust_sched_direction']
                }).run().each(function(res) {
                    const dirText = res.getText({ name: 'custrecord_sust_sched_direction' }) || '';
                    if (dirText === directionText || (directionText === 'Purchase' && !dirText)) {
                        found = parseInt(res.id, 10);
                        return false;
                    }
                    return true;
                });
                return found;
            } catch (e) {
                log.error('findScheduleByNaturalKey', e.message);
                return null;
            }
        }

        // ─── Group 7: open PO-10001 ───────────────────────────────────────────

        function seedOpenPO(ctx, out) {
            const section = newSection(out, 'Group 7 - Open purchase orders');
            seedExtraPOs(ctx, section);
            try {
                const existingId = findByExternalId('purchaseorder', PO_EXTID);
                if (existingId) {
                    addRow(section, 'exists', 'PO-10001 already seeded - left untouched (keep it open/un-received for the receiving demo)', 'purchaseorder', existingId);
                    return;
                }
                const vendorId = resolveVendorId(ctx);
                const wlId = resolveItemId(ctx, 'WL');
                const cinciId = resolveLocationId(ctx, 'CINCINNATI');
                if (!vendorId || !wlId) {
                    addRow(section, 'error', 'PO-10001 skipped - missing '
                        + missingList([[vendorId, 'vendor (run the Entities group)'], [wlId, 'White Ledger item (run the Items group)']]));
                    return;
                }

                const po = record.create({ type: 'purchaseorder', isDynamic: true });
                po.setValue({ fieldId: 'entity', value: vendorId });
                try {
                    po.setValue({ fieldId: 'subsidiary', value: ctx.usSubId });
                } catch (eSub) {
                    log.debug('seedOpenPO', 'subsidiary sourced from vendor: ' + eSub.message);
                }
                if (cinciId) {
                    try {
                        po.setValue({ fieldId: 'location', value: cinciId });
                    } catch (eLoc) {
                        log.debug('seedOpenPO', 'header location not set: ' + eLoc.message);
                    }
                }
                po.setValue({ fieldId: 'trandate', value: new Date() });
                try {
                    po.setValue({ fieldId: 'tranid', value: 'PO-10001' });
                } catch (eTranid) {
                    log.debug('seedOpenPO', 'tranid override not allowed: ' + eTranid.message);
                }
                po.setText({ fieldId: 'custbody_sust_pricing_timing', text: 'Determined on Arrival' });
                po.setValue({ fieldId: 'memo', value: 'Sustana demo - inbound White Ledger; pricing determined on arrival (rate is a provisional estimate)' });
                po.setValue({ fieldId: 'externalid', value: PO_EXTID });

                po.selectNewLine({ sublistId: 'item' });
                po.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: wlId });
                po.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: 40000 }); // lbs
                po.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate', value: 0.15 });       // provisional ≈ index − $15/ton
                if (cinciId) {
                    try {
                        po.setCurrentSublistValue({ sublistId: 'item', fieldId: 'location', value: cinciId });
                    } catch (eLineLoc) {
                        log.debug('seedOpenPO', 'line location not set: ' + eLineLoc.message);
                    }
                }
                po.commitLine({ sublistId: 'item' });

                const id = po.save({ ignoreMandatoryFields: true, enableSourcing: true });
                addRow(section, 'created', 'PO-10001 - ' + VENDOR.name + ', 40,000 lbs White Ledger @ $0.15/lb, pricing "Determined on Arrival" (OPEN - do not receive before the demo)', 'purchaseorder', id);
            } catch (e) {
                addRow(section, 'error', 'PO-10001: ' + e.message);
                log.error('seedOpenPO', e.message + '\n' + e.stack);
            }
        }

        // ─── Group 8: on-hand lots (inventory adjustment) ─────────────────────

        function seedOnHandLots(ctx, out) {
            const section = newSection(out, 'Group 8 - On-hand lots (inventory adjustment)');
            try {
                const existingId = findByExternalId('inventoryadjustment', IA_EXTID);
                if (existingId) {
                    addRow(section, 'exists', 'On-hand adjustment already seeded (inventory adjustments are not safely re-runnable) - re-applying lot quality fields only', 'inventoryadjustment', existingId);
                    ONHAND_LOTS.forEach(function(lotSpec) {
                        updateSeededLot(lotSpec, section);
                    });
                    // BUG FIX: this early return previously skipped the multi-site
                    // yard variety lots on any account where the Cincinnati IA
                    // already existed — dashboards stayed Cincinnati-only.
                    seedYardVarietyLots(ctx, section);
                    return;
                }
                const cinciId = resolveLocationId(ctx, 'CINCINNATI');
                if (!cinciId) {
                    addRow(section, 'error', 'Skipped - Cincinnati location not found (run the Locations group first)');
                    return;
                }
                const acctId = resolveInvAdjAccountId(ctx);
                if (!acctId) {
                    addRow(section, 'error', 'Skipped - no Inventory Adjustment account configured (run the Config group first)');
                    return;
                }

                const lines = [];
                ONHAND_LOTS.forEach(function(lotSpec) {
                    const itemId = resolveItemId(ctx, lotSpec.itemKey);
                    if (itemId) {
                        lines.push({ spec: lotSpec, itemId: itemId });
                    } else {
                        addRow(section, 'error', 'Lot ' + lotSpec.lot + ' skipped - item not found (run the Items group first)');
                    }
                });
                if (!lines.length) {
                    addRow(section, 'error', 'No adjustment lines could be built - nothing saved');
                    return;
                }

                const ia = record.create({ type: 'inventoryadjustment', isDynamic: false });
                // Header order matters (OneWorld sources location by subsidiary):
                // trandate → subsidiary → adjlocation → account → memo
                ia.setValue({ fieldId: 'trandate', value: new Date() });
                ia.setValue({ fieldId: 'subsidiary', value: ctx.usSubId });
                ia.setValue({ fieldId: 'adjlocation', value: cinciId });
                ia.setValue({ fieldId: 'account', value: acctId });
                ia.setValue({ fieldId: 'memo', value: 'Sustana demo - on-hand yard lots for the processing scenario' });
                ia.setValue({ fieldId: 'externalid', value: IA_EXTID });

                lines.forEach(function(entry, i) {
                    const l = entry.spec;
                    // Line order: item → adjustqtyby → location
                    ia.setSublistValue({ sublistId: 'inventory', fieldId: 'item', line: i, value: entry.itemId });
                    ia.setSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', line: i, value: l.qty });
                    ia.setSublistValue({ sublistId: 'inventory', fieldId: 'location', line: i, value: cinciId });
                    ia.setSublistValue({ sublistId: 'inventory', fieldId: 'unitcost', line: i, value: l.unitCost });
                    const detail = ia.getSublistSubrecord({ sublistId: 'inventory', fieldId: 'inventorydetail', line: i });
                    // New lots: receiptinventorynumber takes the lot-number STRING + positive quantity
                    detail.setSublistValue({ sublistId: 'inventoryassignment', fieldId: 'receiptinventorynumber', line: 0, value: l.lot });
                    detail.setSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', line: 0, value: l.qty });
                });

                const iaId = ia.save({ ignoreMandatoryFields: true });
                addRow(section, 'created', 'Inventory adjustment - ' + lines.length + ' new lots on hand at Cincinnati', 'inventoryadjustment', iaId);

                // Two-stage lot update: the IA save auto-created the lot records;
                // find each by its number string, then load + set quality fields.
                lines.forEach(function(entry) {
                    updateSeededLot(entry.spec, section);
                });
            } catch (e) {
                addRow(section, 'error', 'On-hand adjustment: ' + e.message);
                log.error('seedOnHandLots', e.message + '\n' + e.stack);
            }

            seedYardVarietyLots(ctx, section);
        }

        /** Human-readable error text even when e.message is a null Java object. */
        function errText(e) {
            try {
                const parts = [];
                if (e && e.name && String(e.name).indexOf('ScriptNullObjectAdapter') === -1) parts.push(String(e.name));
                if (e && e.message && String(e.message).indexOf('ScriptNullObjectAdapter') === -1) parts.push(String(e.message));
                if (!parts.length && e && e.toString && String(e.toString()).indexOf('ScriptNullObjectAdapter') === -1) parts.push(String(e.toString()));
                if (!parts.length) {
                    try { parts.push(JSON.stringify(e)); } catch (eJson) { parts.push('unidentifiable NetSuite error (null message)'); }
                }
                return parts.join(': ');
            } catch (eFmt) {
                return 'unidentifiable NetSuite error';
            }
        }

        /**
         * Multi-site yard lots (one IA per site) with mixed statuses, quality,
         * and received-date ages — populates the Yard Operations Dashboard's
         * site matrix, charts, and every exception rule.
         */
        function seedYardVarietyLots(ctx, section) {
            const bySite = {};
            YARD_VARIETY_LOTS.forEach(function(spec) {
                if (!bySite[spec.site]) bySite[spec.site] = [];
                bySite[spec.site].push(spec);
            });
            Object.keys(bySite).forEach(function(siteKey) {
                const extid = EXT_PREFIX + 'IA_YARD_' + siteKey;
                try {
                    const existing = findByExternalId('inventoryadjustment', extid);
                    if (existing) {
                        addRow(section, 'exists', 'Yard variety lots at ' + siteKey + ' already seeded - re-applying lot fields only', 'inventoryadjustment', existing);
                        bySite[siteKey].forEach(function(spec) { updateYardVarietyLot(spec, section); });
                        return;
                    }
                    const locId = resolveLocationId(ctx, siteKey);
                    const acctId = resolveInvAdjAccountId(ctx);
                    const locSpec = LOCATIONS.filter(function(l) { return l.key === siteKey; })[0];
                    const subId = (locSpec && locSpec.sub === 'CA') ? ctx.caSubId : ctx.usSubId;
                    if (!locId || !acctId || !subId) {
                        addRow(section, 'error', 'Yard lots at ' + siteKey + ' skipped - missing location, IA account, or subsidiary');
                        return;
                    }
                    const lines = [];
                    bySite[siteKey].forEach(function(spec) {
                        const itemId = resolveItemId(ctx, spec.itemKey);
                        if (itemId) lines.push({ spec: spec, itemId: itemId });
                    });
                    if (!lines.length) return;

                    const ia = record.create({ type: 'inventoryadjustment', isDynamic: false });
                    ia.setValue({ fieldId: 'trandate', value: new Date() });
                    ia.setValue({ fieldId: 'subsidiary', value: subId });
                    ia.setValue({ fieldId: 'adjlocation', value: locId });
                    ia.setValue({ fieldId: 'account', value: acctId });
                    ia.setValue({ fieldId: 'memo', value: 'Sustana demo - yard variety lots at ' + siteKey });
                    ia.setValue({ fieldId: 'externalid', value: extid });
                    lines.forEach(function(entry, i) {
                        ia.setSublistValue({ sublistId: 'inventory', fieldId: 'item', line: i, value: entry.itemId });
                        ia.setSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', line: i, value: entry.spec.qty });
                        ia.setSublistValue({ sublistId: 'inventory', fieldId: 'location', line: i, value: locId });
                        ia.setSublistValue({ sublistId: 'inventory', fieldId: 'unitcost', line: i, value: entry.spec.unitCost });
                        const detail = ia.getSublistSubrecord({ sublistId: 'inventory', fieldId: 'inventorydetail', line: i });
                        detail.setSublistValue({ sublistId: 'inventoryassignment', fieldId: 'receiptinventorynumber', line: 0, value: entry.spec.lot });
                        detail.setSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', line: 0, value: entry.spec.qty });
                    });
                    const iaId = ia.save({ ignoreMandatoryFields: true });
                    addRow(section, 'created', 'Yard variety adjustment - ' + lines.length + ' lots at ' + siteKey, 'inventoryadjustment', iaId);
                    lines.forEach(function(entry) { updateYardVarietyLot(entry.spec, section); });
                } catch (e) {
                    const msg = errText(e);
                    addRow(section, 'error', 'Yard lots at ' + siteKey + ': ' + msg
                        + (siteKey === 'LACHINE'
                            ? ' — Lachine posts on the CA subsidiary; if the IA account or items are US-only this site is expected to skip. US sites are unaffected.'
                            : ''));
                    log.error('seedYardVarietyLots', siteKey + ': ' + msg + ' | raw: ' + e);
                }
            });
        }

        function updateYardVarietyLot(spec, section) {
            try {
                const lotId = findLotInternalId(spec.lot);
                if (!lotId) {
                    addRow(section, 'error', 'Lot ' + spec.lot + ': not found after adjustment - fields not set');
                    return;
                }
                const lot = record.load({ type: 'inventorynumber', id: lotId });
                lot.setText({ fieldId: 'custitemnumber_sust_lot_status', text: spec.status });
                lot.setText({ fieldId: 'custitemnumber_sust_lot_source_type', text: 'Purchased' });
                try { lot.setText({ fieldId: 'custitemnumber_sust_lot_form', text: spec.form || 'Loose' }); }
                catch (eForm) { log.debug('lot form skipped', eForm.message); }
                lot.setValue({ fieldId: 'custitemnumber_sust_received_date', value: daysAgo(spec.daysAgo) });
                if (spec.quality) {
                    lot.setValue({ fieldId: 'custitemnumber_sust_moisture_pct', value: spec.quality.moisture });
                    lot.setValue({ fieldId: 'custitemnumber_sust_contamination_pct', value: spec.quality.contamination });
                    lot.setValue({ fieldId: 'custitemnumber_sust_fiber_content_pct', value: spec.quality.fiber });
                    lot.setValue({ fieldId: 'custitemnumber_sust_bale_count', value: spec.quality.bales });
                }
                lot.save();
                addRow(section, 'updated', 'Lot ' + spec.lot + ' - ' + spec.status + ', received ' + spec.daysAgo + 'd ago'
                    + (spec.quality ? '' : ' (ungraded - exception demo)'), 'inventorynumber', lotId);
            } catch (e) {
                addRow(section, 'error', 'Lot ' + spec.lot + ': ' + errText(e));
                log.error('updateYardVarietyLot', spec.lot + ': ' + errText(e));
            }
        }

        function updateSeededLot(lotSpec, section) {
            try {
                const lotId = findLotInternalId(lotSpec.lot);
                if (!lotId) {
                    addRow(section, 'error', 'Lot ' + lotSpec.lot + ': created by the adjustment but not found by search - quality fields not set');
                    return;
                }
                // Lot Status is a custom-list SELECT: needs load + setText + save
                // (submitFields cannot set a list value by display text).
                const lot = record.load({ type: 'inventorynumber', id: lotId });
                lot.setText({ fieldId: 'custitemnumber_sust_lot_status', text: 'Yard' });
                lot.setText({ fieldId: 'custitemnumber_sust_lot_source_type', text: 'Purchased' });
                lot.setValue({ fieldId: 'custitemnumber_sust_bale_count', value: lotSpec.bales });
                lot.setValue({ fieldId: 'custitemnumber_sust_moisture_pct', value: lotSpec.moisture });
                lot.setValue({ fieldId: 'custitemnumber_sust_contamination_pct', value: lotSpec.contamination });
                lot.setValue({ fieldId: 'custitemnumber_sust_fiber_content_pct', value: lotSpec.fiber });
                if (lotSpec.vendorLot) {
                    lot.setValue({ fieldId: 'custitemnumber_sust_vendor_lot_number', value: lotSpec.vendorLot });
                }
                lot.save();
                addRow(section, 'updated', 'Lot ' + lotSpec.lot + ' - status Yard, ' + lotSpec.bales + ' bales, quality fields set'
                    + (lotSpec.vendorLot ? ' (vendor lot ' + lotSpec.vendorLot + ')' : ''), 'inventorynumber', lotId);
            } catch (e) {
                addRow(section, 'error', 'Lot ' + lotSpec.lot + ': ' + e.message);
                log.error('updateSeededLot', lotSpec.lot + ': ' + e.message);
            }
        }

        function findLotInternalId(lotNumber) {
            try {
                const res = search.create({
                    type: 'inventorynumber',
                    filters: [['inventorynumber', 'is', lotNumber]],
                    columns: ['internalid']
                }).run().getRange({ start: 0, end: 1 });
                return res.length ? parseInt(res[0].id, 10) : null;
            } catch (e) {
                log.error('findLotInternalId', lotNumber + ': ' + e.message);
                return null;
            }
        }

        // ─── Group 9: planning scenario (optional) ────────────────────────────

        function seedPlanning(ctx, out) {
            const section = newSection(out, 'Group 9 - Planning scenario (10 SOP loads)');
            const customerId = resolveCustomerId(ctx);
            const sopId = resolveItemId(ctx, 'SOP');
            const cinciId = resolveLocationId(ctx, 'CINCINNATI');
            if (!customerId || !sopId) {
                addRow(section, 'error', 'Group skipped - missing '
                    + missingList([[customerId, 'customer (run the Entities group)'], [sopId, 'SOP item (run the Items group)']]));
                return;
            }

            const soExtids = planningSoExtids();
            const existingSOs = findExistingByExternalIds('salesorder', soExtids);
            soExtids.forEach(function(extid, i) {
                const loadNo = i + 1;
                if (existingSOs[extid]) {
                    addRow(section, 'exists', 'Sales order load ' + loadNo + ' of 10 (' + extid + ')', 'salesorder', existingSOs[extid]);
                    return;
                }
                try {
                    const so = record.create({ type: 'salesorder', isDynamic: true });
                    so.setValue({ fieldId: 'entity', value: customerId });
                    so.setValue({ fieldId: 'trandate', value: new Date() });
                    so.setValue({ fieldId: 'memo', value: 'Sustana demo - planned SOP load ' + loadNo + ' of 10 (line auto-priced from the Sale schedule on save)' });
                    so.setValue({ fieldId: 'externalid', value: extid });
                    addPlanningLine(so, sopId, cinciId);
                    const id = so.save({ ignoreMandatoryFields: true, enableSourcing: true });
                    addRow(section, 'created', 'Sales order load ' + loadNo + ' of 10 - 40,000 lbs SOP (rate left 0; index-priced on save)', 'salesorder', id);
                } catch (e) {
                    addRow(section, 'error', 'Sales order ' + extid + ': ' + e.message);
                    log.error('seedPlanning', extid + ': ' + e.message);
                }
            });

            const existingEsts = findExistingByExternalIds('estimate', pluck(PLANNING_ESTIMATES, 'extid'));
            PLANNING_ESTIMATES.forEach(function(spec, i) {
                const loadNo = 8 + i;
                if (existingEsts[spec.extid]) {
                    addRow(section, 'exists', 'Estimate load ' + loadNo + ' of 10 (' + spec.reason + ')', 'estimate', existingEsts[spec.extid]);
                    return;
                }
                try {
                    const est = record.create({ type: 'estimate', isDynamic: true });
                    est.setValue({ fieldId: 'entity', value: customerId });
                    est.setValue({ fieldId: 'trandate', value: new Date() });
                    est.setValue({ fieldId: 'memo', value: 'Sustana demo - deferred/cancelled SOP load ' + loadNo + ' of 10' });
                    est.setValue({ fieldId: 'externalid', value: spec.extid });
                    try {
                        est.setText({ fieldId: 'custbody_sust_so_reason_code', text: spec.reason });
                    } catch (eReason) {
                        log.error('seedPlanning', spec.extid + ': reason code not set (' + eReason.message + ') - continuing without it');
                    }
                    addPlanningLine(est, sopId, cinciId);
                    const id = est.save({ ignoreMandatoryFields: true, enableSourcing: true });
                    addRow(section, 'created', 'Estimate load ' + loadNo + ' of 10 - ' + spec.reason, 'estimate', id);
                } catch (e) {
                    addRow(section, 'error', 'Estimate ' + spec.extid + ': ' + e.message);
                    log.error('seedPlanning', spec.extid + ': ' + e.message);
                }
            });
        }

        /** The additional open POs (idempotent by externalid). */
        function seedExtraPOs(ctx, section) {
            EXTRA_POS.forEach(function(spec) {
                const extid = EXT_PREFIX + 'PO_' + spec.num.replace('-', '');
                try {
                    const existing = findByExternalId('purchaseorder', extid);
                    if (existing) {
                        addRow(section, 'exists', spec.num + ' already seeded', 'purchaseorder', existing);
                        return;
                    }
                    const vendorId = resolveVendorId(ctx);
                    const itemId = resolveItemId(ctx, spec.itemKey);
                    const locId = resolveLocationId(ctx, spec.site);
                    if (!vendorId || !itemId) {
                        addRow(section, 'error', spec.num + ' skipped - missing vendor or item');
                        return;
                    }
                    const po = record.create({ type: 'purchaseorder', isDynamic: true });
                    po.setValue({ fieldId: 'entity', value: vendorId });
                    try { po.setValue({ fieldId: 'subsidiary', value: ctx.usSubId }); } catch (eS) { /* vendor-sourced */ }
                    if (locId) { try { po.setValue({ fieldId: 'location', value: locId }); } catch (eL) { /* optional */ } }
                    const d = new Date(); d.setDate(d.getDate() + spec.daysOut);
                    po.setValue({ fieldId: 'trandate', value: new Date() });
                    try { po.setValue({ fieldId: 'duedate', value: d }); } catch (eD) { /* optional */ }
                    try { po.setValue({ fieldId: 'tranid', value: spec.num }); } catch (eT) { /* numbering */ }
                    try { po.setText({ fieldId: 'custbody_sust_pricing_timing', text: 'Determined on Arrival' }); } catch (eP) { /* optional */ }
                    po.setValue({ fieldId: 'memo', value: 'Sustana demo - expected inbound ' + spec.itemKey + ' load at ' + spec.site });
                    po.setValue({ fieldId: 'externalid', value: extid });
                    po.selectNewLine({ sublistId: 'item' });
                    po.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: itemId });
                    po.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: spec.qty });
                    po.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate', value: spec.rate });
                    if (locId) { try { po.setCurrentSublistValue({ sublistId: 'item', fieldId: 'location', value: locId }); } catch (eLL) { /* optional */ } }
                    po.commitLine({ sublistId: 'item' });
                    const id = po.save({ ignoreMandatoryFields: true, enableSourcing: true });
                    addRow(section, 'created', spec.num + ' - ' + commasNum(spec.qty) + ' lbs ' + spec.itemKey + ' @ $' + spec.rate + '/lb, ' + spec.site + ' (OPEN)', 'purchaseorder', id);
                } catch (e) {
                    addRow(section, 'error', spec.num + ': ' + errText(e));
                    log.error('seedExtraPOs', spec.num + ': ' + errText(e));
                }
            });
        }

        function commasNum(n) {
            return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        }

        function addPlanningLine(tran, itemId, locationId) {
            tran.selectNewLine({ sublistId: 'item' });
            tran.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: itemId });
            tran.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: PLANNING_QTY_LBS }); // lbs
            try {
                tran.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate', value: 0 });
            } catch (eRate) {
                log.debug('addPlanningLine', 'rate not set: ' + eRate.message);
            }
            if (locationId) {
                try {
                    tran.setCurrentSublistValue({ sublistId: 'item', fieldId: 'location', value: locationId });
                } catch (eLoc) {
                    log.debug('addPlanningLine', 'line location not set: ' + eLoc.message);
                }
            }
            tran.commitLine({ sublistId: 'item' });
        }

        function planningSoExtids() {
            const out = [];
            for (let i = 1; i <= 7; i++) out.push(EXT_PREFIX + 'SO_0' + i);
            return out;
        }

        // ─── Group 10: item output templates (default outputs for Processing Entry) ──
        // Each scrap input grade gets a default recipe: a finished-fiber output at the
        // item's typical recovery %, plus a residual line. The Processing Entry
        // "Load Default Outputs" button reads these to pre-fill output lines.
        const OUTPUT_TEMPLATES = [
            { inputKey: 'WL',  fiberPct: 95, residPct: 3 },
            { inputKey: 'MP',  fiberPct: 90, residPct: 5 },
            { inputKey: 'MOP', fiberPct: 92, residPct: 4 }
        ];

        function seedItemOutputTemplates(ctx, out) {
            const section = newSection(out, 'Group 10 - Item output templates');
            const sopId = resolveItemId(ctx, 'SOP');
            const residId = resolveItemId(ctx, 'RESID');
            if (!sopId || !residId) {
                addRow(section, 'error', 'Group skipped - missing '
                    + missingList([[sopId, 'SOP item (run the Items group)'], [residId, 'Mill Residuals item (run the Items group)']]));
                return;
            }
            OUTPUT_TEMPLATES.forEach(function(t) {
                const inputId = resolveItemId(ctx, t.inputKey);
                if (!inputId) {
                    addRow(section, 'error', 'Template for ' + t.inputKey + ' skipped - input item not seeded');
                    return;
                }
                ensureTemplateLine(section, inputId, t.inputKey, sopId, 'SOP',  'Fiber',    t.fiberPct, 'To Inventory', 1);
                ensureTemplateLine(section, inputId, t.inputKey, residId, 'Mill Residuals', 'Residual', t.residPct, 'Waste', 2);
            });
        }

        function ensureTemplateLine(section, inputId, inputKey, outputId, outputLabel, typeText, pct, dispText, seq) {
            try {
                if (findTemplateByKey(inputId, outputId)) {
                    addRow(section, 'exists', inputKey + ' -> ' + outputLabel + ' (' + pct + '%) template already defined',
                        'customrecord_sust_item_output_template', null);
                    return;
                }
                const tmpl = record.create({ type: 'customrecord_sust_item_output_template' });
                tmpl.setValue({ fieldId: 'custrecord_sust_template_input_item', value: inputId });
                tmpl.setValue({ fieldId: 'custrecord_sust_template_output_item', value: outputId });
                tmpl.setText({ fieldId: 'custrecord_sust_template_output_type', text: typeText });
                tmpl.setValue({ fieldId: 'custrecord_sust_template_default_pct', value: pct });
                tmpl.setText({ fieldId: 'custrecord_sust_template_disposition', text: dispText });
                tmpl.setValue({ fieldId: 'custrecord_sust_template_sequence', value: seq });
                tmpl.setValue({ fieldId: 'custrecord_sust_template_active', value: true });
                const id = tmpl.save();
                addRow(section, 'created', inputKey + ' -> ' + outputLabel + ' (' + pct + '%, ' + typeText + '/' + dispText + ')',
                    'customrecord_sust_item_output_template', id);
            } catch (e) {
                addRow(section, 'error', inputKey + ' -> ' + outputLabel + ' template: ' + e.message);
                log.error('ensureTemplateLine', inputKey + '->' + outputLabel + ': ' + e.message);
            }
        }

        function findTemplateByKey(inputId, outputId) {
            try {
                const res = search.create({
                    type: 'customrecord_sust_item_output_template',
                    filters: [
                        ['custrecord_sust_template_input_item', 'anyof', inputId], 'AND',
                        ['custrecord_sust_template_output_item', 'anyof', outputId]
                    ],
                    columns: ['internalid']
                }).run().getRange({ start: 0, end: 1 });
                return res.length ? parseInt(res[0].id, 10) : null;
            } catch (e) {
                log.error('findTemplateByKey', e.message);
                return null;
            }
        }

        // ─── Group 11: sample settlements (feed the Settlement Close-Out dashboard) ──
        // Reuses SUST_Lib_SettlementCreate (the same creator the receiving UE and the
        // line-picker Suitelet use) so values are realistic, then backdates + sets the
        // lifecycle status so the dashboard's aging tiles (Watch/Stale) populate.
        // NOTE: statuses are limited to Draft / Completed on purpose. 'Provisional Paid'
        // and 'Final Settled' trigger vendor-bill creation in SUST_UE_Settlement_StatusChange,
        // which must not fire while seeding demo data.
        const SAMPLE_SETTLEMENTS = [
            { tag: 'A', grossLbs: 40000, ageDays: 5,  status: 'Draft' },
            { tag: 'B', grossLbs: 42000, ageDays: 45, status: 'Completed' },
            { tag: 'C', grossLbs: 38000, ageDays: 72, status: 'Completed' }
        ];

        function seedSampleSettlements(ctx, out) {
            const section = newSection(out, 'Group 11 - Sample settlements');
            const vendorId = resolveVendorId(ctx);
            const wlId = resolveItemId(ctx, 'WL');
            if (!vendorId || !wlId) {
                addRow(section, 'error', 'Group skipped - missing '
                    + missingList([[vendorId, 'vendor (run the Entities group)'], [wlId, 'White Ledger item (run the Items group)']]));
                return;
            }
            SAMPLE_SETTLEMENTS.forEach(function(spec) {
                const marker = '[SUSTDEMO ' + spec.tag + ']';
                let step = 'start';
                try {
                    if (findSettlementByMarker(marker)) {
                        addRow(section, 'exists', 'Sample settlement ' + spec.tag + ' (' + spec.status + ') already seeded',
                            'customrecord_sust_settlement_record', null);
                        return;
                    }
                    const tranDate = daysAgo(spec.ageDays);
                    step = 'createLineSettlement';
                    const settleId = settlementLib.createLineSettlement({
                        vendorId: vendorId,
                        tranDate: tranDate,
                        itemId: wlId,
                        grossWeight: spec.grossLbs,
                        recoveryPct: 95,
                        sourceTag: marker + ' sample settlement'
                    });
                    // Backdate + advance status + expose a balance due for the dashboard tiles.
                    step = 'load/adjust/save';
                    const rec = record.load({ type: 'customrecord_sust_settlement_record', id: settleId });
                    rec.setValue({ fieldId: 'custrecord_sust_settlement_date', value: tranDate });
                    rec.setText({ fieldId: 'custrecord_sust_settlement_status', text: spec.status });
                    try { rec.setText({ fieldId: 'custrecord_sust_settlement_mode', text: 'Auto' }); } catch (eMode) { log.debug('sample mode', eMode.message); }
                    const netVal = parseFloat(rec.getValue({ fieldId: 'custrecord_sust_settlement_net_value' })) || 0;
                    rec.setValue({ fieldId: 'custrecord_sust_settlement_balance_due', value: netVal });
                    rec.save();
                    addRow(section, 'created', 'Sample settlement ' + spec.tag + ' - ' + spec.grossLbs.toLocaleString()
                        + ' lbs, ' + spec.status + ', ~' + spec.ageDays + 'd old, net $' + netVal.toFixed(2),
                        'customrecord_sust_settlement_record', settleId);
                } catch (e) {
                    addRow(section, 'error', 'Sample settlement ' + spec.tag + ' [step=' + step + ']: ' + e.message);
                    log.error('seedSampleSettlements', spec.tag + ' [step=' + step + ']: ' + e.message);
                }
            });

            seedAggregatedSettlement(section, vendorId, wlId);
        }

        /**
         * Sample WEEKLY-aggregated settlement (marker [SUSTDEMO AGG]): one Draft
         * settlement for the current ISO week holding two receipt-line slices
         * (20,000 + 22,000 lbs), the way createOrAppendLineSettlement builds them
         * for a Weekly-cadence vendor. Demonstrates the aggregation story without
         * needing two live receipts first.
         */
        function seedAggregatedSettlement(section, vendorId, wlId) {
            const marker = '[SUSTDEMO AGG]';
            let step = 'start';
            try {
                // Only an OPEN (Draft) sample blocks re-seeding — a closed/finalized
                // sample stays as history and a fresh Draft one is created so the
                // aggregation + close demo is always runnable.
                const existingId = findDraftSettlementByMarker(marker);
                if (existingId && countSlices(existingId) > 0) {
                    addRow(section, 'exists', 'Aggregated (Weekly) sample settlement already seeded (Draft, with slices)',
                        'customrecord_sust_settlement_record', existingId);
                    return;
                }
                const periodKey = settlementLib.periodKeyFor('Weekly', new Date());
                let settleId = existingId;
                if (!settleId) {
                    step = 'createLineSettlement';
                    settleId = settlementLib.createLineSettlement({
                        vendorId: vendorId,
                        tranDate: new Date(),
                        itemId: wlId,
                        grossWeight: 20000,
                        recoveryPct: 95,
                        sourceTag: marker + ' weekly aggregated settlement - receipt slice 1'
                    });
                }
                // From here the record is enriched idempotently — a pre-slice-era
                // settlement (period key set but no slices/deductions) is upgraded
                // in place rather than skipped.
                step = 'aggregate-second-slice';
                const rec = record.load({ type: 'customrecord_sust_settlement_record', id: settleId });
                const gross = 42000;
                const net = 42000 * 0.95;

                // Realistic economics: schedule-ish price on net lbs, then quality
                // deductions (moisture over threshold) + treatment charge.
                const pricePerLb = 0.06;
                const grossValue = net * pricePerLb;                      // 39,900 × $0.06 = $2,394
                const moistureExcessPts = 2;                              // 12% actual vs 10% threshold
                const penaltyRatePerPt = 0.0025;                          // $/lb per point
                const moisturePenalty = net * penaltyRatePerPt * moistureExcessPts; // ≈ $199.50
                const compactorFee = 75;                                  // per-load compactor rental back-out
                const penaltyAmt = moisturePenalty + compactorFee;
                const treatment = 150;
                const netValue = grossValue - penaltyAmt - treatment;

                rec.setValue({ fieldId: 'custrecord_sust_settlement_gross_lbs', value: gross });
                rec.setValue({ fieldId: 'custrecord_sust_settlement_net_lbs', value: net });
                rec.setValue({ fieldId: 'custrecord_sust_settlement_gross_value', value: grossValue });
                rec.setValue({ fieldId: 'custrecord_sust_settlement_penalties', value: penaltyAmt });
                rec.setValue({ fieldId: 'custrecord_sust_settlement_treatment', value: treatment });
                rec.setValue({ fieldId: 'custrecord_sust_settlement_net_value', value: netValue });
                rec.setValue({ fieldId: 'custrecord_sust_settlement_balance_due', value: netValue });
                rec.setValue({ fieldId: 'custrecord_sust_settle_period_key', value: periodKey });
                rec.setValue({
                    fieldId: 'custrecord_sust_settle_agg_sources',
                    value: JSON.stringify(['ir:seed-1:1', 'ir:seed-2:1'])
                });
                const existingNotes = rec.getValue({ fieldId: 'custrecord_sust_settlement_notes' }) || '';
                if (existingNotes.indexOf('Weekly-cadence aggregation') === -1) {
                    rec.setValue({
                        fieldId: 'custrecord_sust_settlement_notes',
                        value: existingNotes
                            + '\n+ receipt slice 2: 22000 lbs gross'
                            + '\nWeekly-cadence aggregation: both receipt lines rolled into this single ' + periodKey + ' settlement.'
                            + '\nDeductions: Moisture 12% vs 10% threshold (' + moistureExcessPts + ' pts x $' + penaltyRatePerPt
                            + '/lb/pt = $' + moisturePenalty.toFixed(2) + ') + compactor fee back-out $' + compactorFee.toFixed(2)
                            + ' + treatment charge $' + treatment.toFixed(2) + '.'
                    });
                }
                rec.save();

                // Receipt-slice child rows (what the aggregation panel + child sublist show)
                step = 'slice-records';
                [
                    { gross: 20000, daysBack: 3 },
                    { gross: 22000, daysBack: 1 }
                ].forEach(function(sl, idx) {
                    const slice = record.create({ type: 'customrecord_sust_settle_slice' });
                    slice.setValue({ fieldId: 'custrecord_sust_slice_settlement', value: settleId });
                    slice.setValue({ fieldId: 'custrecord_sust_slice_source_line', value: 1 });
                    slice.setValue({ fieldId: 'custrecord_sust_slice_date', value: daysAgo(sl.daysBack) });
                    slice.setValue({ fieldId: 'custrecord_sust_slice_gross_lbs', value: sl.gross });
                    slice.setValue({ fieldId: 'custrecord_sust_slice_net_lbs', value: sl.gross * 0.95 });
                    slice.setValue({ fieldId: 'custrecord_sust_slice_value', value: sl.gross * 0.95 * pricePerLb });
                    slice.save();
                });

                // Penalty detail row (the Deductions section on the settlement)
                step = 'penalty-detail';
                try {
                    const pen = record.create({ type: 'customrecord_sust_penalty_detail' });
                    pen.setValue({ fieldId: 'custrecord_sust_penalty_settlement', value: settleId });
                    pen.setText({ fieldId: 'custrecord_sust_penalty_detail_element', text: 'Moisture %' });
                    pen.setValue({ fieldId: 'custrecord_sust_penalty_detail_actual', value: 12 });
                    pen.setValue({ fieldId: 'custrecord_sust_penalty_detail_threshold', value: 10 });
                    pen.setValue({ fieldId: 'custrecord_sust_penalty_detail_excess', value: moistureExcessPts });
                    pen.setValue({ fieldId: 'custrecord_sust_penalty_detail_rate', value: penaltyRatePerPt });
                    pen.setValue({ fieldId: 'custrecord_sust_penalty_detail_amount', value: moisturePenalty });
                    pen.save();

                    // Compactor fee back-out — flat per-load deduction ('fee for
                    // compactors might get backed out' per discovery)
                    const pen2 = record.create({ type: 'customrecord_sust_penalty_detail' });
                    pen2.setValue({ fieldId: 'custrecord_sust_penalty_settlement', value: settleId });
                    pen2.setText({ fieldId: 'custrecord_sust_penalty_detail_element', text: 'Other' });
                    pen2.setValue({ fieldId: 'custrecord_sust_penalty_detail_actual', value: 0 });
                    pen2.setValue({ fieldId: 'custrecord_sust_penalty_detail_threshold', value: 0 });
                    pen2.setValue({ fieldId: 'custrecord_sust_penalty_detail_excess', value: 0 });
                    pen2.setValue({ fieldId: 'custrecord_sust_penalty_detail_rate', value: compactorFee });
                    pen2.setValue({ fieldId: 'custrecord_sust_penalty_detail_amount', value: compactorFee });
                    pen2.save();
                } catch (ePen) {
                    log.error('seedAggregatedSettlement penalty detail', ePen.message);
                }

                addRow(section, 'created', 'Aggregated (Weekly) sample settlement - 42,000 lbs / 2 receipt slices, period ' + periodKey
                    + ', gross $' + grossValue.toFixed(2) + ' - deductions $' + (penaltyAmt + treatment).toFixed(2)
                    + ' = net $' + netValue.toFixed(2),
                    'customrecord_sust_settlement_record', settleId);
            } catch (e) {
                addRow(section, 'error', 'Aggregated sample settlement [step=' + step + ']: ' + e.message);
                log.error('seedAggregatedSettlement', '[step=' + step + ']: ' + e.message);
            }
        }

        /** How many receipt-slice children a settlement already has. */
        function countSlices(settlementId) {
            try {
                return search.create({
                    type: 'customrecord_sust_settle_slice',
                    filters: [['custrecord_sust_slice_settlement', 'anyof', settlementId]],
                    columns: ['internalid']
                }).run().getRange({ start: 0, end: 10 }).length;
            } catch (e) {
                log.error('countSlices', e.message);
                return 0;
            }
        }

        // ─── Group 12: monthly blanket settlement scenario ───────────────────
        // Runs the REAL pipeline: creates 2 POs, receives both (UE chain builds
        // the blanket monthly settlement + receipt slices with schedule pricing),
        // grades the lots (one with a moisture breach), then stages the
        // deductions (moisture penalty + compactor fee + treatment) on the
        // blanket settlement. Everything idempotent by externalid / period.
        const MONTHLY_SCENARIO = [
            { poNum: 'PO-10101', extid: EXT_PREFIX + 'PO_MB1', irExtid: EXT_PREFIX + 'IR_MB1', lot: 'WL-MB-001', qty: 24000, moisture: 8,  contamination: 2, fiber: 92, bales: 20 },
            { poNum: 'PO-10102', extid: EXT_PREFIX + 'PO_MB2', irExtid: EXT_PREFIX + 'IR_MB2', lot: 'WL-MB-002', qty: 20000, moisture: 13, contamination: 3, fiber: 89, bales: 17 }
        ];

        function seedMonthlyScenario(ctx, out) {
            const section = newSection(out, 'Group 12 - Monthly blanket settlement scenario');
            const vendorId = resolveVendorId(ctx);
            const wlId = resolveItemId(ctx, 'WL');
            const cinciId = resolveLocationId(ctx, 'CINCINNATI');
            if (!vendorId || !wlId || !cinciId) {
                addRow(section, 'error', 'Skipped - run Entities/Items/Locations groups first');
                return;
            }

            // 1. Vendor cadence -> Monthly (the scenario's premise)
            try {
                const v = record.load({ type: 'vendor', id: vendorId });
                if ((v.getText({ fieldId: 'custentity_sust_settlement_cadence' }) || '') !== 'Monthly') {
                    v.setText({ fieldId: 'custentity_sust_settlement_cadence', text: 'Monthly' });
                    v.save({ ignoreMandatoryFields: true });
                    addRow(section, 'updated', 'Vendor ' + VENDOR.name + ' settlement cadence -> Monthly', 'vendor', vendorId);
                } else {
                    addRow(section, 'exists', 'Vendor cadence already Monthly', 'vendor', vendorId);
                }
            } catch (eCad) {
                addRow(section, 'error', 'Cadence: ' + errText(eCad));
            }

            // 2. POs + receipts (the receipt saves fire the settlement UE chain)
            MONTHLY_SCENARIO.forEach(function(spec) {
                try {
                    let poId = findByExternalId('purchaseorder', spec.extid);
                    if (!poId) {
                        const po = record.create({ type: 'purchaseorder', isDynamic: true });
                        po.setValue({ fieldId: 'entity', value: vendorId });
                        try { po.setValue({ fieldId: 'subsidiary', value: ctx.usSubId }); } catch (eS) { /* vendor-sourced */ }
                        try { po.setValue({ fieldId: 'location', value: cinciId }); } catch (eL) { /* optional */ }
                        po.setValue({ fieldId: 'trandate', value: new Date() });
                        try { po.setValue({ fieldId: 'tranid', value: spec.poNum }); } catch (eT) { /* numbering */ }
                        try { po.setText({ fieldId: 'custbody_sust_pricing_timing', text: 'Determined on Arrival' }); } catch (eP) { /* optional */ }
                        po.setValue({ fieldId: 'memo', value: 'Sustana demo - monthly settlement scenario load ' + spec.lot });
                        po.setValue({ fieldId: 'externalid', value: spec.extid });
                        po.selectNewLine({ sublistId: 'item' });
                        po.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: wlId });
                        po.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: spec.qty });
                        po.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate', value: 0.15 });
                        try { po.setCurrentSublistValue({ sublistId: 'item', fieldId: 'location', value: cinciId }); } catch (eLL) { /* optional */ }
                        po.commitLine({ sublistId: 'item' });
                        poId = po.save({ ignoreMandatoryFields: true, enableSourcing: true });
                        addRow(section, 'created', spec.poNum + ' - ' + commasNum(spec.qty) + ' lbs White Ledger', 'purchaseorder', poId);
                    } else {
                        addRow(section, 'exists', spec.poNum + ' already seeded', 'purchaseorder', poId);
                    }

                    let irId = findByExternalId('itemreceipt', spec.irExtid);
                    if (!irId) {
                        const ir = record.transform({ fromType: 'purchaseorder', fromId: poId, toType: 'itemreceipt', isDynamic: false });
                        ir.setValue({ fieldId: 'externalid', value: spec.irExtid });
                        const lineCount = ir.getLineCount({ sublistId: 'item' });
                        for (let i = 0; i < lineCount; i++) {
                            ir.setSublistValue({ sublistId: 'item', fieldId: 'itemreceive', line: i, value: true });
                            ir.setSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i, value: spec.qty });
                            try {
                                ir.setSublistValue({ sublistId: 'item', fieldId: 'custcol_sust_scrap_gross_weight', line: i, value: spec.qty + 38500 });
                                ir.setSublistValue({ sublistId: 'item', fieldId: 'custcol_sust_scrap_tare_weight', line: i, value: 38500 });
                                ir.setSublistValue({ sublistId: 'item', fieldId: 'custcol_sust_scrap_net_weight', line: i, value: spec.qty });
                            } catch (eCols) { log.debug('weight cols skipped', eCols.message); }
                            const detail = ir.getSublistSubrecord({ sublistId: 'item', fieldId: 'inventorydetail', line: i });
                            detail.setSublistValue({ sublistId: 'inventoryassignment', fieldId: 'receiptinventorynumber', line: 0, value: spec.lot });
                            detail.setSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', line: 0, value: spec.qty });
                        }
                        // This save fires the whole chain: settlement auto-create with
                        // Monthly cadence -> blanket settlement + slice, vendor-lot
                        // bridge, landed cost.
                        irId = ir.save({ ignoreMandatoryFields: true });
                        addRow(section, 'created', 'Item Receipt for ' + spec.poNum + ' - lot ' + spec.lot
                            + ' (settlement UE chain fired)', 'itemreceipt', irId);
                    } else {
                        addRow(section, 'exists', 'Receipt for ' + spec.poNum + ' already seeded', 'itemreceipt', irId);
                    }

                    // Grade the lot (WL-MB-002 breaches the 12% moisture threshold)
                    const lotId = findLotInternalId(spec.lot);
                    if (lotId) {
                        const lot = record.load({ type: 'inventorynumber', id: lotId });
                        lot.setValue({ fieldId: 'custitemnumber_sust_moisture_pct', value: spec.moisture });
                        lot.setValue({ fieldId: 'custitemnumber_sust_contamination_pct', value: spec.contamination });
                        lot.setValue({ fieldId: 'custitemnumber_sust_fiber_content_pct', value: spec.fiber });
                        lot.setValue({ fieldId: 'custitemnumber_sust_bale_count', value: spec.bales });
                        try { lot.setText({ fieldId: 'custitemnumber_sust_lot_form', text: 'Loose' }); } catch (eF) { /* optional */ }
                        try {
                            const st = lot.getText({ fieldId: 'custitemnumber_sust_lot_status' }) || '';
                            if (st === '' || st === 'Received') lot.setText({ fieldId: 'custitemnumber_sust_lot_status', text: 'Yard' });
                        } catch (eSt) { /* optional */ }
                        lot.save();
                        addRow(section, 'updated', 'Lot ' + spec.lot + ' graded - M ' + spec.moisture + '% / C ' + spec.contamination + '%'
                            + (spec.moisture > 12 ? ' (MOISTURE BREACH - drives the deduction)' : ''), 'inventorynumber', lotId);
                    }
                } catch (e) {
                    addRow(section, 'error', spec.poNum + ': ' + errText(e));
                    log.error('seedMonthlyScenario', spec.poNum + ': ' + errText(e) + '\n' + (e && e.stack));
                }
            });

            // 3. Deductions on the blanket settlement the receipts just built
            try {
                const periodKey = settlementLib.periodKeyFor('Monthly', new Date());
                const open = settlementLib.findOpenPeriodSettlement(vendorId, periodKey);
                if (!open) {
                    addRow(section, 'error', 'No open blanket settlement found for period ' + periodKey
                        + ' - check the receipt rows above for UE errors');
                    return;
                }
                const rec = record.load({ type: 'customrecord_sust_settlement_record', id: open.id });
                const alreadyStaged = (rec.getValue({ fieldId: 'custrecord_sust_settlement_notes' }) || '').indexOf('[SUSTDEMO MB DEDUCTIONS]') !== -1;
                if (alreadyStaged) {
                    addRow(section, 'exists', 'Blanket settlement ' + periodKey + ' already carries the scenario deductions',
                        'customrecord_sust_settlement_record', open.id);
                    return;
                }
                const netLbs = parseFloat(rec.getValue({ fieldId: 'custrecord_sust_settlement_net_lbs' })) || 0;
                const grossValue = parseFloat(rec.getValue({ fieldId: 'custrecord_sust_settlement_net_value' })) || 0;
                // Moisture: WL-MB-002 at 13% vs 12% threshold = 1 excess pt on its net lbs
                const breachNet = 20000 * 0.95;
                const moisturePenalty = Math.round(breachNet * 0.0025 * 1 * 100) / 100; // $47.50
                const compactorFee = 75;
                const treatment = 150;
                const deductions = moisturePenalty + compactorFee + treatment - 150; // treatment tracked separately
                const netValue = grossValue - moisturePenalty - compactorFee - treatment;

                rec.setValue({ fieldId: 'custrecord_sust_settlement_gross_value', value: grossValue });
                rec.setValue({ fieldId: 'custrecord_sust_settlement_penalties', value: moisturePenalty + compactorFee });
                rec.setValue({ fieldId: 'custrecord_sust_settlement_treatment', value: treatment });
                rec.setValue({ fieldId: 'custrecord_sust_settlement_net_value', value: netValue });
                rec.setValue({ fieldId: 'custrecord_sust_settlement_balance_due', value: netValue });
                rec.setValue({
                    fieldId: 'custrecord_sust_settlement_notes',
                    value: ((rec.getValue({ fieldId: 'custrecord_sust_settlement_notes' }) || '')
                        + '\n[SUSTDEMO MB DEDUCTIONS] Moisture 13% vs 12% on WL-MB-002 (1 pt x $0.0025/lb x ' + commasNum(breachNet)
                        + ' lbs = $' + moisturePenalty.toFixed(2) + ') + compactor fee $' + compactorFee.toFixed(2)
                        + ' + treatment $' + treatment.toFixed(2) + '. Gross $' + grossValue.toFixed(2)
                        + ' -> net $' + netValue.toFixed(2) + '.').substring(0, 3900)
                });
                rec.save();

                const penSpecs = [
                    { element: 'Moisture %', actual: 13, threshold: 12, excess: 1, rate: 0.0025, amount: moisturePenalty },
                    { element: 'Other',      actual: 0,  threshold: 0,  excess: 0, rate: compactorFee, amount: compactorFee }
                ];
                penSpecs.forEach(function(ps) {
                    const pen = record.create({ type: 'customrecord_sust_penalty_detail' });
                    pen.setValue({ fieldId: 'custrecord_sust_penalty_settlement', value: open.id });
                    pen.setText({ fieldId: 'custrecord_sust_penalty_detail_element', text: ps.element });
                    pen.setValue({ fieldId: 'custrecord_sust_penalty_detail_actual', value: ps.actual });
                    pen.setValue({ fieldId: 'custrecord_sust_penalty_detail_threshold', value: ps.threshold });
                    pen.setValue({ fieldId: 'custrecord_sust_penalty_detail_excess', value: ps.excess });
                    pen.setValue({ fieldId: 'custrecord_sust_penalty_detail_rate', value: ps.rate });
                    pen.setValue({ fieldId: 'custrecord_sust_penalty_detail_amount', value: ps.amount });
                    pen.save();
                });

                addRow(section, 'created', 'Blanket settlement ' + periodKey + ' - gross $' + grossValue.toFixed(2)
                    + ' - moisture $' + moisturePenalty.toFixed(2) + ' - compactor $' + compactorFee.toFixed(2)
                    + ' - treatment $' + treatment.toFixed(2) + ' = net $' + netValue.toFixed(2)
                    + ' (2 receipt slices, blanket header, Draft - ready for the close demo)',
                    'customrecord_sust_settlement_record', open.id);
            } catch (e) {
                addRow(section, 'error', 'Deductions: ' + errText(e));
                log.error('seedMonthlyScenario deductions', errText(e) + '\n' + (e && e.stack));
            }
        }

        /** Marker settlement that is still in Draft (closed ones don't count). */
        function findDraftSettlementByMarker(marker) {
            try {
                const res = search.create({
                    type: 'customrecord_sust_settlement_record',
                    filters: [['custrecord_sust_settlement_notes', 'contains', marker]],
                    columns: ['internalid', 'custrecord_sust_settlement_status']
                }).run().getRange({ start: 0, end: 10 });
                for (let i = 0; i < res.length; i++) {
                    if ((res[i].getText({ name: 'custrecord_sust_settlement_status' }) || '') === 'Draft') {
                        return parseInt(res[i].id, 10);
                    }
                }
            } catch (e) {
                log.error('findDraftSettlementByMarker', e.message);
            }
            return null;
        }

        function findSettlementByMarker(marker) {
            try {
                const res = search.create({
                    type: 'customrecord_sust_settlement_record',
                    filters: [['custrecord_sust_settlement_notes', 'contains', marker]],
                    columns: ['internalid']
                }).run().getRange({ start: 0, end: 1 });
                return res.length ? parseInt(res[0].id, 10) : null;
            } catch (e) {
                log.error('findSettlementByMarker', e.message);
                return null;
            }
        }

        function daysAgo(n) {
            const d = new Date();
            d.setDate(d.getDate() - n);
            return d;
        }

        // ─── Shared resolvers (lazy — used by later groups when an earlier
        //     group was unchecked but its records were seeded on a prior run) ──

        function resolveItemId(ctx, key) {
            if (ctx.itemIds[key]) return ctx.itemIds[key];
            const spec = GRADE_ITEMS.filter(function(g) { return g.key === key; })[0];
            if (!spec) return null;
            const id = findByExternalId('item', spec.extid);
            if (id) ctx.itemIds[key] = parseInt(id, 10);
            return ctx.itemIds[key] || null;
        }

        function resolveVendorId(ctx) {
            if (!ctx.vendorId) {
                const id = findByExternalId('vendor', VENDOR.extid);
                if (id) ctx.vendorId = parseInt(id, 10);
            }
            return ctx.vendorId || null;
        }

        function resolveCustomerId(ctx) {
            if (!ctx.customerId) {
                const id = findByExternalId('customer', CUSTOMER.extid);
                if (id) ctx.customerId = parseInt(id, 10);
            }
            return ctx.customerId || null;
        }

        function resolveLocationId(ctx, key) {
            if (ctx.locIds[key]) return ctx.locIds[key];
            const spec = locationSpec(key);
            if (!spec) return null;
            const id = findByExternalId('location', spec.extid);
            if (id) ctx.locIds[key] = parseInt(id, 10);
            return ctx.locIds[key] || null;
        }

        function resolveInvAdjAccountId(ctx) {
            if (ctx.invAdjAcctId) return ctx.invAdjAcctId;
            const fromConfig = parseInt(configLib.get('invAdjAccount'), 10);
            if (fromConfig) ctx.invAdjAcctId = fromConfig;
            return ctx.invAdjAcctId || null;
        }

        // ─── Generic helpers ──────────────────────────────────────────────────

        function findByExternalId(recordType, extid) {
            try {
                const res = search.create({
                    type: recordType,
                    filters: [['externalid', 'is', extid]],
                    columns: ['internalid']
                }).run().getRange({ start: 0, end: 1 });
                return res.length ? res[0].id : null;
            } catch (e) {
                log.debug('findByExternalId', recordType + '/' + extid + ': ' + e.message);
                return null;
            }
        }

        /**
         * One OR-combined search for a batch of externalids → { extid: internalid }.
         * Handles both search-result behaviors for the externalid column
         * (string in getValue vs getText, depending on record type).
         */
        function findExistingByExternalIds(recordType, extids) {
            const map = {};
            if (!extids || !extids.length) return map;
            const expr = [];
            extids.forEach(function(extid, i) {
                if (i > 0) expr.push('OR');
                expr.push(['externalid', 'is', extid]);
            });
            try {
                search.create({
                    type: recordType,
                    filters: expr,
                    columns: ['externalid']
                }).run().each(function(res) {
                    const v = res.getValue({ name: 'externalid' });
                    let t = null;
                    try { t = res.getText({ name: 'externalid' }); } catch (eText) { /* not a text column here */ }
                    const matched = (extids.indexOf(t) !== -1) ? t : ((extids.indexOf(v) !== -1) ? v : null);
                    if (matched && !map[matched]) map[matched] = res.id;
                    return true;
                });
            } catch (e) {
                log.error('findExistingByExternalIds', recordType + ': ' + e.message);
            }
            return map;
        }

        function runPagedCount(recordType, filters) {
            try {
                return search.create({
                    type: recordType,
                    filters: filters || [],
                    columns: ['internalid']
                }).runPaged().count;
            } catch (e) {
                log.debug('runPagedCount', recordType + ': ' + e.message);
                return 0;
            }
        }

        /** Subsidiary is a multiselect on items/locations — try array, fall back to scalar. */
        function setSubsidiaryField(rec, subIds) {
            try {
                rec.setValue({ fieldId: 'subsidiary', value: subIds });
            } catch (e) {
                try {
                    rec.setValue({ fieldId: 'subsidiary', value: subIds[0] });
                } catch (e2) {
                    log.debug('setSubsidiaryField', 'subsidiary not set: ' + e2.message);
                }
            }
        }

        function missingList(pairs) {
            return pairs.filter(function(p) { return !p[0]; })
                .map(function(p) { return p[1]; })
                .join(' and ');
        }

        function pluck(arr, key) {
            return arr.map(function(x) { return x[key]; });
        }

        // ─── Results rendering ────────────────────────────────────────────────

        function newSection(out, title) {
            const section = { title: title, rows: [] };
            out.sections.push(section);
            return section;
        }

        function addRow(section, status, label, recordType, recordId) {
            section.rows.push({
                status: status,
                label: label,
                url: (recordType && recordId) ? recUrl(recordType, recordId) : null
            });
        }

        function recUrl(recordType, recordId) {
            try {
                return url.resolveRecord({ recordType: recordType, recordId: recordId });
            } catch (e) {
                return null;
            }
        }

        function resultsHtml(out) {
            const STATUS_STYLE = {
                created: { color: COLOR.green, label: 'CREATED' },
                updated: { color: COLOR.blue,  label: 'UPDATED' },
                exists:  { color: COLOR.gray,  label: 'EXISTS' },
                skipped: { color: COLOR.gray,  label: 'SKIPPED' },
                info:    { color: '#334155',   label: 'OK' },
                error:   { color: COLOR.red,   label: 'ERROR' }
            };
            let errorCount = 0;
            let html = '<div style="font-family:Arial,sans-serif; max-width:880px; margin:32px auto; padding:0 16px;">'
                + '<h2 style="color:' + COLOR.darkBlue + ';">Sustana Demo Seed - Results</h2>';
            out.sections.forEach(function(section) {
                html += '<div style="background:#f9fafb; border:1px solid #d1d5db; border-radius:6px; padding:12px 16px; margin:12px 0;">'
                    + '<h3 style="margin:0 0 8px 0; font-size:14px; color:' + COLOR.ink + ';">' + esc(section.title) + '</h3>'
                    + '<ul style="margin:0; padding:0; font-size:13px; line-height:1.8; list-style:none;">';
                if (section.rows.length === 0) {
                    html += '<li style="color:' + COLOR.gray + ';">Nothing to do.</li>';
                }
                section.rows.forEach(function(row) {
                    const style = STATUS_STYLE[row.status] || STATUS_STYLE.info;
                    if (row.status === 'error') errorCount++;
                    html += '<li>'
                        + '<span style="display:inline-block; min-width:70px; font-weight:bold; color:' + style.color + ';">' + style.label + '</span> '
                        + '<span style="color:#111827;">' + esc(row.label) + '</span>'
                        + (row.url ? ' &nbsp;<a href="' + esc(row.url) + '" target="_blank" style="color:' + COLOR.blue + ';">view</a>' : '')
                        + '</li>';
                });
                html += '</ul></div>';
            });
            html += '<p style="font-size:13px; font-weight:bold; color:' + (errorCount ? COLOR.red : COLOR.green) + ';">'
                + (errorCount
                    ? errorCount + ' error(s) - see the rows above and the script execution log.'
                    : 'Completed with no errors.')
                + '</p>'
                + '<p style="font-size:13px; color:#334155;">Idempotent: re-running updates the <code>SUSTDEMO_</code> records instead of duplicating them '
                + '(the on-hand adjustment group is skipped once seeded). '
                + '<a href="javascript:history.back()" style="color:' + COLOR.blue + '; font-weight:bold;">Run again</a></p>'
                + '</div>';
            return html;
        }

        /** Escape every user-visible dynamic string before it lands in HTML. */
        function esc(value) {
            return String(value === undefined || value === null ? '' : value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        return { onRequest: onRequest, runSeedAll: runSeedAll };
    });
