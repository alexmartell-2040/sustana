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
| **Preconditions** | Fresh deploy; both subsidiaries exist. |
| **Steps** | 1. Open **SUST - Seed Sustana Demo**. 2. Leave all non-optional groups checked. 3. Run Selected Groups. 4. Re-run once more. |
| **Expected** | Config record created; 4 locations (Markham/Cincinnati/Buffalo/St Joseph); items White Ledger / Mixed Paper / Mixed Office Paper / SOP / Mill Residuals; vendor Fox Valley Recycling; customer Packaging Mill A; RISI SOP + RISI White Ledger monthly prices; 2 schedules (Purchase + Sale); PO-10001 open; 3 on-hand yard lots. Second run reports updates, **no duplicates, no errors** (all `SUSTDEMO_*` externalids). |

---

## TC-RCV — 7:00 Phase-1 receiving (manual Item Receipt)

| | |
|---|---|
| **Preconditions** | TC-SEED done; PO-10001 open. |
| **Steps** | 1. Open PO-10001 → **Receive**. 2. Key gross 78,500 / tare 38,500 → net 40,000 lbs on the weight columns; quantity 40,000; lot `TRK-001`; location Cincinnati. 3. Save. 4. Edit the IR, change net to 39,500, save. |
| **Expected** | On save: indigo landed-cost banner (Index Base decomposition); a **line settlement (Draft)** auto-created, linked to PO + IR + line, priced ≈ RISI White Ledger − $15/ton; **lot exists, status Received**, vendor-lot bridged; system note on the IR. On edit: settlement **recalculates** to the new weight (weight true-up). |
| **Notes** | If the demo account's non-Sustana PO-approval workflow blocks receiving, resolve/disable that workflow first (environmental, not a Sustana defect). |

---

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
| **Preconditions** | Seeded on-hand lots WL-SEED-001, MP-SEED-001, SOP-SEED-001. |
| **Steps** | 1. Open **SUST - Processing Entry**. 2. Input (tons): 55 total across the seeded input lot(s). 3. Outputs: SOP 50 tons + Mill Residuals 3 tons. 4. Confirm the Yield/Loss banner. 5. Set Status Completed → Save. 6. Try to save with total output > input. |
| **Expected** | (4) banner: 53 out / 55 in, loss 2.00 tons, yield ≈ 96.4% (amber/green per threshold). (5) **Inventory Adjustment** posts (no WO/BOM), input consumed, output lots created (status **Yard**), **weight-mode cost allocation** across outputs, genealogy rows (Grade Transformation) link outputs to inputs. (6) blocked client-side. |
| **Notes** | If the sublist "Add" hangs the browser in the shared demo account, open a fresh tab (environmental). For deferred pricing, leave Total Input Cost $0 → record goes **Awaiting Cost**, IA deferred (see TC-COSTFLOW). |

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
| **Preconditions** | Vendor exists; config fee item/expense account set. |
| **Steps** | 1. Open **SUST - Settlement Calculator**. 2. Vendor, Agreed Weight 20,000 lbs, Agreed $/lb 0.08. 3. Check "Mark as Final Settled now?" → Create. |
| **Expected** | `total = 20000 × 0.08 = $1,600`; settlement mode **Calculator**, method Fixed Price, status Final Settled; final **Vendor Bill** created via StatusChange. |

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
| **`SUST_UE_ItemReceipt_CreateSettlement`** | Auto line-settlement creation, After-Processing deferral, dedupe. | TC-RCV, TC-KIOSK |
| **`SUST_UE_ItemReceipt_BridgeVendorLot`** | Vendor-lot bridge + lot status init. | TC-RCV, TC-KIOSK |
| **`SUST_Lib_SettlementCreate`** | Shared settlement-creation library used by IR UE, line-settlement Suitelet, kiosk. | TC-RCV, TC-RCVLINE |
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
