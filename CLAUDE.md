# Sustana Recovery — SDF Demo Accelerator

NetSuite SDF Account Customization Project for the Sustana finalist demo (paper/fiber recycling).
Forked 2026-07-16 from the Nathan Trotter / Tin Tech metals accelerator, fully sanitized:
all chemistry/melt/oxide/LME concepts removed, every custom object scriptid renamed with a
`sust_` token (old→new map: [docs/rename_map.csv](docs/rename_map.csv)).

## Layout

- `src/FileCabinet/SuiteScripts/Sustana/` — all SuiteScript (flat, `SUST_<Type>_<Name>.js`)
- `src/Objects/` — all SDF object XML (flat)
- `tests/` — Jest with `N/*` mocks in `tests/mocks/N/`; run `npm test` (6 suites, 131 tests, all green)
- Deploy: `npx suitecloud project:validate` / `project:deploy` (wildcard deploy.xml — everything in src deploys)

## Iron rules

1. **All stored values and math are in POUNDS.** Tons appear only at UI/PDF edges via
   `SUST_Lib_Units` (`formatTons`, `formatPerTon`, `toLbs` on Suitelet POST where the form
   collects tons — currently only Processing Entry collects tons; the scale kiosk and
   Shipping Matrix collect lbs). Index prices are entered in $/ton and converted once in
   `SUST_Lib_MarketPrice.storeIndexPrice`.
2. **No hardcoded internal IDs.** Account-specific IDs live on the single Sustana Config
   record (`customrecord_sust_config`), read via `SUST_Lib_Config.get(key)`. Script
   parameters, where present, override the config value. Missing config = log + skip,
   never a numeric fallback.
3. **Custom-list values are matched by display TEXT** (`setText`/`getText`), never by
   internal id. Coverage is partial, spread across files: `settlementStatus.test.js`
   covers settlement-status and quality-metric texts (Moisture %/Contamination %),
   `marketPrice.test.js` covers market-source texts, `soIndexPricing.test.js` covers
   schedule-direction (Purchase/Sale), `scaleTicket.test.js` and `shippingMatrix.test.js`
   each incidentally cover one scale-ticket/lot-status value ('Weighed Out', 'Shipped').
   No file asserts the full lot-status enum. If you change a list value's text, update
   the matching code constant and its test (add one if none exists).
4. **UE afterSubmit never re-throws.** Inventory Adjustments use `isDynamic: false`, header
   order `trandate → subsidiary → adjlocation → account → memo`.
5. Weight columns keep their historical ids (`custcol_sust_scrap_gross_weight` etc.) —
   labels say "Gross/Net Weight (lbs)"; do not rename field scriptids (data + code churn).
6. **Derived $/lb price fields are FLOAT, never CURRENCY.** CURRENCY fields silently round to
   2 decimals on save. A $/ton index price or schedule adjustment converted to $/lb (e.g.
   $10/ton = $0.005/lb, $185/ton = $0.0925/lb) needs 3-4 decimal places — CURRENCY rounding
   corrupts it before anyone notices (0.005→0.01 is a 2x error; 0.0925→0.09 is a systemic
   ~1% error on every settlement). Only genuine whole-dollar TOTALS (`_cost_total`,
   `_gross_value`, `_balance_due`, `_provisional`, etc.) should stay CURRENCY. If you add a
   new $/lb field, set `fieldtype` to FLOAT and say why in the help text. **Deploy caveat:**
   an SDF `project:deploy` that changes an already-EXISTING field's type is not reliably
   applied — of 14 fields fixed this way, 13 updated live but 1 silently didn't. Always
   verify the live Type dropdown (Customization > Lists, Records & Fields > record type >
   Fields > the field) after deploying a type change; don't trust the deploy log's
   "Update object" line alone. If it didn't take, editing the Type combobox directly on the
   field's edit page and saving is safe and reliable.

