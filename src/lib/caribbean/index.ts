/**
 * Caribbean business logic — the core IP of Westbridge.
 *
 * Barrel export for all Caribbean-specific calculations and constants.
 * Import from this module for a clean API:
 *
 *   import { calculateVat, calculateNis, calculatePaye, Money } from "../caribbean/index.js";
 */

// Constants
export {
  DEFAULT_CURRENCY,
  SUPPORTED_CURRENCIES,
  VAT_RATE,
  WITHHOLDING_TAX_RATE,
  GRA_TIN_REGEX,
  NIS_EMPLOYER_RATE,
  NIS_EMPLOYEE_RATE,
  NIS_CEILING,
  PAYE_THRESHOLD,
  PAYE_BANDS,
  CARICOM_ORIGIN_COUNTRIES,
  GRA_RETENTION_YEARS,
  NIS_RETENTION_YEARS,
  type CaribbeanCurrency,
  type CaricomCountry,
} from "./constants.js";

// Money value object
export { Money, CURRENCY_INFO } from "./money.js";

// VAT engine
export {
  calculateVat,
  extractVat,
  calculateInvoiceVat,
  validateGraTin,
  type VatCalculation,
  type VatLineItem,
  type VatLineResult,
  type VatInvoiceResult,
} from "./vat.js";

// NIS engine
export {
  calculateNis,
  calculateNisAnnual,
  calculateNisBatch,
  type NisCalculation,
  type NisAnnualSummary,
} from "./nis.js";

// PAYE engine
export {
  calculatePaye,
  calculatePayeFromMonthly,
  calculateNetPay,
  type PayeCalculation,
  type PayeBandResult,
  type NetPayCalculation,
} from "./paye.js";
