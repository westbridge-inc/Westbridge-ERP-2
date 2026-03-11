/**
 * Caribbean domain constants — the financial backbone of Westbridge.
 *
 * These values are the single source of truth for all tax, payroll, and
 * compliance calculations.  The frontend repo MUST mirror every constant
 * exactly — if they drift, the system is broken.
 *
 * Source: Guyana Revenue Authority (GRA), National Insurance Scheme (NIS),
 * CARICOM Revised Treaty of Chaguaramas.
 */

// ─── Currency ────────────────────────────────────────────────────────────────

export const DEFAULT_CURRENCY = "GYD" as const;

export const SUPPORTED_CURRENCIES = [
  "GYD", // Guyanese Dollar  (default)
  "USD", // US Dollar
  "TTD", // Trinidad & Tobago Dollar
  "BBD", // Barbados Dollar
  "JMD", // Jamaican Dollar
  "XCD", // East Caribbean Dollar
] as const;

export type CaribbeanCurrency = (typeof SUPPORTED_CURRENCIES)[number];

// ─── VAT / Tax ───────────────────────────────────────────────────────────────

/** Guyana standard VAT rate (14%) */
export const VAT_RATE = 0.14;

/** Withholding tax on payments to non-residents */
export const WITHHOLDING_TAX_RATE = 0.20;

/** GRA TIN format: exactly 10 digits */
export const GRA_TIN_REGEX = /^\d{10}$/;

// ─── NIS (National Insurance Scheme — Guyana) ────────────────────────────────

/** Employer's NIS contribution rate (8.8%) */
export const NIS_EMPLOYER_RATE = 0.088;

/** Employee's NIS contribution rate (5.6%) */
export const NIS_EMPLOYEE_RATE = 0.056;

/** Monthly NIS insurable earnings ceiling (GYD) */
export const NIS_CEILING = 280_000;

// ─── PAYE (Pay-As-You-Earn — Guyana) ─────────────────────────────────────────

/** Annual PAYE threshold — income below this is tax-free (GYD) */
export const PAYE_THRESHOLD = 780_000;

/**
 * PAYE progressive tax bands (Guyana).
 * Applied to taxable income (annual gross − threshold).
 *
 * Band 1: First GYD 1,560,000 of taxable income → 28%
 * Band 2: Everything above → 40%
 */
export const PAYE_BANDS = [
  { upperLimit: 1_560_000, rate: 0.28 },
  { upperLimit: Infinity,  rate: 0.40 },
] as const;

// ─── CARICOM ─────────────────────────────────────────────────────────────────

/** ISO 3166-1 alpha-2 codes for CARICOM member states */
export const CARICOM_ORIGIN_COUNTRIES = [
  "GY", // Guyana
  "TT", // Trinidad & Tobago
  "BB", // Barbados
  "JM", // Jamaica
  "BS", // Bahamas
  "BZ", // Belize
  "SR", // Suriname
  "AG", // Antigua & Barbuda
  "DM", // Dominica
  "GD", // Grenada
  "KN", // St Kitts & Nevis
  "LC", // St Lucia
  "VC", // St Vincent & the Grenadines
  "HT", // Haiti
] as const;

export type CaricomCountry = (typeof CARICOM_ORIGIN_COUNTRIES)[number];

// ─── Data Retention / Compliance ─────────────────────────────────────────────

/** GRA requires 7-year retention of financial records */
export const GRA_RETENTION_YEARS = 7;

/** NIS records retention */
export const NIS_RETENTION_YEARS = 7;
