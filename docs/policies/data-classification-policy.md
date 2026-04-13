# Data Classification Policy

**Document ID:** DCP-001
**Version:** 1.0
**Effective Date:** 2026-04-09
**Owner:** CISO
**Classification:** Internal

> SOC 2 Trust Service Criteria mapped: CC2.1, C1.1

---

## 1. Purpose

This policy defines how Westbridge classifies the data it processes, stores, and transmits, and the handling requirements that flow from each classification. It exists so that engineers, operators, and sub-processor reviewers can answer the question "where is this data allowed to go?" without ambiguity.

## 2. Classification Levels

| Level            | Examples                                                                                                              | Controls                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Restricted**   | Passwords (hashed), TOTP secrets, ERPNext session IDs, encryption keys, payment provider API keys, SSO client secrets | Encrypted at rest with AES-256-GCM (AAD bound) AND access only from authorized service code paths. NEVER logged. NEVER returned in API responses. |
| **Confidential** | Customer ERP data (invoices, expenses, projects, etc.), audit logs, account email + name, billing history             | Encrypted in transit (TLS 1.2+). Access gated by RLS + RBAC. May appear in tenant-scoped audit logs. NEVER cross tenants.                         |
| **Internal**     | Application logs (with PII redacted), Sentry events (with PII redacted), feature flag state, system audit logs        | Encrypted in transit. Access gated by employee SSO/MFA on the relevant sub-processor console. May be shared internally but not publicly.          |
| **Public**       | Marketing pages, pricing, documentation, this policy doc, the trust page, OpenAPI spec                                | Free to publish. No restrictions.                                                                                                                 |

## 3. Mapping to Storage Locations

| Data                                         | Classification | Storage                                                  |
| -------------------------------------------- | -------------- | -------------------------------------------------------- |
| User passwords                               | Restricted     | `users.password_hash` (bcrypt hashed)                    |
| TOTP secrets                                 | Restricted     | `totp_secrets.secret` (AES-256-GCM, AAD-bound to userId) |
| ERPNext session IDs (per Westbridge session) | Restricted     | `sessions.erpnext_sid` (AES-256-GCM, AAD-bound)          |
| SSO config (client secret)                   | Restricted     | `sso_configs.client_secret` (AES-256-GCM)                |
| Encryption keys                              | Restricted     | Fly.io secret store (envelope encrypted by Fly)          |
| Payment provider API keys                    | Restricted     | Fly.io secret store                                      |
| Webhook signing secrets                      | Restricted     | `webhook_endpoints.secret` (AES-256-GCM, AAD-bound)      |
| Customer ERP documents                       | Confidential   | ERPNext (Frappe Cloud) + cached in Redis                 |
| Account / user records (email, name, role)   | Confidential   | `accounts`, `users` tables in `westbridge-db`            |
| Billing invoices                             | Confidential   | `billing_invoices` table                                 |
| Audit logs                                   | Confidential   | `audit_logs` table (hash-chained)                        |
| Application logs (Pino → stdout)             | Internal       | Fly.io log stream + Sentry breadcrumbs                   |
| Sentry error events                          | Internal       | Sentry (paths + headers redacted, see `src/server.ts`)   |
| Feature flag state                           | Internal       | `feature_flags` table + Redis cache                      |
| OpenAPI spec                                 | Public         | `/api/openapi` endpoint                                  |
| Pricing, ToS, Privacy Policy, DPA            | Public         | Frontend `/marketing/*` routes                           |

## 4. Handling Requirements

### 4.1 Restricted

- MUST be encrypted at rest using AES-256-GCM with associated data (AAD) binding (see Encryption Policy §3).
- MUST never appear in plaintext in logs, Sentry events, error messages, audit log metadata, or API responses.
- Access from application code is allowed only through the dedicated service helpers in `src/lib/encryption.ts`. The encryption module's tests cover all the AAD context strings (`ENCRYPTION_CONTEXT.totpSecret`, `ENCRYPTION_CONTEXT.sessionErpnextSid`, `ENCRYPTION_CONTEXT.webhookSecret`, etc.) so any new restricted field gets a context binding by code review.
- Restricted secrets in transit between sub-processors (e.g., Resend API key sent over HTTPS) are protected by TLS only — they are not double-encrypted.

### 4.2 Confidential

- MUST be encrypted in transit (TLS 1.2+ enforced by Helmet HSTS settings in `src/app.ts`).
- Reads and writes from authenticated request handlers go through the RLS-pinned `prisma` client, which enforces tenant isolation via PostgreSQL RLS policies.
- Cross-tenant access is restricted to a small set of system flows (`prismaAdmin`) that are individually justified in code comments and reviewed.
- Audit log metadata is automatically scrubbed for sensitive keys (`password`, `secret`, `token`, `apiKey`, etc.) by `src/lib/services/audit.service.ts:redactSensitive` before persistence.

### 4.3 Internal

- May be transmitted to sub-processors that have signed a DPA and meet the security baseline in the Vendor Management Policy.
- PII redaction is enforced before logs leave the application: IP addresses are redacted to /24 (last octet zeroed) by `src/lib/services/audit.service.ts:redactIp`, user agents are SHA-256 hashed and truncated to 16 chars by the same module, and Sentry's `beforeSend` hook (in `src/server.ts`) drops cookies and redacts sensitive headers.
- Internal data may NOT be shared with third parties without legal review.

### 4.4 Public

- May be freely published. Engineering should review changes to public docs the same way they review code: PR + review.

## 5. Data at Rest Encryption Verification

The following test files lock the encryption-at-rest behavior in for regression:

- `src/lib/__tests__/encryption.test.ts` — covers AES-256-GCM round trip + AAD binding mismatch detection
- `src/lib/services/__tests__/session.service.test.ts` — covers ERPNext SID encryption
- The v3.0 audit memory documents this rating as 5/5 (cryptography)

## 6. Data in Transit Encryption

- All public endpoints require HTTPS via Fly.io's automatic Let's Encrypt certificates + force_https=true in `fly.toml`.
- HSTS header set to `max-age=63072000; includeSubDomains; preload` (2 years) by Helmet (`src/app.ts:94`).
- Internal traffic between Fly machines uses Fly's encrypted WireGuard mesh by default; the `sslmode=disable` on the Postgres connection string is acceptable because the WireGuard mesh provides the equivalent of TLS at the network layer (documented in `src/lib/env.ts:175-197`).

## 7. Data Retention by Classification

See the Data Retention section of the Logging and Monitoring Policy (`logging-and-monitoring-policy.md` §6) for specific retention periods. Summary:

| Class        | Retention                                                                              |
| ------------ | -------------------------------------------------------------------------------------- |
| Restricted   | Until rotation OR account deletion (whichever first)                                   |
| Confidential | 7 years for billing invoices; 1 year for audit logs; account-lifetime for user records |
| Internal     | 30 days for application logs; 90 days for Sentry events                                |
| Public       | Indefinite                                                                             |

## 8. Cross-Border Transfer

Westbridge currently runs in a single region (Fly.io `iad`, US East). Customer data does not leave the US except for sub-processor API calls (Resend, Anthropic, Paddle — all of which have their own DPAs and regional commitments documented in the Sub-processor List).

For EU customers, the standard contractual clauses (SCCs Module 2) and UK IDTA addendum are documented in the DPA. Until we have a verified EU region deployment, customers requesting EU-region data residency cannot be served.

## 9. Related

- Encryption Policy (`encryption-policy.md`)
- Vendor Management Policy (`vendor-management-policy.md`)
- Privacy Policy (customer-facing, hosted on the marketing site)
- Sub-processor List (`subprocessor-list.md`)
