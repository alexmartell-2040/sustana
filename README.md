# Sustana Recovery — NetSuite SDF Demo Accelerator

SDF Account Customization Project for the **Sustana Recovery** finalist demo ("A Day in the Life at Recovery").
Forked and refactored from the MHI Intake-to-Pay recycling accelerator; sanitized for paper/fiber recovery.

## What it does

The intake → process → price → settle spine for recovered-fiber operations:

- **Scale-ticket receiving** (`SUST_SL_ScaleTicket`) — kiosk Suitelet acts as the scale system: ticket in, AP-ready Item Receipt out, zero re-keying. Manual Item Receipt entry (Phase-1) works unchanged as the outage fallback.
- **Item Receipt automation** — landed-cost rollup, auto line-scoped supplier settlement, vendor-lot bridge, lot creation with quality fields (moisture / contamination / fiber content / bale count).
- **Index pricing with true-up** — settlement schedules reference RISI-style published indices (`customrecord_sust_market_price`, effective-dated with lag lookup); `effectivePrice = index x % + adjustment`; provisional → final settlement recalculation.
- **Sell-side index pricing** (`SUST_UE_SO_IndexPricing`) — Sale-direction schedules (e.g. RISI SOP + $10/ton) auto-price Sales Order lines.
- **Processing without BOM/WO** (`SUST_SL_ProcessingEntry`) — Inventory-Adjustment-based grade transformation: N input lots → M output lots, yield/loss banner (residual + moisture), weight-based cost allocation, lot genealogy.
- **Dashboards** — Settlement Close-Out, Fiber Position (tonnage by grade), LCNRV.
- **Shipping Matrix** — consolidated shipment, actual outbound weights, BOL PDF.
- **Demo seeder** (`SUST_SL_SeedSustanaDemo`) — idempotent provisioning of the Sustana demo dataset (grades, Fox Valley Recycling, Packaging Mill A, PO-10001, RISI monthly indices, schedules, on-hand lots).

## Units

All storage and math are in **lbs**; Suitelets, dashboards, and PDFs display **tons** (1 ton = 2,000 lbs) via `SUST_Lib_Units`. Index prices are entered in $/ton and converted once at write time.

## Configuration

No hardcoded internal IDs. Account-specific values (subsidiaries, GL accounts, fee item, default location) live on the single **Demo Config** record (`customrecord_sust_config`), read through `SUST_Lib_Config`. Script parameters, where present, override the config record.

## Deploy

```bash
npm install                    # jest only
npx suitecloud account:setup   # authenticate to the demo account (authid SUSTANA_DEMO)
npx suitecloud project:validate
npx suitecloud project:deploy
```

Post-deploy, in order:
1. Create the **US and Canada subsidiaries** manually (OneWorld) — the seeder verifies them by name and fails fast with instructions if missing.
2. Run **SUST_SL_SeedSustanaDemo** — creates/updates everything else idempotently (all seeded records carry `SUSTDEMO_*` external IDs).

## Tests

```bash
npm test
```

Jest with `N/*` mocks under `tests/mocks/N/`.

## Provenance

Forked 2026-07-16 from the Nathan Trotter / Tin Tech accelerator (internal). Full scriptid rename (`sust_` token), metals-specific chemistry/melt/oxide layers removed. See `SUSTANA_DEMO_ALIGNMENT.md` in the source repo for the demo-moment mapping.
