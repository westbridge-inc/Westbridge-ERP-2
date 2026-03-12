/**
 * Application constants. No magic numbers or strings in components or services.
 */

export const HTTP = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429,
  SERVER_ERROR: 500,
} as const;

export const RATE_LIMIT = {
  LOGIN_PER_MINUTE: 10,
  SIGNUP_PER_MINUTE: 5,
  WEBHOOK_2CO_PER_MINUTE: 100,
} as const;

/** Per-plan rate limit tiers. Values are max requests per windowMs. */
export const RATE_LIMIT_TIERS = {
  anonymous:    { requests: 20,   windowMs: 60_000 },
  starter:      { requests: 60,   windowMs: 60_000 },
  business:     { requests: 200,  windowMs: 60_000 },
  enterprise:   { requests: 1000, windowMs: 60_000 },
  api_key:      { requests: 500,  windowMs: 60_000 },
} as const;

export type RateLimitTier = keyof typeof RATE_LIMIT_TIERS;

/**
 * Cost multipliers for expensive operations.
 * A request that costs 5x counts as 5 tokens against the rate limit.
 */
export const RATE_LIMIT_COST = {
  erp_list:   5,  // listing all docs is DB + ERP overhead
  erp_doc:    2,  // single doc fetch is cheaper
  erp_create: 3,  // write to ERP is expensive
  ai_chat:    10, // LLM calls are expensive and slow
  default:    1,
} as const;

export type RateLimitOperation = keyof typeof RATE_LIMIT_COST;

export const COOKIE = {
  SESSION_MAX_AGE_SEC: 60 * 60 * 24 * 7, // 7 days
  CSRF_NAME: "westbridge_csrf",
  SESSION_NAME: "westbridge_sid",
  ACCOUNT_ID_NAME: "westbridge_account_id",
} as const;

export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_PER_PAGE: 20,
  MAX_PER_PAGE: 100,
} as const;

/** Caribbean / Guyana defaults */
export const LOCALE = {
  DEFAULT_CURRENCY: "GYD" as const,
  DEFAULT_TIMEZONE: "America/Guyana",
  DATE_FORMAT: "DD/MM/YYYY",
  VAT_RATE_GUYANA: 0.14, // 14%
} as const;

/**
 * Supported currencies — Caribbean-first, international-second.
 * For full Caribbean constants (NIS, PAYE, CARICOM) see ./caribbean/constants.ts
 */
export const CURRENCY_CODES = ["GYD", "USD", "TTD", "BBD", "JMD", "XCD", "EUR", "GBP", "CAD"] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

/**
 * sameSite policy — "none" is required for cross-origin frontend↔backend.
 * Set COOKIE_SAME_SITE=lax if deploying frontend and API on the same domain.
 */
export const COOKIE_SAME_SITE: "none" | "lax" | "strict" =
  (process.env.COOKIE_SAME_SITE as "none" | "lax" | "strict") ?? "none";

/**
 * Secure flag for cookies — disabled in development so cookies work over plain HTTP.
 */
export const COOKIE_SECURE: boolean = process.env.NODE_ENV !== "development";

export const SECURITY = {
  SESSION_EXPIRY_DAYS: 7,
  IDLE_TIMEOUT_MINUTES: 30,
  MAX_CONCURRENT_SESSIONS: 5,
  SESSION_CACHE_TTL_SEC: 30,
  MAX_BODY_BYTES: 1_048_576,
  WEBHOOK_CIRCUIT_BREAKER_THRESHOLD: 10,
  LOCKOUT_AFTER_FAILED_ATTEMPTS: 5,
  LOCKOUT_DURATION_MINUTES: 15,
} as const;