## The demo spine (alignment doc: SUSTANA_DEMO_ALIGNMENT.md in the NT repo)

| Moment | Assets |
|---|---|
| 7:00/7:30 receiving | `SUST_SL_ScaleTicket` (kiosk = the scale system) → PO transform → IR; UE chain: `SUST_UE_ItemReceipt_LandedCost` (Index Base + Premium + Freight + Financing), `SUST_UE_ItemReceipt_CreateSettlement` (auto line settlement), `SUST_UE_ItemReceipt_BridgeVendorLot` (lot init, status Received) |
| 8:00 regrade | `SUST_SL_LotQualityEntry` (moisture/contamination/fiber/bale count; regrade audit in lot notes; Received→Yard) |
| 8:30 yard | `customlist_sust_lot_status`: Received → Yard → Processing Queue → Staged → Shipped (+ Depleted); genealogy `customrecord_sust_lot_relationship` |
| 9:15 processing | `SUST_SL_ProcessingEntry` (tons entry, Yield/Loss banner) + `SUST_UE_Processing_CreateInvAdj` (IA-based, no BOM/WO; WEIGHT cost allocation via `SUST_Lib_CostAllocation`) |
| 1:30 index pricing | `customrecord_sust_market_price` (RISI, $/ton→$/lb) + `customrecord_sust_settlement_schedule` (`% of Index`: index × % + adjustment) + provisional→final true-up (`SUST_SL_SettlementCalculation`, quality deductions from lot moisture/contamination) |
| 2:30 order-to-cash | `SUST_UE_SO_IndexPricing` (Sale-direction schedules price SO lines) + `SUST_SL_ShippingMatrix` (BOL PDF) |
| 5:00 close | `SUST_SL_SettlementCloseDashboard`, provisional vendor bills (`SUST_UE_Settlement_StatusChange`) |
| Seeding | `SUST_SL_SeedSustanaDemo` — idempotent (`SUSTDEMO_*` externalids); subsidiaries 'Sustana Recovery US'/'Sustana Recovery Canada' are a manual prereq |

## Display-text couplings (change list + code + test together)

- Market sources: `SUST_Lib_MarketPrice.INDEX_MAP` ↔ `customlist_sust_market_price_source`
- Settlement methods: `'% of Index'`, `'Fixed Price'`, `'Received Pricing'`, `'Recovered Pricing'` (SettlementCreate/SettleCalc/Calculator)
- Lot statuses: `'Received'/'Yard'/'Processing Queue'/'Staged'/'Shipped'/'Depleted'`
- Schedule direction: `'Purchase'/'Sale'` (SO pricing UE matches `'Sale'`)
- Quality metrics: `'Moisture %'/'Contamination %'` (SettleCalc deduction matching)
- Processing source types keep keywords `Receiver/Mount/Brokered/Repackage` (InvAdj UE matches by indexOf)
- Scale ticket statuses: `'Open'/'Weighed Out'/'Received'/'Voided'`

## Known deferred items

- `SUST_SL_IndexPriceEntry` (manual RISI entry Suitelet) — seeder covers demo prices; add if a live "import the index" moment is wanted.
- Dayforce payroll JE import — demo narrative is native CSV import (Ubique Map/Reduce pattern as the customized option).
- Power BI — SuiteAnalytics Connect narrative.
- ProcessingEntry hidden round-trip fields use HIDDEN display type (pre-existing); body-level hidden fields round-trip in production, but if corrections misbehave switch to DISABLED.

## Live-account gotchas (learned building the seeder against a real account)

- **`Location.subsidiary` is single-select** (plain `setValue`); `Item.subsidiary` is genuinely
  multiselect (array). Don't reuse one helper for both — a generic `setSubsidiaryField` that
  arrayifies will throw on Location.
