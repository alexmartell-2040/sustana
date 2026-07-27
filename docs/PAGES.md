# Sustana Recovery — Page Reference

What each screen shows and does, for end users, testers, and demo narrators. Covers every
custom Suitelet page and every native record form decorated by a Sustana User Event or
Client Script. For the wiring between pages see [ARCHITECTURE.md](ARCHITECTURE.md); for
validation steps see [TEST_CASES.md](TEST_CASES.md).

**Two conventions that apply everywhere:**

- **Weights are stored in pounds, money in $/lb.** Tons (1 ton = 2,000 lbs) and $/ton are
  display-only, converted by `SUST_Lib_Units`. Exception: **Processing Entry collects tons**
  and converts to lbs on save; the scale kiosk and Shipping Matrix collect lbs.
- **No hardcoded internal ids.** Account-specific ids live on the single Config record
  (`customrecord_sust_config`) read via `SUST_Lib_Config`. Missing config = logged + skipped,
  never a numeric fallback.

Company blue `#2976F3` is the accent on newer pages (Position Report, line-settlement links,
SO index banner, LCNRV tiles, seeder).

---

## Custom Suitelet pages

### 1. Scale Kiosk — `SUST_SL_ScaleTicket` (+ `SUST_CS_ScaleTicket`)

**Purpose:** The receiving "scale system." Record a truck weigh-in and, when a PO is
selected, transform PO → Item Receipt in one submit — lot = ticket number, zero re-keying.

