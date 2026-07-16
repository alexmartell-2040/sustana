# Sustana Demo — Post-Deploy Smoke Test

Run after `suitecloud project:deploy` against the fresh demo account. Steps follow the
demo-moment order so a full pass doubles as a dry run of the finalist demo.

## 0. Prerequisites (manual, once)

1. Create subsidiaries named exactly **Sustana Recovery US** and **Sustana Recovery Canada**
   (Setup > Company > Subsidiaries).
2. Run **SUST - Seed Sustana Demo** (Suitelet link from the script deployment). All groups
   checked except the optional planning scenario. Re-running is safe (idempotent,
   `SUSTDEMO_*` external ids).
3. Confirm the seeder created: the Sustana Config record, 4 locations (Markham / Cincinnati /
   Buffalo / St Joseph), items White Ledger / Mixed Paper / Mixed Office Paper / SOP /
   Mill Residuals, vendor Fox Valley Recycling, customer Packaging Mill A, RISI SOP + RISI
   White Ledger monthly prices, 2 schedules, PO-10001 (open), and 3 seeded on-hand lots.

## 1. 7:00 — Phase-1 receiving (manual scale)

1. Open PO-10001 → Receive. Key gross 78,500 / tare 38,500 → net 40,000 lbs on the weight
   columns; quantity 40,000; assign lot number `TRK-001`; location Cincinnati.
2. Verify on save: guidance banner (Index Base decomposition), auto-created **line settlement**
   (Draft) linked to PO + IR + line, priced ≈ RISI White Ledger − $15/ton; lot exists with
   status **Received** (vendor-lot bridge); system notes on the IR.
3. Edit the IR weight (e.g. net 39,500) → confirm the settlement recalculates (weight true-up).

## 2. 7:30 — Scale kiosk (the Suitelet IS the scale)

1. Open **SUST - Scale Kiosk**. Ticket defaults to next TRK-nnn. Pick Fox Valley → open-PO
   dropdown fills. Enter gross/tare — net computes live. Submit.
2. Verify the confirmation links: ticket → Item Receipt (auto-created, weights populated,
   lot = ticket number) → auto settlement → lot. Zero re-keying.
3. Submit the same ticket number again → **Duplicate ticket** warning, nothing created.
4. Open the ticket link → correct the gross weight → Update → IR weights re-synced.
5. Outage fallback: create a ticket with no PO → status Weighed Out; receive manually later.

## 3. 8:00 — Inspection & regrade

1. From the IR, button **Enter Lot Quality** → set Moisture 8% / Contamination 2% /
   Fiber 92% / Bale Count 20 → save. Lot status flips Received → **Yard**.
2. Re-open and change Moisture to 12% → lot notes show the `[Quality Regrade …] old -> new`
   audit line (original preserved).
3. Item-level regrade (White Ledger → Mixed Office Paper): native inventory reclassification —
   narrate or demo with a manual adjustment.

## 4. 8:30 — Yard movement

Walk a lot's status: Received → Yard → Processing Queue → Staged → Shipped (edit the lot's
Lot Status field). Bale Count visible on the lot. Genealogy: after step 5, trace
output lot → input lots → receipt.

## 5. 9:15 — Processing without BOM/WO ⭐

1. Open **SUST - Processing Entry**. Inputs (tons): WL-SEED-001 30, MP-SEED-001 15,
   SOP-SEED-001 10 (55 tons in). Outputs: SOP 50 tons + Mill Residuals 3 tons.
2. Verify the **Yield / Loss** banner: 53 out / 55 in, loss 2.00 tons (residual + moisture),
   yield ≈ 96.4% — amber/green per thresholds.
3. Save → Inventory Adjustment posts (no work order, no BOM), input lots consumed, output
   lots created (status Yard), **Weight-mode cost allocation** across outputs, genealogy rows
   (Grade Transformation) link outputs to all three inputs.

## 6. 1:30 — Index pricing & true-up ⭐

1. Open the supplier schedule (RISI White Ledger − $0.0075/lb) and the market price list —
   monthly RISI values, stored $/lb with $/ton raw rate.
2. Open the settlement from step 1 → Calculate: `effective = index × % + adjustment`;
   provisional value shown. Set quality deduction demo: schedule penalty Moisture % over
   10% at $0.50/pt → settlement shows the deduction row (lot moisture 12%).
3. Mark Provisional Paid → provisional vendor bill auto-creates. Enter a later RISI value,
   recalc, Final Settled → final bill for the balance (true-up + margin delta).

## 7. 2:30 — Order-to-cash on actual weight

1. New Sales Order for Packaging Mill A, item SOP, qty 100,000 lbs → line auto-prices at
   **RISI SOP + $10/ton** with the formula in the line description (blue banner on view).
2. Fulfill → **SUST - Shipping Matrix**: build shipment, actual outbound weights, BOL PDF
   (Sustana Recovery header, lbs + tons totals) → Mark Shipped.
3. Invoice from the fulfillment quantities (actual weight) → drill invoice → SO → fulfillment
   → lot → receipt.

## 8. 5:00 — Close

Open **SUST - Settlement Close Dashboard**: open settlements / awaiting-cost / index-price-
not-fixed tiles, drill to records. Provisional bills = the settlement accrual. FX/IC:
native consolidated P&L with the two subsidiaries.

## Automated checks

- `npm test` — all suites green (units, market price, settlement status/quality deductions,
  SO index pricing, scale ticket, shipping matrix, list-text couplings).
- `suitecloud project:validate` — clean against the demo account.
