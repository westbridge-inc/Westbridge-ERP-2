/**
 * Caribbean domain constants — currency, region, and compliance defaults.
 *
 * These values support general Caribbean / Guyana business operations
 * (currency formatting, CARICOM membership, record retention).
 *
 * Source: CARICOM Revised Treaty of Chaguaramas; local data retention
 * regulations.
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

/** General financial records retention (years) */
export const FINANCIAL_RETENTION_YEARS = 7;
