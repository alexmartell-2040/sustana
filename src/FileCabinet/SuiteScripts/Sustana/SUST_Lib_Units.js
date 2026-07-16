/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 */

/**
 * SUST_Lib_Units.js
 *
 * Single source of truth for weight-unit handling.
 *
 * RULE: all storage and math stay in POUNDS (field semantics are unchanged from
 * the accelerator). Only UI edges — Suitelet fields/columns, dashboards, PDFs —
 * convert to tons for display, and index prices entered in $/ton are converted
 * to $/lb once at write time (see SUST_Lib_MarketPrice.storeIndexPrice).
 *
 * 1 short ton = 2,000 lbs.
 *
 * Author: MHI
 * Date: July 2026
 */

define([], function() {

    const LBS_PER_TON = 2000;

    /** lbs -> tons */
    function toTons(lbs) {
        return (parseFloat(lbs) || 0) / LBS_PER_TON;
    }

    /** tons -> lbs */
    function toLbs(tons) {
        return (parseFloat(tons) || 0) * LBS_PER_TON;
    }

    /** $/ton -> $/lb */
    function perTonToPerLb(pricePerTon) {
        return (parseFloat(pricePerTon) || 0) / LBS_PER_TON;
    }

    /** $/lb -> $/ton */
    function perLbToPerTon(pricePerLb) {
        return (parseFloat(pricePerLb) || 0) * LBS_PER_TON;
    }

    /**
     * Format a lbs quantity as a tons display string.
     * formatTons(40000) -> "20.00 tons"
     */
    function formatTons(lbs, decimals) {
        const d = (decimals === undefined || decimals === null) ? 2 : decimals;
        return toTons(lbs).toFixed(d) + ' tons';
    }

    /**
     * Format a $/lb price as a $/ton display string.
     * formatPerTon(0.305) -> "$610.00/ton"
     */
    function formatPerTon(pricePerLb, decimals) {
        const d = (decimals === undefined || decimals === null) ? 2 : decimals;
        return '$' + perLbToPerTon(pricePerLb).toFixed(d) + '/ton';
    }

    /** Format a dollar amount: fmtCurrency(1234.5) -> "$1,234.50" */
    function fmtCurrency(amount) {
        const n = parseFloat(amount) || 0;
        return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    return {
        LBS_PER_TON: LBS_PER_TON,
        toTons: toTons,
        toLbs: toLbs,
        perTonToPerLb: perTonToPerLb,
        perLbToPerTon: perLbToPerTon,
        formatTons: formatTons,
        formatPerTon: formatPerTon,
        fmtCurrency: fmtCurrency
    };

});
