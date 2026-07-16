# Sustana Recovery — SDF Demo Accelerator

NetSuite SDF Account Customization Project for the Sustana finalist demo (paper/fiber recycling).
Forked 2026-07-16 from the Nathan Trotter / Tin Tech metals accelerator, fully sanitized:
all chemistry/melt/oxide/LME concepts removed, every custom object scriptid renamed with a
`sust_` token (old→new map: [docs/rename_map.csv](docs/rename_map.csv)).

## Layout

- `src/FileCabinet/SuiteScripts/Sustana/` — all SuiteScript (flat, `SUST_<Type>_<Name>.js`)
- `src/Objects/` — all SDF object XML (flat)
- `tests/` — Jest with `N/*` mocks in `tests/mocks/N/`; run `npm test`
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
   internal id. Coverage is partial, not one dedicated file: `settlementStatus.test.js`
   covers settlement-status and quality-metric texts (Moisture %/Contamination %),
   `marketPrice.test.js` covers market-source texts. Lot-status, schedule-direction, and
   scale-ticket-status texts have no dedicated test yet. If you change a list value's text,
   update the matching code constant and its test (add one if none exists).
4. **UE afterSubmit never re-throws.** Inventory Adjustments use `isDynamic: false`, header
   order `trandate → subsidiary → adjlocation → account → memo`.
5. Weight columns keep their historical ids (`custcol_sust_scrap_gross_weight` etc.) —
   labels say "Gross/Net Weight (lbs)"; do not rename field scriptids (data + code churn).

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
- No test coverage yet for `SUST_SL_ScaleTicket`/`SUST_CS_ScaleTicket` or `SUST_UE_SO_IndexPricing` — everything else has a Jest suite (4 suites, 92 tests green).

## Deploy status

Deployed to the `SUSTANA` demo account (authid `SUSTANA`, project.json) on 2026-07-16 — 343
objects, 0 errors. Two things still need to happen before the demo is walkable end to end:
1. Manually create subsidiaries **Sustana Recovery US** / **Sustana Recovery Canada** in the
   account (SDF/SuiteScript can't create subsidiaries — this is the seeder's precheck).
2. Run `SUST_SL_SeedSustanaDemo` to provision the config record, locations, items, entities,
   RISI index prices, schedules, PO-10001, and the yard lots.
