import { describe, it, expect } from "vitest";
import { calculatePaye, calculatePayeFromMonthly, calculateNetPay } from "../paye.js";
import { PAYE_THRESHOLD } from "../constants.js";

describe("PAYE Engine", () => {
  describe("constants", () => {
    it("has correct PAYE threshold", () => {
      expect(PAYE_THRESHOLD).toBe(780_000);
    });
  });

  describe("calculatePaye", () => {
    it("returns zero tax below threshold", () => {
      const result = calculatePaye(700_000);
      expect(result.annualTax).toBe(0);
      expect(result.monthlyTax).toBe(0);
      expect(result.taxableIncome).toBe(0);
      expect(result.effectiveRate).toBe(0);
      expect(result.marginalRate).toBe(0);
    });

    it("returns zero tax at exactly the threshold", () => {
      const result = calculatePaye(780_000);
      expect(result.annualTax).toBe(0);
      expect(result.monthlyTax).toBe(0);
    });

    it("calculates first band tax (28%)", () => {
      const result = calculatePaye(1_000_000);
      // Taxable: 1,000,000 − 780,000 = 220,000
      expect(result.taxableIncome).toBe(220_000);
      expect(result.annualTax).toBe(61_600); // 220k × 0.28, properly rounded
      expect(result.monthlyTax).toBeCloseTo(61_600 / 12, 0);
      expect(result.marginalRate).toBe(0.28);
    });

    it("calculates second band tax (40%)", () => {
      // Annual gross = 3,000,000
      // Taxable = 3,000,000 − 780,000 = 2,220,000
      // Band 1: min(1,560,000, 2,220,000) = 1,560,000 × 0.28 = 436,800
      // Band 2: 2,220,000 − 1,560,000 = 660,000 × 0.40 = 264,000
      // Total = 700,800
      const result = calculatePaye(3_000_000);
      expect(result.taxableIncome).toBe(2_220_000);
      expect(result.annualTax).toBe(700_800);
      expect(result.marginalRate).toBe(0.40);
    });

    it("has correct band breakdown", () => {
      const result = calculatePaye(3_000_000);
      expect(result.bands).toHaveLength(2);
      expect(result.bands[0]!.rate).toBe(0.28);
      expect(result.bands[0]!.taxableAmount).toBe(1_560_000);
      expect(result.bands[0]!.tax).toBe(436_800);
      expect(result.bands[1]!.rate).toBe(0.40);
      expect(result.bands[1]!.taxableAmount).toBe(660_000);
      expect(result.bands[1]!.tax).toBe(264_000);
    });

    it("calculates effective tax rate", () => {
      const result = calculatePaye(1_560_000);
      // Taxable: 1,560,000 - 780,000 = 780,000
      // Tax: 780,000 × 0.28 = 218,400
      // Effective: 218,400 / 1,560,000 = 0.14
      expect(result.effectiveRate).toBe(0.14);
    });

    it("handles zero income", () => {
      const result = calculatePaye(0);
      expect(result.annualTax).toBe(0);
      expect(result.taxableIncome).toBe(0);
      expect(result.effectiveRate).toBe(0);
    });

    it("includes threshold in result", () => {
      const result = calculatePaye(1_000_000);
      expect(result.threshold).toBe(780_000);
    });

    it("supports custom threshold override", () => {
      const result = calculatePaye(1_000_000, 500_000);
      expect(result.taxableIncome).toBe(500_000);
      expect(result.threshold).toBe(500_000);
    });

    it("handles income just above threshold", () => {
      const result = calculatePaye(780_001);
      expect(result.taxableIncome).toBe(1);
      expect(result.annualTax).toBeCloseTo(0.28, 1);
    });

    it("handles very high income (executive salary)", () => {
      const result = calculatePaye(20_000_000);
      expect(result.marginalRate).toBe(0.40);
      expect(result.annualTax).toBeGreaterThan(0);
      expect(result.effectiveRate).toBeGreaterThan(0);
      expect(result.effectiveRate).toBeLessThan(0.40); // Effective always < marginal
    });
  });

  describe("calculatePayeFromMonthly", () => {
    it("annualizes monthly gross and calculates PAYE", () => {
      const result = calculatePayeFromMonthly(250_000);
      // Annual: 250,000 × 12 = 3,000,000
      expect(result.annualGross).toBe(3_000_000);
      expect(result.annualTax).toBe(700_800);
    });

    it("below-threshold monthly salary has zero tax", () => {
      const result = calculatePayeFromMonthly(50_000);
      // Annual: 600,000 < 780,000 threshold
      expect(result.annualTax).toBe(0);
      expect(result.monthlyTax).toBe(0);
    });
  });

  describe("calculateNetPay", () => {
    it("calculates complete net take-home pay", () => {
      // Gross: 250,000/month
      // NIS employee: 14,000 (250k × 0.056)
      // PAYE monthly: from 3M annual
      const nisEmployee = 14_000;
      const result = calculateNetPay(250_000, nisEmployee);

      expect(result.grossMonthly).toBe(250_000);
      expect(result.nisEmployee).toBe(14_000);
      expect(result.payeMonthly).toBeGreaterThan(0);
      expect(result.totalDeductions).toBe(result.nisEmployee + result.payeMonthly);
      expect(result.netTakeHome).toBe(result.grossMonthly - result.totalDeductions);
    });

    it("low-income worker has only NIS deduction", () => {
      // Gross: 50,000/month → 600,000 annual (below PAYE threshold)
      const nisEmployee = 2_800; // 50k × 0.056
      const result = calculateNetPay(50_000, nisEmployee);

      expect(result.payeMonthly).toBe(0);
      expect(result.totalDeductions).toBe(2_800);
      expect(result.netTakeHome).toBe(47_200);
    });

    it("net pay is always less than gross", () => {
      const result = calculateNetPay(300_000, 15_680);
      expect(result.netTakeHome).toBeLessThan(result.grossMonthly);
    });
  });
});
