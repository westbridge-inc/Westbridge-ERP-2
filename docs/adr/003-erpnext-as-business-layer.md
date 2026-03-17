# ADR-003: ERPNext as Business Data Layer

## Status: Accepted

## Date: 2026-03-10

## Context

Building a full ERP from scratch (accounting, inventory, HR, procurement) was
not feasible for a small team targeting a Caribbean launch. The options were:

- **Build from scratch** -- full control, multi-year effort.
- **ERPNext (Frappe)** -- open-source, Python-based ERP with REST API, covers
  accounting, HR, inventory, procurement, and CRM out of the box.
- **Odoo** -- similar scope but more restrictive licensing for SaaS.

The product needed Caribbean-specific features (Guyana NIS, PAYE, VAT) layered
on top of standard ERP functionality.

## Decision

We use **ERPNext as the business data backend**, accessed exclusively through
`src/lib/data/erpnext.client.ts`.

Implementation details:

- All ERPNext communication goes through a single data-layer client with typed
  CRUD operations (`erpList`, `erpGet`, `erpCreate`, `erpUpdate`, `erpDelete`).
- The client relays the user's ERPNext session cookie (decrypted from the
  session store) so ERPNext enforces its own permission model per-user.
- In development, API key/secret auth is used as a fallback when the session
  is `dev-local-session`.
- Tenant isolation is enforced by injecting a company filter into `erpList`
  queries based on the account's `erpnextCompany` setting.
- Retry logic with exponential backoff (3 attempts, 500ms base) handles
  transient 502/503/429 responses.
- HTTPS is enforced in production at module load time -- the server crashes
  on startup if `ERPNEXT_URL` is not HTTPS.
- Doctype names are URI-encoded to prevent path traversal.
- 404 responses from ERPNext are treated as empty results, not errors (handles
  missing HRMS modules gracefully).

## Consequences

### Positive

- Months of accounting, inventory, and HR logic available immediately.
- ERPNext's permission model provides a second layer of access control.
- The proxy architecture lets the frontend call a single API origin.

### Negative

- ERPNext is a runtime dependency -- if it is down, ERP features are
  unavailable. Mitigated by retry logic and the BullMQ `erp-sync` queue for
  async operations.
- ERPNext's REST API is not always well-documented; some endpoints required
  reverse-engineering.
- The `NEXT_PHASE` build-phase guard in the client is a workaround for
  Next.js SSR importing the module at build time without environment
  variables.
