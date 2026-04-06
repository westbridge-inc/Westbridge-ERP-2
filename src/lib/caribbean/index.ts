/**
 * Caribbean business logic — currency, region, and compliance helpers.
 *
 * Barrel export for Caribbean-specific constants and value objects:
 *
 *   import { Money, DEFAULT_CURRENCY, CARICOM_ORIGIN_COUNTRIES } from "../caribbean/index.js";
 */

// Constants
export {
  DEFAULT_CURRENCY,
  SUPPORTED_CURRENCIES,
  CARICOM_ORIGIN_COUNTRIES,
  FINANCIAL_RETENTION_YEARS,
  type CaribbeanCurrency,
  type CaricomCountry,
} from "./constants.js";

// Money value object
export { Money, CURRENCY_INFO } from "./money.js";
