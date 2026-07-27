# Sustana Recovery — End-to-End Test Cases

Manual UAT scripts to validate the solution end to end, ordered along the demo-moment spine
so a full pass doubles as a demo dry run. Each case lists **preconditions → steps → expected
results**. The final section is an **automated-coverage gap analysis**: what the Jest suite
already proves vs. what only manual testing can catch.

Page behavior referenced here is documented in [PAGES.md](PAGES.md); wiring in
[ARCHITECTURE.md](ARCHITECTURE.md).

## How to run

1. Deploy: `npx suitecloud project:validate` then `project:deploy`.
2. One-time prereq: create subsidiaries **Sustana Recovery US** and **Sustana Recovery
   Canada** (Setup › Company › Subsidiaries).
3. Run **SUST - Seed Sustana Demo** (all groups except optional planning). Idempotent.
4. Regression: `npm test` (should be all green) before starting manual UAT.

Pass/fail legend: record **Actual result** and **P/F** against each expected outcome.
For User Event side effects, remember **afterSubmit never re-throws** — a missing side
effect is the failure signal, not an on-screen error.

---

## TC-SEED — Environment bootstrap

| | |
|---|---|
| **Preconditions** | Fresh deploy; both subsidiaries exist (`Sustana Recovery US` / `Sustana Recovery Canada`). |
| **Steps** | **UI:** open **SUST - Seed Sustana Demo** (`customscript_sust_sl_seed_demo`), leave all 11 groups checked, Run Selected Groups, then re-run once. **Headless (API):** `POST` the RESTlet `customscript_sust_rl_seed_demo` with Token-Based Auth — e.g. `node scripts/invoke-seed.mjs` after setting the `NS_*` env vars; runs all groups and returns a JSON summary. |
| **Expected** | Groups 1-11 all report created/updated with **no duplicates, no errors** on re-run: config record; 4 locations (Markham/Cincinnati/Buffalo/St Joseph); items White Ledger / Mixed Paper / Mixed Office Paper / SOP / Mill Residuals; vendor Fox Valley Recycling; customer Packaging Mill A; RISI SOP + RISI White Ledger monthly prices; 2 schedules (Purchase + Sale) **with 2 penalty rules** on the supplier schedule (Moisture % > 12, Contamination % > 5); PO-10001 open; 3 on-hand yard lots; **7 planning sales orders**; **3 item output templates** (WL/MP/MOP → SOP + Mill Residuals); **3 sample settlements** (Draft/Completed, aged 5/45/72 days). |
| **Notes** | The 3 planning **estimates** (delayed×2 / cancelled×1) require the acting role to hold *Transactions → Quote* permission; without it they error and only the 7 sales orders seed. All records use `SUSTDEMO_*` externalids or natural-key/notes markers, so the seeder is fully idempotent. |

---

## TC-RCV — 7:00 Phase-1 receiving (manual Item Receipt)

| | |
|---|---|
| **Preconditions** | TC-SEED done; PO-10001 open (Fox Valley Recycling, 40,000 lbs White Ledger, header Pricing Timing = *Determined on Arrival*). |
| **Steps** | 1. Open PO-10001 → **Receive**. 2. Fill the exact fields below. 3. Save. 4. Edit the IR, change Net Weight to 39,500, save. |
| **Exact fields to key** | **Native:** check the line **Receive** box · **Quantity** = `40000` · **Location** = Cincinnati · open the line's **Inventory Detail** → *Lot/Serial Number* (`receiptinventorynumber`) = `TRK-001`, *Quantity* = `40000`. ⚠️ **The lot detail is mandatory** — the settlement UE sums inventory-detail lot quantities for gross weight; with no lot/qty it silently creates **no** settlement. **Sustana line columns:** *Gross Weight (lbs)* `custcol_sust_scrap_gross_weight` = `78500` · *Net Weight (lbs)* `custcol_sust_scrap_net_weight` = `40000` · *Vendor Lot #* `custcol_sust_vendor_lot_number` = `FV-2026-0142` (optional; bridges onto the lot) · *Pricing Timing* `custcol_sust_pricing_timing` = **leave blank** (inherits header "Determined on Arrival" → settlement auto-creates; "Determined After Processing" would defer it to the button). **Landed-cost (optional):** *Index Base ($/lb)* `custcol_sust_index_base` = `0.155` · *Premium* `custcol_sust_premium` = `0.005` · *Freight* `custcol_sust_freight` = `0.003` · *Financing + Insurance* `custcol_sust_financing_insurance` = `0.001` → line rate auto-rolls to `0.164`. Leave Index Base blank to keep the PO's provisional $0.15/lb. |
| **Expected** | On save: indigo landed-cost banner (Index Base decomposition); a **line settlement (Draft)** auto-created, linked to PO + IR + line, mode **Auto**, priced ≈ RISI White Ledger − $15/ton, net weight = gross × item recovery (White Ledger 95% → 38,000 lbs); **lot `TRK-001` exists, status Received**, vendor-lot bridged; system note on the IR. On edit: settlement **recalculates** to the new weight (weight true-up). |
| **Notes** | If the demo account's non-Sustana PO-approval workflow blocks receiving, resolve/disable that workflow first (environmental, not a Sustana defect). |