**Displayed (grouped form):**
- *Gate/Truck:* Ticket Number (mandatory, auto-suggests next `TRK-nnn`), Truck #, Supplier
  (mandatory vendor), Open Purchase Order (dropdown of that vendor's open POs; blank = ticket-only).
- *Weights:* Gross Weight (lbs, mandatory), Tare Weight (lbs, mandatory), Net Weight
  (disabled, auto = gross − tare), Weigh-In / Weigh-Out Time (default now).
- *Receiving:* Receiving Location, Gate Notes.
- On a ticket that already created an IR: yellow banner "This ticket already created Item
  Receipt #N … saving corrections re-syncs the weights."

**Inputs / URL modes:** `?` blank kiosk · `?ticket=<id>` correction mode (ticket # locked) ·
`?vendor=<id>` reloads to rebuild the PO dropdown. Submit button label: "Create Ticket &
Receive" (new) / "Update Ticket & Re-sync Receipt" (edit).

**Client validation (saveRecord blocks):** missing ticket #, missing supplier, gross ≤ 0,
tare < 0, tare ≥ gross. `fieldChanged` recomputes net live; changing Supplier reloads.

**On submit (POST):** recompute net (2-dp round) and re-validate. **Duplicate-ticket guard**
(create only): if the ticket number exists, nothing is created — warning + link to the
existing ticket. Then:
- *With PO:* `record.transform` PO → Item Receipt; first receivable line qty = net lbs;
  writes `custcol_sust_scrap_gross_weight` / `_net_weight`, `custbody_sust_scale_ticket`, lot
  (`receiptinventorynumber`) = ticket number, location. Saving the IR fires the whole IR UE
  chain. Ticket status → **Received**, IR linked.
- *Correction path:* re-syncs corrected weights to the linked IR (no re-transform).
- *No PO (outage fallback):* ticket only, status **Weighed Out**; receive manually later.
- Success page links: Scale Ticket, Item Receipt, auto-created Settlement (if any), Lot.

**Formulas:** net = round(gross − tare, 2). Ticket auto-increment `TRK-###`.

---

### 2. Lot Quality & Grade Entry — `SUST_SL_LotQualityEntry` (+ `SUST_CS_LotQualityEntry`)

**Purpose:** Enter/edit quality attributes for all lots on an Item Receipt and clear lots
into the yard.

**Displayed:** Title "Lot Quality & Grade Entry - Item Receipt {tranid}". Inline-editor
sublist with columns: Lot Number, Lot ID, Item, Quantity (all disabled), **Moisture %,
Contamination %, Fiber Content %** (percent), **Bale Count** (integer), Yield %, Vendor Lot
Number. Pre-populated with each lot's current values.

**Inputs:** requires `?itemreceiptid=<id>`. Submit "Save Lot Quality"; "Cancel" returns to IR.

**Client validation:** percent value < 0 or > 100 → "Line N: percent values must be between
0 and 100."; a lot with no quality values entered is blocked.

**On submit (POST):** for each lot, load its `inventorynumber` record and write
`custitemnumber_sust_moisture_pct` / `_contamination_pct` / `_fiber_content_pct` /
`_bale_count` / `_recovery_percentage` (yield) / `_vendor_lot_number`; set source type =
'Purchased' if empty. **Regrade audit:** on a changed value, append
`[Quality Regrade YYYY-MM-DD, IR n] Field: old -> new` to `custitemnumber_sust_lot_notes`
(original preserved). **Lot status advance:** empty/'Received' → **'Yard'** (never regresses
later statuses). Redirect back to the IR.

---

### 3. Processing Entry — `SUST_SL_ProcessingEntry` (+ `SUST_CS_ProcessingEntry`)

**Purpose:** Record a processing run — 1 input lot → M output materials, no BOM/Work Order.
Form is in **tons** (converts to lbs on save).

**Displayed:**
- *Awaiting-cost banner* (edit only): amber "AWAITING COST — IA DEFERRED" with a link to the
  linked settlement, when the record was completed at $0 input cost.
- *Header:* Processing Number (auto `PROC-YYMMDD-NNN`), Processing Date (mandatory, default
  today), Status (Draft / In Process / Completed, mandatory), Processing Type (mandatory),
  Operator, Location, Source Transaction.
- *Input Material:* Source Type, Equipment, Input Item (mandatory), Input Lot (mandatory),
  Input Weight (tons, mandatory), Gross/Tare Estimate/Tare Actual (tons), Total Input Cost
  ($ — help: "Leave $0 for Post-Processing deferred-pricing mode"), Allocation Mode (Byproduct
  default = GAAP-recommended / Relative NRV / Weight).
- *Output Materials* inline-editor: Line #, Output Item (mandatory), Output Type (mandatory),
  Weight (tons, mandatory), % of Input (disabled/auto), Output Lot (auto), Disposition.
- Processing Notes.

**Inputs / URL modes:** `?processingid=<id>` edit · `?itemreceiptid=<id>` (+ optional
`?line=`) pre-populates from an IR scrap line. Buttons: Submit "Save Processing Record",
"Load Default Outputs" (pulls `customrecord_sust_item_output_template` for the input item),
"Clear Output Lines".

**Client validation:** blocks 0 output lines and total output > input; recomputes % of input.

**On submit:** saves parent + recreates output lines (tons→lbs), sets
`custrecord_sust_output_percentage`. A NEW record requested as Completed is saved Draft first
then flipped to Completed so the UE fires cleanly. Then the two Processing UEs run (see
[decorated records](#processing-record-customrecord_sust_processing_record)).

**Note:** the account has a documented browser-save hang on this form's sublist "Add" in the
shared demo account (heavy pre-existing client bundles) — open a fresh tab if it hangs.

---

### 4. Settlement Calculation — `SUST_SL_SettlementCalculation` (+ `SUST_CS_SettlementCalculation`)

**Purpose:** The main settlement workbench — create/edit a supplier settlement with
status-driven field locking, schedule-driven pricing, quality-deduction (penalty) calc, and
status transitions that trigger vendor bills.

**Displayed:**
- *List mode* (no params): "Create New Settlement" button + sublist (View, ID, Vendor,
  Settlement Date, Status, Method, Gross Lbs [+tons], Net Value).
- *Form mode* (`?settlementid=` or `?new=T`), grouped:
  - *Settlement Information:* Vendor/Customer (mandatory), Settlement Date (mandatory), Status
    (filtered to valid transitions), Settlement Method (mandatory), Pricing Schedule.
  - *Material Information:* Gross Weight (lbs, mandatory), Net Weight (lbs), Recovery %
    (disabled/auto), tons-equivalent note.
  - *Pricing Details:* Market Price ($/lb, help shows latest index & $/ton), Market Price
    Source, Treatment Charges, Total Penalties (disabled, server-calculated).
  - *Settlement Values:* Gross Value (disabled), Net Settlement Value (disabled, mandatory),
    Provisional Paid, Balance Due (disabled).
  - *Linked Bills:* Provisional Bill / Final Bill (inline when present). Settlement Notes.
- **Field locking by status:** Auto mode locks calc fields; Completed+ locks header;
  Provisional+ locks material/pricing; Final Settled / Voided = read-only.

**Buttons (when editable):** "Calculate Settlement", "Refresh Market Price", Submit "Save
Settlement", "Cancel". AJAX GET endpoints: `?action=getprice&source=` (latest index JSON),
`?action=calculate&settlementid=` (full server calc JSON).

**Calculation (on Calculate and on Save):**
`effectivePrice = (marketPrice × schedulePct/100) + scheduleAdj`; if method contains "Recover"
and recovery% > 0 then `recoveryFactor = recoveryPct/100` else 1;
`grossValue = netLbs × effectivePrice × recoveryFactor`; compute penalties; `netValue =
grossValue − treatment − totalPenalties`; `balanceDue = netValue − provisional`. Persists
values and writes `customrecord_sust_penalty_detail` rows (deletes prior details first).

**Penalties (per schedule penalty definition mapped to a measured lot metric, when
actual > threshold):** PER_PERCENTAGE = `excessPct × rate × netLbs`; FLAT_FEE = `rate`;
PCT_REDUCTION = `grossValue × rate/100`.

**Status change confirmations (client):** Completed (locks fields), Provisional Paid (requires
provisional amount, warns of provisional bill), Final Settled (final bill vs credit), Voided
(bills not auto-voided). Bill creation itself is done by the settlement UEs.

---

### 5. Settlement Calculator (Handshake Mode) — `SUST_SL_CalculatorSettlement`

**Purpose:** Create a standalone settlement with no Item Receipt/processing — a flat
handshake $/lb for known material.

**Displayed:** pink "🤝 Calculator Mode" banner; Vendor (mandatory), Settlement Date
(mandatory, default today), Agreed Weight lbs (mandatory), Agreed $/lb, Total Settlement Value
(optional override), Notes, "Mark as Final Settled now?" checkbox. Submit "Create Calculator
Settlement".

**On submit:** `total = weight × ratePerLb` unless overridden. Creates a settlement record:
gross = net = weight (no recovery), market_price = rate, gross_value = net_value = balance_due
= total, mode = 'Calculator', method = 'Fixed Price', status = 'Final Settled' (if checked)
else 'Draft'. Final Settled → StatusChange UE creates the vendor bill.

---

### 6. Settlement Schedule Entry — `SUST_SL_SettlementScheduleEntry` (+ `SUST_CS_SettlementScheduleEntry`)

**Purpose:** Create/edit vendor (Purchase) or customer (Sale) pricing schedules with
quality-deduction definitions. Prices stored $/lb; help shows $/ton.

**Displayed:**
- *Schedule Information:* Direction (Purchase/Sale), Vendor (Purchase) / Customer (Sale),
  Material Item (Grade), Pricing Method (mandatory).
- *Pricing Details:* Base Price ($/lb), Market Reference, Market Percentage, Index Adjustment
  ($/lb, help "−$15/ton = −$0.0075/lb"), Processing Charge ($/lb), Minimum Content %.
- *Validity Period:* Active (default T), Effective Date, Expiration Date.
- *Quality Deductions* inline-editor: Quality Metric, Calculation Type, Threshold %, Penalty
  Rate ($/lb per %).

**Client validation:** missing vendor / missing method / expiration ≤ effective are blocked.

**On submit:** saves schedule (numerics stripped of %/$/comma) + penalty lines to
`customrecord_sust_settlement_penalty` (Calc Type defaults "Per Percentage Point"). These
definitions are consumed by Settlement Calculation and SO index pricing.

---

### 7. Create / Manage Line Settlements — `SUST_SL_CreateLineSettlement`

**Purpose:** On-demand, line-scoped settlement creation — for recovery-priced lines the IR UE
deferred, and for settle-before-receipt directly from a PO.

**Displayed:** header banner "{PO/IR} #id · Vendor: …"; "Material Lines" sublist (Create
checkbox, Line, Key, Item, Item ID, Qty lbs, Pricing Timing, Existing Settlement). Only scrap
lines listed.

**Inputs:** `?txn=<id>&type=po|ir`. Submit "Create Selected Settlements".

**On submit:** for each checked, un-settled line, gather fresh weight + IR lot detail +
recovery% and call `SUST_Lib_SettlementCreate.createLineSettlement`. Redirect back to source.

---

### 8. Multi-Receiver Allocation Preview — `SUST_SL_AllocationPreview`

**Purpose:** Read-only reference to split a processing run's recovered fiber back across
multiple source receivers for per-PO settlement.

**Displayed:** blue help banner; Processing Record select; "Refresh Preview". When loaded:
header summary (Processing Record, True Net Input, Total Output, Mass Balance %, Recovered
Fiber, Total Input Cost, # Source Receivers) and an allocation table (#, Source Receiver Lot,
Item Receipt, Input Qty lbs+tons, % Share, Allocated Recovered, Allocated Cost).

**Inputs:** `?proc=<id>`. **No side effects** (pure preview).

**Formulas:** `pct = receiverQty / totalInputWeight`; `allocatedRecovered = recoveredFiber ×
pct`; `allocatedCost = totalInputCost × pct`.

---

### 9. Settlement Close-Out Dashboard — `SUST_SL_SettlementCloseDashboard`

**Purpose:** Month-end controller checklist of open settlements (Draft / Completed /
Provisional Paid) past a day threshold.

**Displayed:** indigo banner; Days Threshold (default 30); "Refresh". Tiles: 🟡 Watch
(threshold+1–60 days), 🔴 Stale (>60), 💰 Total Balance Due, 🔒 Index Price Not Fixed,
⏳ Awaiting Cost (processing count). Table: Settlement (link), Vendor, Status, Mode, Date, Age
(WATCH/STALE badges), Net Value, Balance Due, Flags. **Read-only.**

**Inputs:** `?days=`, `?status=`.

> **Known defect to verify:** the settlement deep-link uses `custrecordentry.nl?rectype=<id>`
> with the record's *internal id* rather than the record-*type* id — the link may not resolve.
> Flag in UAT (see TEST_CASES.md TC-CLOSE-02).

---

### 10. LCNRV Review Dashboard — `SUST_SL_LCNRVDashboard`

**Purpose:** Controller resolves LCNRV write-down reviews flagged by the scheduled test
(`SUST_SS_LCNRVTest`).

**Displayed:** tiles (Pending Review, Reviewed-NA, Adjustment Pending, Total Variance — blue).
Status filter + "Filter". Reviews sublist: Run Date, Lot, Item, Qty (lbs+tons), Cost/lb
(+$/ton), NRV/lb (+$/ton), Variance $, Variance %, NRV Source, Status, **Actions** (inline
"Mark No Action" / "Post Adjustment").

**Row actions (GET):**
- *no_action:* status → 'Reviewed - No Action', reviewer = current user. No GL impact.
- *post_adj:* status → 'Reviewed - Adjustment Pending', reviewer; redirects to a **new
  Inventory Adjustment** pre-filled with `custbody_sust_lcnrv_review` = review id (controller
  posts the write-down).

---

### 11. Fiber Position Report — `SUST_SL_PositionReport`

**Purpose:** Recovered-fiber position by grade, in tons: expected inbound (open PO,
un-received) + on-hand inventory.

**Displayed:** blue banner; "Data as of <UTC timestamp>" strip with a Refresh link
(everything computes live on page load — no cache); tiles Expected Inbound / On Hand /
Total Position (tons) + **Lot Exceptions** (red when > 0). **Yard operational view**:
*Tons by Site & Status* matrix (rows = locations, columns = Received / Yard / Processing
Queue / Staged) and *Yard Lots* detail (Lot #, Site, Grade + material category, status
badge, Tons, Quality M%/C%, Exception badges, Action column saying what to do). Exception
rules: Moisture > 12%, Contamination > 5%, Ungraded > 2 days in Received, Aging > 14 days
in Yard/Processing Queue. Exception lots sort first and link to the lot record. Then the
two position tables — *Expected Inbound* (PO #, Vendor, Order Date, Grade, Open Lbs, Open
Tons + subtotal) and *On-Hand Inventory* (Grade, On-Hand Lbs, On-Hand Tons + subtotal).
**Read-only.**

**Inputs:** optional `?sub=<id>` (else script param → config usSubsidiary → unfiltered).

**Formula:** open PO qty = `|quantity| − |quantityshiprecv|` (netted so on-hand isn't
double-counted); tons = lbs / 2000.

---

### 12. Settlement Form PDF — `SUST_SL_SettlementFormPDF`

**Purpose:** Vendor-facing settlement document (many vendors treat it as their invoice) and
optional email.

**Displayed (PDF sections):** header "SUSTANA RECOVERY SETTLEMENT FORM" + #/date; Status /
Mode / Method; Vendor block (name, address, IR ref, Schedule); Weights & Yield (gross/net
lbs+tons, yield %); Pricing (market $/lb+$/ton, gross value); Deductions (processing charge,
per-penalty lines, total — respects section toggles `custrecord_sust_settle_show_deduct` /
`_show_treat` / `_show_pen`); Totals (net value, less provisional, balance due); footer
disclaimer with a 7-business-day dispute window.

**Inputs:** `?settle=<id>` (inline PDF), `&email=T` (email to vendor's primary email; error
page if none).

---

### 13. Shipping Matrix / Consolidated Shipment — `SUST_SL_ShippingMatrix` (+ `SUST_CS_ShippingMatrix`)

**Purpose:** Consolidate multiple Item Fulfillments into one shipment, capture per-pallet
weights, generate a BOL PDF.

**Displayed (URL `?mode=`):**
- *list:* "New Consolidated Shipment" + sublist (Ship Date, BOL #, Carrier, Pallets, Total
  Weight lbs+tons, Fulfillments, Status, Actions "Edit Pallets" / "Print BOL").
- *new:* header (Ship Date mandatory, Carrier, BOL Number, Notes) + "Available Fulfillments"
  inline-editor (Select, IF ID, Document #, Customer, Ship Date, Items) — shipped, unlinked
  fulfillments only. Submit "Create Consolidated Shipment".
- *detail:* header display (BOL, Carrier, Ship Date, Status); Linked Fulfillments; **Pallet
  grid** (Pallet #, Fulfillment #, Item, Net/Gross/Tare Weight lbs, Pallet Type, Notes); Totals
  (Total Pallets, Total Net/Gross lbs+tons). Buttons if Open: "Save Pallets", "Mark as
  Shipped", "Cancel Shipment"; always "Print BOL", "Back to List".
- *bol:* BOL PDF (ship from/to, BOL/carrier/date, fulfillments, pallet table, totals lbs+tons,
  signature lines).

**Actions (hidden `custpage_action`):** create_shipment (status Open, stamps
`custbody_sust_consol_shipment` on selected fulfillments), save_pallets (upsert/delete pallet
rows, update shipment totals, push totals to fulfillments), mark_shipped (Shipped),
cancel_shipment (Cancelled). Client: pallet tare auto = gross − net; confirm dialogs.

---

### 14. Demo Seeder — `SUST_SL_SeedSustanaDemo`

**Purpose:** Idempotent one-click demo/config bootstrap (all seeded records carry `SUSTDEMO_*`
external ids; re-running updates in place).

**Displayed:** banner + "Current state" + group checkboxes (config, locations, items,
entities, prices, schedules, po, onhand, planning[optional]); "Run Selected Groups"; results.

**On submit:** creates the Config record, GL accounts + fee item, 4 locations, 5 lot-numbered
items, vendor Fox Valley Recycling + customer Packaging Mill A, RISI SOP + White Ledger
monthly prices (Feb–Jul 2026), Purchase + Sale schedules, open PO-10001 (Determined on
Arrival), 3 on-hand yard lots, optional planning SOs/estimates.

**Prerequisite:** subsidiaries named exactly **Sustana Recovery US** and **Sustana Recovery
Canada** must exist first (the seeder verifies by name and fails fast if missing).

---

## Decorated native record forms

### Purchase Order — `SUST_UE_POValidation`, `SUST_UE_LineSettlementLinks`

- **Guidance banner** keyed on `custbody_sust_pricing_timing`: "Known at PO" (blue),
  "Determined on Arrival" (amber), "Determined After Processing" (pink — use a $0 "Material
  Pending Determination" placeholder), "Not Set" (gray).
- **beforeSubmit:** defaults pricing timing to 'Known at PO' if unset; non-blocking warnings
  per mode (Known at PO lines should be non-zero; After Processing lines should be $0).
- **View button:** "Create / Manage Line Settlements" + a line-links panel (supports
  settle-before-receipt).

### Item Receipt — five decorators (the intake hub)

Scripts: `SUST_UE_ItemReceipt_Buttons`, `SUST_UE_ItemReceipt_LandedCost`,
`SUST_UE_ItemReceipt_CreateSettlement`, `SUST_UE_ItemReceipt_BridgeVendorLot`,
`SUST_UE_LineSettlementLinks` (+ client `SUST_CS_ItemReceiptButtons`).

- **View:** buttons **"Enter Lot Quality"** and **"Process Material"**; blue **"Create /
  Manage Line Settlements"** link + line-links panel; indigo landed-cost help banner. Painted
  line columns: `custcol_sust_index_base`, `_premium`, `_freight`, `_financing_insurance`,
  `_scrap_gross_weight`, `_scrap_net_weight`, `_vendor_lot_number`, `_pricing_timing`,
  `_settlement_id`, `_processing_id`.
- **beforeSubmit (LandedCost):** for each line with Index Base > 0, line
  `rate = round4(indexBase + premium + freight + financing)` (drives inventory valuation).
  Scrap lines left at rate 0 log "Provisional Value Missing" (no invented value).
- **afterSubmit (CreateSettlement):** for each **scrap** line whose pricing timing is NOT
  "After Processing", create a line-scoped **Settlement (Draft)**. Recovery-priced lines are
  deferred to the button. Dedups per line; skips if PO already has settlements.
  **Settlement cadence:** the vendor's Settlement Cadence field (Per Receipt / Weekly /
  Monthly; list `customlist_sust_settle_cadence`) drives aggregation — Weekly/Monthly
  vendors get ONE open Draft settlement per period (`custrecord_sust_settle_period_key`,
  e.g. `2026-W30` / `2026-07`); receipt lines in the same period append weights/value to it
  (source keys tracked in `custrecord_sust_settle_agg_sources` so a re-save never
  double-counts). The seeder sets Fox Valley Recycling to Weekly.
- **afterSubmit (BridgeVendorLot):** copy line vendor lot # to the lot record; set new lots'
  status = 'Received'.

### Sales Order — `SUST_UE_SO_IndexPricing`

- **beforeSubmit:** for each line with an active **Sale** schedule (customer+item), set line
  `rate`, `amount = rate × qty`, `price = -1` (custom), and a description memo like
  `RISI SOP $200.00/ton x 100% + $10.00/ton = $210.00/ton`. `ratePerLb = (indexPricePerLb ×
  pct/100) + adj`, effective-dated to the order date. Fixed Price method uses base price.
- **View:** blue banner "Index-priced order:" listing each indexed line.

### Item Fulfillment — `SUST_UE_FulfillmentDefaults`

- **View:** one button — "Shipping Matrix" (opens detail mode) if
  `custbody_sust_consol_shipment` is set, else "Create Consolidated Shipment" (new mode).

### Processing Record — `customrecord_sust_processing_record`

Scripts: `SUST_UE_Processing_DerivedFields`, `SUST_UE_Processing_CreateInvAdj`.

- **beforeLoad (DerivedFields):** yield-loss banner — green ✓ within ±2%, amber ⚠ within ±5%,
  red ✗ >5%; shows Yield % and Loss tons.
- **beforeSubmit (DerivedFields):** `trueNet = gross − tareActual`; `totalOutput = Σ output`;
  `yield% = totalOutput/trueNet × 100`; per output line weightPct, allocatedCost, costPerLb.
- **afterSubmit (CreateInvAdj), on status → Completed:** if input cost = 0 and not
  Brokered/Repackage → status 'Awaiting Cost', IA deferred. Brokered/Repackage → no IA.
  Otherwise create an **Inventory Adjustment** (consume input lot, create output lots
  `PROC-<num>-OUTn`, unit cost from the allocation engine), set output lots 'Yard', create
  lot genealogy (`customrecord_sust_lot_relationship`), link the settlement.

### Settlement Record — `customrecord_sust_settlement_record`

Scripts: `SUST_UE_SettlementModeLock`, `SUST_UE_Settlement_StatusChange`,
`SUST_UE_Settlement_CostFlowBack`.

- **beforeLoad (ModeLock):** mode banner (⚙ Auto blue / ✎ Custom amber / 🤝 Calculator pink /
  🔒 Final-Voided gray) + action links "Print PDF" (dark blue) and "Email to Vendor" (green,
  confirm); field locks per mode/status.
- **beforeSubmit (ModeLock) — SETTLE-012 blocker:** transition to Final Settled with
  `custrecord_sust_settlement_price_fixed` unchecked **throws** "Cannot transition… Price
  Fixed flag is unchecked."
- **afterSubmit (StatusChange):** → Provisional Paid creates a provisional Vendor Bill
  (tranid `SETTLE-…-PROV`); → Final Settled creates a final Vendor Bill for
  `balanceDue = netValue − provisional`; Draft → Completed sets approver/date. Bill line uses
  config `settlementFeeItem` (item) else `settlementExpenseAccount` (expense).
- **afterSubmit (CostFlowBack):** on Completed/Provisional Paid/Final Settled, if linked to a
  processing record, re-run cost allocation with `net_value` as input cost, write per-output
  allocated cost, and if processing is 'Awaiting Cost' flip it to Completed to **re-fire the
  deferred Inventory Adjustment**. Sold-before-settled lots are logged (recommended JE; none
  created).
