import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { COOKIE } from "./constants.js";

const CSRF_HEADER = "x-csrf-token";
// Tokens expire after 1 hour. The timestamp is embedded in the token so
// we can reject stale tokens without storing server-side state.
const CSRF_MAX_AGE_MS = 60 * 60 * 1000;

export const CSRF_COOKIE_NAME = COOKIE.CSRF_NAME;

function getSecret(): string {
  const s = process.env.CSRF_SECRET;
  if (!s) throw new Error("CSRF_SECRET environment variable is required");
  return s;
}

function getPreviousSecret(): string | null {
  const s = process.env.CSRF_SECRET_PREVIOUS;
  return s && s.length > 0 ? s : null;
}

/**
 * Constant-time string comparison that is safe regardless of length differences.
 * We pad both strings to the same length before calling timingSafeEqual so that
 * an attacker cannot learn the expected token length from response timing.
 */
function safeEqual(a: string, b: string): boolean {
  // Use a fixed-length comparison buffer (128 bytes) to prevent length oracle.
  const maxLen = 128;
  const aBuf = Buffer.alloc(maxLen);
  const bBuf = Buffer.alloc(maxLen);
  aBuf.write(a, 0, "utf8");
  bBuf.write(b, 0, "utf8");
  // Also check real lengths to reject obviously wrong tokens without branching.
  const lenOk = a.length === b.length;
  // Always call timingSafeEqual (even if lengths differ) to avoid timing leaks.
  const bytesOk = timingSafeEqual(aBuf, bBuf);
  return lenOk && bytesOk;
}

/**
 * Sign a value with HMAC-SHA-256.
 * HMAC is the correct primitive for a MAC: it is resistant to length-extension
 * attacks that affect plain SHA-256(secret || message) constructions.
 */
function hmacSign(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

/**
 * Generate a CSRF token with an embedded timestamp.
 * Format: base64url(random32) . base64url(timestamp_ms) . HMAC-SHA256(random.timestamp)
 *
 * The timestamp allows server-side expiry enforcement without storing state.
 * The HMAC covers both the random value and the timestamp so neither can be
 * forged or altered independently.
 */
export function generateCsrfToken(): string {
  const secret = getSecret();
  const value = randomBytes(32).toString("base64url");
  const ts = Date.now.toString(36); // compact base-36 timestamp
  const signature = hmacSign(secret, `${value}.${ts}`);
  return `${value}.${ts}.${signature}`;
}

/**
 * Verify token format, signature, and age. Returns true if valid.
 * Tries CSRF_SECRET first, then CSRF_SECRET_PREVIOUS if set (for rotation).
 */
export function verifyCsrfToken(token: string | null | undefined): boolean {
  if (!token || typeof token !== "string") return false;

  // New format: value.timestamp.signature (3 parts)
  const parts = token.split(".");
  if (parts.length !== 3) {
    // Reject legacy 2-part tokens (no expiry) — they are no longer accepted.
    return false;
  }

  const [value, ts, signature] = parts;
  if (!value || !ts || !signature) return false;

  // Enforce token age before checking the signature to avoid wasting crypto
  // operations on clearly expired tokens.
  const issuedAt = parseInt(ts, 36);
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > CSRF_MAX_AGE_MS) {
    return false;
  }

  const payload = `${value}.${ts}`;
  const secret = getSecret();
  const expected = hmacSign(secret, payload);
  if (safeEqual(signature, expected)) return true;

  const prev = getPreviousSecret();
  if (prev) {
    const expectedPrev = hmacSign(prev, payload);
    if (safeEqual(signature, expectedPrev)) return true;
  }

  return false;
}

/**
 * Validate CSRF: token from header must match cookie and pass signature + expiry check.
 * Pass the cookie value from cookies.get(CSRF_COOKIE_NAME)?.value.
 */
export function validateCsrf(headerToken: string | null, cookieToken: string | null | undefined): boolean {
  if (!headerToken || !cookieToken) return false;
  if (!safeEqual(headerToken, cookieToken)) return false;
  return verifyCsrfToken(headerToken);
}

export const CSRF_HEADER_NAME = CSRF_HEADER;
export const CSRF_MAX_AGE_SECONDS = CSRF_MAX_AGE_MS / 1000;