- **A GL account's subsidiary restriction must be a superset of anything that posts to it.**
  An item/transaction restricted to specific subsidiaries needs its expense/income account
  restricted to at least those same subsidiaries (check "Include Children" to cascade a
  parent restriction, or list them explicitly) — otherwise saving throws "subsidiary
  restrictions are incompatible."
- **GL accounts in this shared demo account require a unique `acctnumber`.** A blank
  account-number field fails the save with no obvious on-screen error in a quick glance —
  if an account record save appears to silently do nothing, check `acctnumber` first.
- **A field can be "effectively mandatory"** (required by downstream logic even with
  `ismandatory` F) without a plain `record.save()` enforcing it — only skipped when the
  caller uses `ignoreMandatoryFields: true`. `updateSeededLot` learned this the hard way
  with `custitemnumber_sust_lot_source_type`: the IA's own save ignored mandatory fields,
  but the separate subsequent `lot.save()` did not.

## This account's pre-existing quirks (environmental — not Sustana defects, do not "fix")

- A **non-Sustana custom PO approval workflow** ("Pending Supervisor Approval") is active in
  this shared demo account, with no native "Approve Purchase Orders" center link. This blocks
  the live 7:00 PO-receiving walkthrough until an admin resolves it (disable/reassign the
  workflow, or find its own approval UI) — confirmed unrelated to any Sustana script or object.
- **Complex form saves reproducibly hang the browser-automation pane** in this account (seen
  on PO edit and Processing Entry sublist "Add") — confirmed not a full automation crash (new
  tabs open fine, network requests all return 200). Most likely triggered by this account's
  pre-existing heavy client scripts/bundles (P2P, VID, Iridize). If a save hangs, open a fresh
  tab rather than fighting it.

## Deploy status

Deployed to the `SUSTANA` demo account (`TD2952281`, authid `SUSTANA`). Subsidiaries were
created manually — **Sustana Recovery US** = internal id 207, **Sustana Recovery Canada** =
internal id 208 — and `SUST_SL_SeedSustanaDemo` has been run twice against them (idempotent:
the second run updated the `SUSTDEMO_*` records in place, skipped the non-re-runnable
inventory adjustment, and produced no duplicates or errors).

**Bugs found and fixed against the live account (all verified, not just deployed):**
- 14 `$/lb` fields were CURRENCY instead of FLOAT, silently rounding every derived price
  (see iron rule 6). Fixed in source, redeployed, and verified by reading back live stored
  values: Feb RISI SOP market price is now `0.0925` (was `0.09`), the supplier settlement
  schedule adjustment is `-$0.0075/lb` (was `-$0.01`), the customer schedule adjustment is
  `+$0.005/lb` (was `+$0.01`).
- 3 seeder bugs — Location.subsidiary set as an array, new GL accounts created with no
  subsidiary restriction, `updateSeededLot` missing a downstream-mandatory field — see
  "Live-account gotchas" above.
- A dead `SETTLEMENT_EXPENSE_ACCOUNT` reference in `SUST_UE_Settlement_StatusChange` silently
  broke Final Settled → final vendor bill creation (ReferenceError swallowed by the UE's
  never-re-throw rule). Fixed; the two tests that had pinned this as a known bug are
  un-skipped and green.

**Demo-moment walkthrough status:**

| Moment | Status |
|---|---|
| 7:00 PO receiving | Blocked by the pre-existing PO approval workflow (see quirks above) |
| 7:30 Scale Ticket | Not yet walked live |
| 8:00 regrade (Lot Quality Entry) | Not yet walked live |
| 8:30 yard status | Not yet walked live |
| 9:15 processing | Blocked by the Processing Entry browser-save hang (see quirks above) |
| 1:30 index pricing / settlement | Verified live — schedule and market-price precision confirmed correct after the FLOAT fix |
| 2:30 order-to-cash | Not yet walked live |
| 5:00 close | Not yet walked live |

Next: retry the two blocked moments (fresh tab, or a different role/browser session), or
narrate them from seeded data if the live-interaction hang persists in this specific account.
