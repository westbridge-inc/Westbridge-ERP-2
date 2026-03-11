/**
 * PAYE (Pay-As-You-Earn) income tax engine — Guyana.
 *
 * Guyana uses a progressive tax system with an annual threshold.
 * Income below the threshold is tax-free.  Income above is taxed
 * in bands at 28% and 40%.
 *
 * Source: Income Tax Act, Chapter 81:01 (as amended)
 */

import { PAYE_THRESHOLD, PAYE_BANDS } from "./constants.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PayeCalculation {
  /** Input: annual gross income */
  annualGross: number;
  /** Annual PAYE threshold */
  threshold: number;
  /** Taxable income (gross − threshold, min 0) */
  taxableIncome: number;
  /** Annual PAYE tax */
  annualTax: number;
  /** Monthly PAYE deduction */
  monthlyTax: number;
  /** Effective tax rate on total gross */
  effectiveRate: number;
  /** Marginal rate (highest band applied) */
  marginalRate: number;
  /** Breakdown of tax by band */
  bands: PayeBandResult[];
}

export interface PayeBandResult {
  /** Band rate (e.g. 0.28) */
  rate: number;
  /** Income taxed at this rate */
  taxableAmount: number;
  /** Tax due for this band */
  tax: number;
}

export interface NetPayCalculation {
  grossMonthly: number;
  nisEmployee: number;
  payeMonthly: number;
  totalDeductions: number;
  netTakeHome: number;
}

// ─── Core Calculations ───────────────────────────────────────────────────────

/**
 * Calculate PAYE income tax for an annual gross income.
 *
 * @param annualGross - Total annual gross income in GYD
 * @param threshold   - PAYE threshold override (default GYD 780,000)
 */
export function calculatePaye(
  annualGross: number,
  threshold: number = PAYE_THRESHOLD,
): PayeCalculation {
  const taxableIncome = Math.max(0, annualGross - threshold);

  let remaining = taxableIncome;
  let totalTax = 0;
  let marginalRate = 0;
  let prevLimit = 0;
  const bands: PayeBandResult[] = [];

  for (const band of PAYE_BANDS) {
    if (remaining <= 0) break;

    const bandWidth = band.upperLimit === Infinity
      ? remaining
      : Math.min(band.upperLimit - prevLimit, remaining);

    const taxableAmount = Math.min(remaining, bandWidth);
    const tax = round2(taxableAmount * band.rate);

    bands.push({ rate: band.rate, taxableAmount, tax });

    totalTax += tax;
    remaining -= taxableAmount;
    marginalRate = band.rate;
    prevLimit = band.upperLimit === Infinity ? prevLimit : band.upperLimit;
  }

  const annualTax = round2(totalTax);
  const monthlyTax = round2(annualTax / 12);
  const effectiveRate = annualGross > 0 ? round4(annualTax / annualGross) : 0;

  return {
    annualGross,
    threshold,
    taxableIncome,
    annualTax,
    monthlyTax,
    effectiveRate,
    marginalRate: taxableIncome > 0 ? marginalRate : 0,
    bands,
  };
}

/**
 * Calculate PAYE from monthly gross (annualizes, then divides back).
 * Convenience wrapper for payroll processing.
 */
export function calculatePayeFromMonthly(grossMonthly: number): PayeCalculation {
  return calculatePaye(grossMonthly * 12);
}

/**
 * Calculate complete net pay after NIS and PAYE deductions.
 * This is the final take-home calculation for a salary slip.
 */
export function calculateNetPay(
  grossMonthly: number,
  nisEmployeeContribution: number,
): NetPayCalculation {
  const paye = calculatePayeFromMonthly(grossMonthly);
  const totalDeductions = round2(nisEmployeeContribution + paye.monthlyTax);
  const netTakeHome = round2(grossMonthly - totalDeductions);

  return {
    grossMonthly,
    nisEmployee: nisEmployeeContribution,
    payeMonthly: paye.monthlyTax,
    totalDeductions,
    netTakeHome,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