---

## TC-RCV-MULTI — Multiple receipts against one PO

| | |
|---|---|
| **Preconditions** | An open PO with quantity for ≥2 partial receipts (e.g. seed/raise PO qty so 40,000 lbs can be received twice). |
| **Steps** | 1. Receive the PO partially (e.g. 40,000 lbs, lot `TRK-101`) → save. 2. Confirm a settlement was created. 3. Receive the PO again (remaining qty, lot `TRK-102`) → save. |
| **Expected** | **Both** receipts produce their own line settlement (Draft). Before the fix, the 2nd+ receipt was silently skipped because the PO already had a settlement. The guard now only defers when the PO carries a *settle-before-receipt* settlement (linked to the PO but to no Item Receipt). |
| **Regression** | Covered by `itemReceiptSettlementGuard.test.js`. |

## TC-RCVLINE — On-demand line settlement (Manage Line Settlements button)

| | |
|---|---|
| **Preconditions** | An Item Receipt (or PO) with a scrap line that has no settlement — e.g. a "Determined After Processing" line the IR deferred, or a 2nd receipt line. A pricing schedule exists for the vendor + item. |
| **Steps** | 1. From the IR (or PO), click **Create / Manage Line Settlements**. 2. Review the "Existing Settlement" column (already-settled lines show their settlement #, create-only). 3. Check the un-settled line(s) → **Create Selected Settlements**. |
| **Expected** | Settlement(s) created and you are redirected back to the source transaction, **with no `INVALID_NUMBER` / "You entered Custom…" error**. Root cause (now fixed): a new settlement with no explicit **Settlement Mode** fell back to an account field default that resolves to the unusable text `Custom`, which threw `INVALID_NUMBER` at save. `createLineSettlement` now sets a valid mode (`Auto` when a schedule exists, else `Calculator`), and only writes the market source when it's a numeric internal id. |
| **Regression** | Covered by `lineSettlementCreate.test.js`. Verified live via the seeder's Group 11 sample settlements (all create cleanly). |
| **Known UX gap** | The button is *create-only*; you cannot select/re-link an existing settlement from this screen (matches the reported "couldn't select the existing one"). Editing the link is done on the settlement record itself. |

## TC-KIOSK — 7:30 Scale kiosk (the Suitelet is the scale)

| | |
|---|---|
| **Preconditions** | TC-SEED done. |
| **Steps** | 1. Open **SUST - Scale Kiosk**. 2. Confirm ticket defaults to next `TRK-nnn`. 3. Pick Fox Valley → open-PO dropdown fills. 4. Enter gross/tare → net computes live. 5. Submit. 6. Follow the confirmation links. 7. Submit the **same ticket number** again. 8. Open the ticket link → correct the gross weight → Update. 9. New ticket with **no PO** → submit. |
| **Expected** | (5) IR auto-created, weights populated, lot = ticket number. (6) links chain ticket → IR → auto settlement → lot, zero re-keying. (7) **Duplicate ticket** warning, nothing created, link to existing ticket. (8) IR weights re-synced (no re-transform). (9) ticket status **Weighed Out**, no IR (outage fallback). |

---

## TC-LOTQ — 8:00 Inspection & regrade

| | |
|---|---|
| **Preconditions** | An Item Receipt with at least one lot (TC-RCV or TC-KIOSK). |
| **Steps** | 1. From the IR, button **Enter Lot Quality**. 2. Set Moisture 8% / Contamination 2% / Fiber 92% / Bale Count 20 → Save. 3. Re-open, change Moisture to 12% → Save. 4. Try to save a percent value of 150. |
| **Expected** | (2) values written to the lot; **lot status Received → Yard**. (3) `custitemnumber_sust_lot_notes` shows `[Quality Regrade YYYY-MM-DD, IR n] Moisture %: 8 -> 12` (original preserved). (4) blocked: "percent values must be between 0 and 100." |

---

## TC-YARD — 8:30 Yard movement

| | |
|---|---|
| **Preconditions** | A lot in Yard. |
| **Steps** | Advance the lot's **Lot Status**: Received → Yard → Processing Queue → Staged → Shipped. |
| **Expected** | Each status persists; Bale Count visible on the lot; later genealogy (TC-PROC) can trace output lot → input lots → receipt. |

---

## TC-PROC — 9:15 Processing without BOM/WO ⭐

| | |
|---|---|
| **Preconditions** | Seeded on-hand lots WL-SEED-001 (60,000 lbs = 30 tons), MP-SEED-001, SOP-SEED-001; seeded output templates. |
| **Expected** | On the Yield banner: outputs 28.5 + 0.9 = 29.4 tons out of 30 in, loss 0.6 tons, yield 98% (green). On Completed save: **Inventory Adjustment** posts (no WO/BOM), WL-SEED-001 consumed 30 tons, output lots `PROC-<num>-OUT1/-OUT2` created (status **Yard**), cost allocated across outputs (Byproduct mode: SOP absorbs, Residuals at NRV), genealogy rows (Grade Transformation) link outputs to input. Over-output save is blocked client-side. |
| **Notes** | Calculations are **not real-time**: the yield/mass-balance banner and per-line costs are computed by the Derived Fields UE **after save**; the Inventory Adjustment fires when Status reaches **Completed**. If the sublist "Add" hangs the browser in the shared demo account, open a fresh tab (environmental). For deferred pricing, set Total Input Cost $0 → record goes **Awaiting Cost**, IA deferred (see TC-COSTFLOW). |

**Field-by-field entry** (open **SUST - Processing Entry**; anything not listed: leave as-is):

| Field | Enter | Why |
|---|---|---|
| Processing Number | *(leave)* — shows "(Auto-generated on save)" | Auto `PROC-YYMMDD-NNN`. |
| Processing Date | *(leave)* — defaults to today | Mandatory, pre-filled. |
| Status | **Draft** first save; edit → **Completed** to post | Completed triggers the Inventory Adjustment UE. |
| Processing Type | **Sorting** | Any value works; Sorting matches the demo story. |
| Operator | *(optional)* any employee | Display only. |
| Location | **Cincinnati** | Seeded US location holding the lots. |
| Source Transaction | *(leave blank)* | Optional back-link; only needed when launched from an IR scrap line (then it pre-fills). |
| Source Type | **Receiver — Raw Recovered Paper** | Drives downstream behavior; this is the standard receiving-side flow. |
| Equipment | **Sorting Line** | Display/reporting only. |
| Input Item | **White Ledger** | Seeded scrap item with 60,000 lbs on hand. |
| Input Lot | **WL-SEED-001** | The seeded lot for White Ledger. |
| Input Weight (tons) | **30** | Full seeded lot (60,000 lbs). Must not exceed lot on-hand. |
| Gross Input / Tare Estimate / Tare Actual (tons) | *(leave blank)* | Optional scale reconciliation fields — not needed when Input Weight is keyed directly. |
| Total Input Cost ($) | **9000** | 60,000 lbs × $0.15 seeded unit cost. Enter **0** instead to demo the deferred-pricing / Awaiting Cost path (TC-COSTFLOW). |
| Allocation Mode | **Byproduct (GAAP)** — the default | Primary output absorbs cost, byproducts at NRV. |
| Output lines | Click **Load Default Outputs** | Template for White Ledger auto-adds: **SOP 95%** (28.5 tons, type Fiber) + **Mill Residuals 3%** (0.9 tons, type Residual). No manual line entry needed. |
| Output Lot (per line) | *(leave blank)* | Auto-numbered `PROC-<num>-OUTn` on completion. |
| Processing Notes | *(optional)* e.g. "Demo run 9:15" | Free text. |

Negative check: change the SOP output line to **31** tons (output > input) and try to save → blocked client-side.

---

## TC-INDEX — 1:30 Index pricing & true-up ⭐

| | |
|---|---|
| **Preconditions** | A supplier settlement (from TC-RCV) and seeded RISI prices + Purchase schedule. |
| **Steps** | 1. Open the supplier schedule (RISI White Ledger − $0.0075/lb) and the market price list. 2. Open the settlement → **Calculate Settlement**. 3. Add a schedule penalty: Moisture % over 10% at $0.50/pt (lot moisture 12%). 4. Recalculate. 5. Mark **Provisional Paid**. 6. Enter a later RISI value, recalc, mark **Final Settled**. |
| **Expected** | (1) prices stored $/lb with $/ton raw rate — verify precision e.g. Feb RISI SOP = `0.0925` (FLOAT, not `0.09`). (2) `effective = index × % + adj`, gross/net/balance shown. (4) a deduction row for Moisture % (excess 2 pts). (5) provisional **Vendor Bill** auto-created (tranid `SETTLE-…-PROV`). (6) **final Vendor Bill** for the balance (true-up). |

---

## TC-SETTLE-STATUS — Settlement status guards

| | |
|---|---|
| **Preconditions** | A settlement in Completed. |
| **Steps** | 1. Try to transition to **Final Settled** with the **Price Fixed** flag unchecked. 2. Check Price Fixed, retry. 3. Void a settlement that already has bills. |
| **Expected** | (1) **blocked (SETTLE-012)**: "Cannot transition… Price Fixed flag is unchecked." (2) transition succeeds, final bill created. (3) status Voided; **bills are NOT auto-voided** (confirm dialog warned of this — reverse manually). |

---

## TC-CALC — Handshake calculator settlement

| | |
|---|---|
| **Preconditions** | Vendor exists (seeded **Fox Valley Recycling**); config fee item/expense account set (seeder does this). |
| **Expected** | Total auto-computes `20,000 × 0.08 = $1,600`; settlement saves with mode **Calculator** (pink banner), method Fixed Price, status Final Settled; final **Vendor Bill** auto-created by the StatusChange UE. |
| **When to use** | The calculator is the *handshake* path — a price agreed on the spot with no schedule, no receipt, no quality data. Use it when a driver and yard manager settle on a number at the gate. Everything else (receipt-driven, schedule-priced, penalty-bearing) flows through the normal settlement records, not this page. |

**Field-by-field entry** (open **SUST - Settlement Calculator**):

| Field | Enter | Why |
|---|---|---|
| Vendor | **Fox Valley Recycling** | Mandatory. Any vendor works; this one is seeded. |
| Settlement Date | *(leave)* — defaults to today | Mandatory, pre-filled. |
| Agreed Weight (lbs) | **20000** | The handshake weight. Pounds, not tons. |
| Agreed $/lb | **0.08** | The handshake price. Total = weight × price, computed for you. |
| Total Settlement Value ($) | *(leave)* | Display of the computed total; only override for a lump-sum deal. |
| Settlement Notes / Context | e.g. "Gate deal — mixed load, agreed with driver" | Recommended: this is the only audit trail of *why* the price was agreed. |
| Mark as Final Settled now? | **Check** to demo the full flow | Checked → status Final Settled and the final Vendor Bill is created immediately. Unchecked → stays Draft for later review. |

Click **Create Calculator Settlement** → you land on the new settlement record.

---

## TC-AGG — Weekly aggregated settlement → finalize → payable ⭐

| | |
|---|---|
| **Preconditions** | Seeder run (stages the `[SUSTDEMO AGG]` sample and sets Fox Valley Recycling's **Settlement Cadence = Weekly**). |
| **What it shows** | One parent settlement per vendor per week instead of one per receipt, with full drill-down to the receipts that make it up, real deductions, and the path to the vendor payable. |

**Walkthrough:**

1. **Open the aggregated settlement** (link on the seeder results row, or the newest Draft settlement whose **Settlement Period** field is populated, e.g. `2026-W30`).
2. **Purple "Weekly Aggregated Settlement" panel** at the top marks it as a PARENT and lists each **receipt slice**: Item Receipt (click to drill down), line, date, lot, gross/net lbs, slice value, with totals. The same rows live on the **Settlement Receipt Slice** child sublist.
3. **Economics are populated like a real one**: Gross Value ($2,394 = 39,900 net lbs × $0.06) − **Moisture penalty** ($199.50 = 2 pts over the 10% threshold × $0.0025/lb/pt; see the Penalty Detail child row) − **Treatment charge** ($150) = **Net Value / Balance Due ≈ $2,044.50**.
4. **Live aggregation** (optional): weigh in a new scale ticket against a Fox Valley PO — the receipt's scrap line appends to this week's settlement as a new slice rather than creating a new settlement.
5. **Finalize → payable** (same lifecycle as any settlement — aggregation changes nothing downstream):
   1. End of week: review the settlement, optionally **Calculate Settlement** to re-derive pricing/penalties from schedules.
   2. Set Status **Completed**.
   3. *(Optional demo beat)* Try **Final Settled** with **Price Fixed** unchecked → blocked (SETTLE-012).
   4. Check **Price Fixed** → set Status **Final Settled** → the StatusChange UE **auto-creates the final Vendor Bill** for the balance due. (Or use **Provisional Paid** first for a provisional bill + later true-up, as in TC-INDEX.)

---

## TC-COSTFLOW — Deferred-cost flow-back ⭐

| | |
|---|---|
| **Preconditions** | A processing record in **Awaiting Cost** (TC-PROC with $0 input cost) linked to a settlement. |
| **Steps** | 1. Open the linked settlement, calculate, and move it to Completed/Provisional Paid/Final Settled. 2. Re-open the processing record and its output lots. |
| **Expected** | CostFlowBack re-runs allocation with the settlement **net value** as input cost; per-output-line allocated cost / cost-per-lb / weight-pct written; processing flips Awaiting Cost → Completed and **re-fires the Inventory Adjustment** (output lots now carry cost). Sold-before-settled lots produce a logged recommended JE (none auto-created — verify in script logs). |

---

## TC-SO — 2:30 Order-to-cash on actual weight

| | |
|---|---|
| **Preconditions** | Customer Packaging Mill A + Sale schedule (RISI SOP + $10/ton) seeded. |
| **Steps** | 1. New Sales Order, Packaging Mill A, item SOP, qty 100,000 lbs. 2. Save, view. 3. Fulfill → from the fulfillment, **Shipping Matrix** → build shipment, enter pallet weights, **Print BOL** → Mark Shipped. 4. Invoice from the fulfillment quantities. |
| **Expected** | (2) line auto-priced at **RISI SOP + $10/ton** with the formula memo in the line description; blue "Index-priced order" banner on view. (3) consolidated shipment created, pallet totals roll up (lbs+tons), BOL PDF with Sustana header + signature lines; status → Shipped. (4) invoice on actual weight; drill invoice → SO → fulfillment → lot → receipt. |

---

## TC-SHIP — Shipping matrix mechanics

| | |
|---|---|
| **Preconditions** | ≥2 shipped, unlinked Item Fulfillments. |
| **Steps** | 1. Shipping Matrix list → New. 2. Select 2 fulfillments → Create. 3. Detail: enter pallet net & gross → Save Pallets. 4. Mark as Shipped. 5. Try editing pallets after Shipped. |
| **Expected** | (2) shipment Open, fulfillments stamped `custbody_sust_consol_shipment`. (3) tare auto = gross − net; totals update; fulfillment total pallets/net/gross written back. (4) status Shipped. (5) edit buttons hidden once Shipped. |

---

## TC-CLOSE — 5:00 Close-out dashboard

| | |
|---|---|
| **Preconditions** | Several settlements in mixed statuses/ages. |
| **Steps** | 1. Open **SUST - Settlement Close Dashboard**. 2. Set Days Threshold 30 → Refresh. 3. Click a settlement deep-link. |
| **Expected** | Tiles: Watch / Stale / Total Balance Due / Index Price Not Fixed / Awaiting Cost; table rows show WATCH/STALE age badges and "Index Price Not Fixed" flags. |
| **TC-CLOSE-02 (known defect)** | (3) **Verify the deep-link actually opens the settlement.** The link builds `custrecordentry.nl?rectype=<id>` with the record's internal id rather than the record-*type* id — expected to mis-resolve. Log as a bug if it 404s / opens the wrong record. |

---

## TC-LCNRV — Period-end write-down review

| | |
|---|---|
| **Preconditions** | On-hand lots where cost > NRV; run the LCNRV scheduled test (`SUST_SS_LCNRVTest`) to flag reviews. |
| **Steps** | 1. Open **SUST - LCNRV Dashboard**. 2. Row action **Mark No Action** on one review. 3. Row action **Post Adjustment** on another. |
| **Expected** | Tiles reflect counts + total variance. (2) status → 'Reviewed - No Action', reviewer set, no GL. (3) status → 'Reviewed - Adjustment Pending', redirect to a **new Inventory Adjustment** pre-filled with `custbody_sust_lcnrv_review`. |

---

## TC-POS — Fiber position report

| | |
|---|---|
| **Preconditions** | Open PO(s) + on-hand lots. |
| **Steps** | Open **SUST - Fiber Position Report**. |
| **Expected** | Tiles Expected Inbound / On Hand / Total Position (tons). Expected Inbound uses **open** PO qty = `|quantity| − |quantityshiprecv|` (not double-counting on-hand); On-Hand grouped by grade; tons = lbs/2000. Read-only. |

---

## TC-PDF — Vendor settlement PDF & email

| | |
|---|---|
| **Preconditions** | A calculated settlement with penalties; vendor with a primary email. |
| **Steps** | 1. From the settlement, **Print PDF**. 2. **Email to Vendor** (confirm). 3. Toggle a section flag (`_show_deduct` / `_show_treat` / `_show_pen`) and reprint. |
| **Expected** | PDF: Sustana header, weights & yield (lbs+tons), pricing ($/lb+$/ton), deduction lines, totals (net − provisional = balance), 7-business-day dispute footer. Email sends with the PDF attached (subject has settlement # and $balance); error page if the vendor has no email. Section toggles hide/show the matching block. |

---

## TC-CONFIG — Config indirection (negative test)

| | |
|---|---|
| **Preconditions** | Ability to blank a config key in a scratch/sandbox. |
| **Steps** | Temporarily clear a config value (e.g. `settlementFeeItem` and `settlementExpenseAccount`) and trigger a bill-creating transition. |
| **Expected** | No numeric fallback and no silent wrong id — the code **logs + skips** (bill not created). Confirms "missing config = skip, never a fallback." Restore config after. |

---

# Automated-coverage gap analysis

The Jest suite (`npm test`) is **6 suites, ~131 tests**, using `N/*` mocks under
`tests/mocks/N/`. It runs off the source in `src/FileCabinet/SuiteScripts/` with no account.
It proves **pure logic and branch behavior**; it cannot prove NetSuite-side effects (real
record saves, PDF/email rendering, form layout, inventory/GL posting). Use it as a regression
gate; use the manual cases above for everything it can't reach.

## What the Jest suite covers today

| Suite | Script(s) under test | What it proves |
|---|---|---|
| `units.test.js` | `SUST_Lib_Units` | ton↔lb and $/ton↔$/lb conversions, formatting, round-trips (1 ton = 2000 lbs). |
| `marketPrice.test.js` | `SUST_Lib_MarketPrice` | INDEX_MAP is the 4 RISI sources matched by **text**; `storeIndexPrice` $/ton→$/lb + dedupe/update; `getLatestPrice` / `getPriceForDate` effective-dated (`onorbefore`) lookup; manual source returns null; old metals API gone. |
| `scaleTicket.test.js` | `SUST_SL_ScaleTicket` + `SUST_CS_ScaleTicket` | GET blank/next-number/PO dropdown/correction mode; POST validation, **duplicate guard**, no-PO fallback, PO→IR transform (weights + lot = ticket #), Received status + links, weight re-sync; client net math + save validation. |
| `settlementStatus.test.js` | `SUST_UE_Settlement_StatusChange` + `SUST_SL_SettlementCalculation` server calc | Status-change detection (DELETE/no-change/create no-op); provisional & final bill creation, skip conditions, negative balance, fee-item vs expense-account resolution + param override, **throws when neither configured**; approval fields; never-throw on load/create failure; the full calc (gross = netLbs × $/lb, schedule pct+adj, **all three penalty formulas**, threshold edge = no deduction, penalty-detail create/delete, netValue/balanceDue). |
| `shippingMatrix.test.js` | `SUST_SL_ShippingMatrix` | List/New/Detail/BOL GET modes; POST create (record + fulfillment linking), mark shipped, cancel; error page. |
| `soIndexPricing.test.js` | `SUST_UE_SO_IndexPricing` | No-op cases; schedule matching filters (customer/item/active, **skips Purchase-direction**); Fixed Price and `% of Index` rate + formula memo; no index value / manual source leaves line untouched; multi-line selectivity; beforeLoad banner. |
| `lineSettlementCreate.test.js` | `SUST_Lib_SettlementCreate.createLineSettlement` | **Defensive SELECT writes (INVALID_NUMBER fix):** a text market reference ("Custom") routes through `setText` not `setValue`; numeric ids still use `setValue`; non-numeric schedule id is skipped, not fatal; no-schedule falls back to Received Pricing; net = gross × recovery. |
| `itemReceiptSettlementGuard.test.js` | `SUST_UE_ItemReceipt_CreateSettlement` | **Multi-receipt guard fix:** a later receipt still creates a settlement when the PO only has receipt-linked settlements; IR auto-create is skipped only for a genuine settle-before-receipt settlement; first receipt on a clean PO creates one. |

**Well-covered logic you can trust from CI:** unit conversions, market-price storage &
effective-dated lookup, scale-ticket flow, settlement pricing + penalty math, settlement
bill-creation branching, SO index pricing, shipping-matrix request routing.

## Gaps — scripts with NO automated coverage

These have **zero Jest tests**; they are only validated by the manual cases above (mapped in
the right column). Highest business risk first.

| Untested script | Risk / why it matters | Covered manually by |
|---|---|---|
| **`SUST_Lib_CostAllocation`** | Core GAAP engine (Weight / Byproduct / Relative NRV) + NRV hierarchy (manual → index×recovery → last sale → 0). Drives inventory cost. **No unit tests at all** — highest-value gap. | TC-PROC, TC-COSTFLOW (indirect only) |
| **`SUST_UE_Processing_CreateInvAdj`** | Creates the Inventory Adjustment, output lots, genealogy; deferred-cost 'Awaiting Cost' branch. Complex, side-effect-heavy. | TC-PROC, TC-COSTFLOW |
| **`SUST_UE_Settlement_CostFlowBack`** | Re-runs allocation, re-fires deferred IA, sold-before-settled JE detection. | TC-COSTFLOW |
| **`SUST_UE_ItemReceipt_LandedCost`** | Sets line rate = Index Base + Premium + Freight + Financing (inventory valuation). | TC-RCV |
| `SUST_UE_ItemReceipt_CreateSettlement` | ~~Auto line-settlement creation, After-Processing deferral, dedupe.~~ **Now partially covered** (`itemReceiptSettlementGuard.test.js`) for the PO-level guard; line-lot gathering + deferral still manual. | TC-RCV, TC-KIOSK, TC-RCV-MULTI |
| `SUST_Lib_SettlementCreate` | ~~Shared settlement-creation library.~~ **Now partially covered** (`lineSettlementCreate.test.js`) for SELECT-write safety + weights; schedule lookup + market pricing still manual. | TC-RCV, TC-RCVLINE |
| **`SUST_UE_ItemReceipt_BridgeVendorLot`** | Vendor-lot bridge + lot status init. | TC-RCV, TC-KIOSK |
| **`SUST_UE_Processing_DerivedFields`** | Yield/mass-balance banner + per-line cost derivation. | TC-PROC |
| **`SUST_UE_SettlementModeLock`** | Field locking + **SETTLE-012 Price-Fixed blocker** (the one UE that DOES throw). | TC-SETTLE-STATUS |
| **`SUST_SL_ProcessingEntry`** + CS | tons↔lbs on the form; output-line rebuild; template load. | TC-PROC |
| **`SUST_SL_LotQualityEntry`** + CS | Quality write, regrade audit note, Received→Yard advance. | TC-LOTQ |
| **`SUST_SL_SettlementCalculation` (form/list render)** | Only the server calc is tested; form rendering & field locking are not. | TC-INDEX |
| **`SUST_SL_CalculatorSettlement`** | Handshake settlement creation. | TC-CALC |
| **`SUST_SL_SettlementScheduleEntry`** + CS | Schedule + penalty-line save, numeric parsing. | (schedule used across TC-INDEX/TC-SO) |
| **`SUST_SL_CreateLineSettlement`** | On-demand line settlements, settle-before-receipt. | TC-RCVLINE (add if needed) |
| **`SUST_SL_AllocationPreview`** | Weight-proportional multi-receiver split math. | (add case if multi-receiver is in scope) |
| **`SUST_SL_SettlementCloseDashboard`** | Aging bands + **the known deep-link defect**. | TC-CLOSE / TC-CLOSE-02 |
| **`SUST_SL_LCNRVDashboard`** + `SUST_SS_LCNRVTest` | Variance flagging + review actions + write-down IA prefill. | TC-LCNRV |
| **`SUST_SL_PositionReport`** | Open-PO netting formula. | TC-POS |
| **`SUST_SL_SettlementFormPDF`** | PDF sections + section toggles + email. | TC-PDF |
| **`SUST_SL_SeedSustanaDemo`** | Idempotency; environmental gotchas (Location.subsidiary single-select, GL restrictions, acctnumber). | TC-SEED |
| **`SUST_UE_POValidation`** | Pricing-timing default + per-mode warnings. | TC-RCV (banner check) |
| **`SUST_UE_LineSettlementLinks`** | Line-links panel on PO + IR. | TC-RCV, TC-RCVLINE |
| **`SUST_UE_ItemReceipt_Buttons`** + CS | IR view buttons. | TC-LOTQ, TC-PROC (entry points) |
| **`SUST_UE_FulfillmentDefaults`** | Fulfillment → Shipping Matrix button. | TC-SO, TC-SHIP |
| **`SUST_Lib_Config`** | Config get + param override + missing-key skip. | TC-CONFIG |
| **`SUST_CS_SettlementCalculation`, `SUST_CS_ShippingMatrix`** | Client-side calc/confirm dialogs. | TC-INDEX, TC-SHIP |

## Recommended next automated tests (highest ROI)

The manual cases will always be needed for record/GL/PDF side effects, but these units are
pure enough to test with the existing `N/*` mocks and carry the most financial risk:

1. **`SUST_Lib_CostAllocation`** — all three modes + the 4-level NRV hierarchy + the
   byproduct-cap-at-input-cost and residual-absorption rules. (Biggest gap.)
2. **`SUST_Lib_SettlementCreate`** — net = gross × recovery/100, schedule-driven net value,
   line-scoping, dedupe. Underpins three entry points.
3. **`SUST_UE_ItemReceipt_LandedCost`** — the `round4(indexBase + premium + freight +
   financing)` rate and the "provisional value missing" no-invent branch.
4. **`SUST_UE_SettlementModeLock`** — assert SETTLE-012 **does** throw when Price Fixed is
   unchecked (the sole intended throw; easy to regress into silence).
5. **`SUST_Lib_Config`** — param-overrides-config precedence and the missing-key skip.

## Coverage command

`npm run test:coverage` produces a per-file line/branch report; expect the `SUST_Lib_*`
(except Units/MarketPrice) and most `SUST_SL_*`/`SUST_UE_*` files above to show 0% until the
recommended tests are added.
