/**
 * Unit tests for SUST_Lib_Units.js
 *
 * The single source of truth for weight-unit handling:
 * storage/math stay in POUNDS, display converts to short tons (2,000 lbs).
 */

// Load the AMD module (no deps) via a define shim
let units;
const originalDefine = global.define;
global.define = function(deps, factory) {
    units = factory();
};
require('../src/FileCabinet/SuiteScripts/Sustana/SUST_Lib_Units');
global.define = originalDefine;

describe('SUST_Lib_Units', () => {

    describe('constants', () => {
        test('LBS_PER_TON is 2000 (short ton)', () => {
            expect(units.LBS_PER_TON).toBe(2000);
        });
    });

    describe('weight conversions', () => {
        test('toTons(40000) = 20', () => {
            expect(units.toTons(40000)).toBe(20);
        });

        test('toLbs(20) = 40000', () => {
            expect(units.toLbs(20)).toBe(40000);
        });

        test('toTons accepts numeric strings', () => {
            expect(units.toTons('40000')).toBe(20);
        });

        test('toTons/toLbs of garbage input is 0', () => {
            expect(units.toTons(null)).toBe(0);
            expect(units.toTons(undefined)).toBe(0);
            expect(units.toTons('not-a-number')).toBe(0);
            expect(units.toLbs(null)).toBe(0);
        });
    });

    describe('price conversions', () => {
        test('perTonToPerLb(200) = 0.10', () => {
            expect(units.perTonToPerLb(200)).toBe(0.10);
        });

        test('perLbToPerTon(0.305) = 610', () => {
            expect(units.perLbToPerTon(0.305)).toBeCloseTo(610, 9);
        });

        test('perTonToPerLb of garbage input is 0', () => {
            expect(units.perTonToPerLb(null)).toBe(0);
            expect(units.perLbToPerTon('abc')).toBe(0);
        });
    });

    describe('display formatting', () => {
        test("formatTons(40000) = '20.00 tons'", () => {
            expect(units.formatTons(40000)).toBe('20.00 tons');
        });

        test('formatTons honors the decimals argument', () => {
            expect(units.formatTons(41000, 1)).toBe('20.5 tons');
            expect(units.formatTons(40000, 0)).toBe('20 tons');
        });

        test("formatPerTon(0.305) = '$610.00/ton'", () => {
            expect(units.formatPerTon(0.305)).toBe('$610.00/ton');
        });

        test("formatPerTon(0.10) = '$200.00/ton' (index price round-trip)", () => {
            expect(units.formatPerTon(0.10)).toBe('$200.00/ton');
        });

        test("fmtCurrency(1234.5) = '$1,234.50'", () => {
            expect(units.fmtCurrency(1234.5)).toBe('$1,234.50');
        });

        test('fmtCurrency handles small and large amounts', () => {
            expect(units.fmtCurrency(0.5)).toBe('$0.50');
            expect(units.fmtCurrency(1000)).toBe('$1,000.00');
            expect(units.fmtCurrency(1234567.891)).toBe('$1,234,567.89');
        });
    });

    describe('round-trips', () => {
        test('toLbs(toTons(x)) returns x', () => {
            expect(units.toLbs(units.toTons(40000))).toBe(40000);
            expect(units.toLbs(units.toTons(12345))).toBeCloseTo(12345, 9);
        });

        test('toTons(toLbs(x)) returns x', () => {
            expect(units.toTons(units.toLbs(20))).toBe(20);
            expect(units.toTons(units.toLbs(3.17))).toBeCloseTo(3.17, 9);
        });

        test('perLbToPerTon(perTonToPerLb(x)) returns x', () => {
            expect(units.perLbToPerTon(units.perTonToPerLb(200))).toBeCloseTo(200, 9);
            expect(units.perLbToPerTon(units.perTonToPerLb(612.34))).toBeCloseTo(612.34, 9);
        });

        test('perTonToPerLb(perLbToPerTon(x)) returns x', () => {
            expect(units.perTonToPerLb(units.perLbToPerTon(0.305))).toBeCloseTo(0.305, 9);
        });
    });
});
