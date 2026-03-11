/**
 * NIS (National Insurance Scheme) calculation engine — Guyana.
 *
 * Both employer and employee contribute to NIS based on insurable earnings,
 * capped at a monthly ceiling.  Contributions are mandatory for all employed
 * persons aged 16-60.
 *
 * Source: National Insurance Scheme Act, Chapter 36:01
 */

import {
  NIS_EMPLOYER_RATE,
  NIS_EMPLOYEE_RATE,
  NIS_CEILING,
} from "./constants.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NisCalculation {
  /** Earnings used for NIS calculation (capped at ceiling) */
  insurableEarnings: number;
  /** Employee's contribution (5.6% of insurable earnings) */
  employeeContribution: number;
  /** Employer's contribution (8.8% of insurable earnings) */
  employerContribution: number;
  /** Combined contribution (employer + employee) */
  totalContribution: number;
  /** Whether earnings hit the ceiling */
  ceilingApplied: boolean;
  /** Monthly NIS ceiling in GYD */
  ceiling: number;
}

export interface NisAnnualSummary {
  /** Total employee contributions for the year */
  totalEmployeeContributions: number;
  /** Total employer contributions for the year */
  totalEmployerContributions: number;
  /** Combined total for the year */
  totalContributions: number;
  /** Number of months in the period */
  months: number;
}

// ─── Core Calculations ───────────────────────────────────────────────────────

/**
 * Calculate monthly NIS contributions for an employee.
 *
 * @param grossMonthly - Gross monthly salary in GYD
 * @param ceiling      - NIS ceiling override (default GYD 280,000)
 */
export function calculateNis(
  grossMonthly: number,
  ceiling: number = NIS_CEILING,
): NisCalculation {
  const insurableEarnings = Math.min(grossMonthly, ceiling);
  const ceilingApplied = grossMonthly > ceiling;

  const employeeContribution = round2(insurableEarnings * NIS_EMPLOYEE_RATE);
  const employerContribution = round2(insurableEarnings * NIS_EMPLOYER_RATE);
  const totalContribution = round2(employeeContribution + employerContribution);

  return {
    insurableEarnings,
    employeeContribution,
    employerContribution,
    totalContribution,
    ceilingApplied,
    ceiling,
  };
}

/**
 * Calculate annual NIS summary from monthly gross salaries.
 * Handles variable months (e.g. mid-year hires, salary changes).
 */
export function calculateNisAnnual(monthlyGrossSalaries: number[]): NisAnnualSummary {
  let totalEmployee = 0;
  let totalEmployer = 0;

  for (const gross of monthlyGrossSalaries) {
    const nis = calculateNis(gross);
    totalEmployee += nis.employeeContribution;
    totalEmployer += nis.employerContribution;
  }

  return {
    totalEmployeeContributions: round2(totalEmployee),
    totalEmployerContributions: round2(totalEmployer),
    totalContributions: round2(totalEmployee + totalEmployer),
    months: monthlyGrossSalaries.length,
  };
}

/**
 * Calculate NIS for multiple employees in a payroll batch.
 * Returns per-employee results and batch totals.
 */
export function calculateNisBatch(
  employees: { id: string; name: string; grossMonthly: number }[],
): {
  results: (NisCalculation & { id: string; name: string })[];
  batchTotalEmployee: number;
  batchTotalEmployer: number;
  batchTotal: number;
} {
  let batchTotalEmployee = 0;
  let batchTotalEmployer = 0;

  const results = employees.map((emp) => {
    const nis = calculateNis(emp.grossMonthly);
    batchTotalEmployee += nis.employeeContribution;
    batchTotalEmployer += nis.employerContribution;
    return { ...nis, id: emp.id, name: emp.name };
  });

  return {
    results,
    batchTotalEmployee: round2(batchTotalEmployee),
    batchTotalEmployer: round2(batchTotalEmployer),
    batchTotal: round2(batchTotalEmployee + batchTotalEmployer),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
