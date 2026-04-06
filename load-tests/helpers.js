import http from "k6/http";
import { BASE_URL } from "./config.js";

/**
 * Allowed ERPNext doctypes — mirrors ALLOWED_DOCTYPES from the backend.
 */
const ALLOWED_DOCTYPES = [
  "Sales Invoice",
  "Sales Order",
  "Purchase Invoice",
  "Purchase Order",
  "Quotation",
  "Customer",
  "Supplier",
  "Item",
  "Employee",
  "Journal Entry",
  "Payment Entry",
  "Stock Entry",
  "Expense Claim",
  "Leave Application",
  "BOM",
];

/**
 * Returns headers that include the CSRF token.
 * @param {string} csrfToken - The CSRF token value.
 * @returns {object} Headers object with Content-Type and X-CSRF-Token set.
 */
export function getAuthHeaders(csrfToken) {
  return {
    "Content-Type": "application/json",
    "x-csrf-token": csrfToken,
  };
}

/**
 * Performs the login flow:
 *   1. Fetches a CSRF token from GET /api/csrf
 *   2. POSTs credentials to POST /api/auth/login
 *
 * Returns an object with the session cookie jar and CSRF token so
 * subsequent requests can be made as an authenticated user.
 *
 * Credentials are read from k6 environment variables:
 *   - LOAD_TEST_EMAIL  (default: loadtest@example.com)
 *   - LOAD_TEST_PASSWORD (default: Test1234!)
 *
 * @returns {{ jar: object, csrfToken: string }}
 */
export function loginAndGetSession() {
  const jar = http.cookieJar();
  const email = __ENV.LOAD_TEST_EMAIL || "loadtest@example.com";
  const password = __ENV.LOAD_TEST_PASSWORD || "Test1234!";

  // Step 1 — fetch CSRF token
  const csrfRes = http.get(`${BASE_URL}/api/csrf`, {
    jar,
    tags: { name: "csrf_fetch" },
  });
  let csrfToken = "";
  if (csrfRes.status === 200) {
    try {
      const body = csrfRes.json();
      csrfToken = body.data && body.data.token ? body.data.token : "";
    } catch (_) {
      // If we cannot parse the body, fall back to the header
      csrfToken = csrfRes.headers["X-Csrf-Token"] || "";
    }
  }

  // Step 2 — login
  const loginRes = http.post(`${BASE_URL}/api/auth/login`, JSON.stringify({ email, password }), {
    headers: getAuthHeaders(csrfToken),
    jar,
    tags: { name: "login" },
  });

  return { jar, csrfToken, loginResponse: loginRes };
}

/**
 * Picks a random allowed doctype from the ALLOWED_DOCTYPES list.
 * @returns {string} A random doctype name.
 */
export function randomDoctype() {
  return ALLOWED_DOCTYPES[Math.floor(Math.random() * ALLOWED_DOCTYPES.length)];
}
