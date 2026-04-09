# Sub-processor List

**Document ID:** SPL-001
**Version:** 1.0
**Effective Date:** 2026-04-09
**Owner:** CISO
**Classification:** Public

> SOC 2 Trust Service Criteria mapped: CC9.2

---

## 1. Purpose

This is the public list of sub-processors that have access to Westbridge customer data, as required by the Privacy Policy and the Data Processing Agreement (DPA). It is intentionally classified Public and is published at https://westbridgetoday.com/trust/subprocessors so customers can perform their own vendor due diligence.

## 2. Sub-processor Inventory

| Sub-processor              | Purpose                                                 | Data shared                                                                                       | Region                              | DPA on file                            | Notes                                                                                                                     |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Fly.io**                 | Application hosting + Postgres + WireGuard mesh         | All customer data at the storage and compute layer                                                | US (iad), Caribbean traffic via mia | Yes (Fly.io DSA)                       | Hosts `westbridge-api`, `westbridge-frontend`, `westbridge-db`, `westbridge-api-staging`.                                 |
| **Tigris Data**            | Postgres backup storage                                 | Encrypted database backups                                                                        | US                                  | Yes (Tigris DPA)                       | S3-compatible bucket. AES-256 SSE. Backup retention 7 days (configurable).                                                |
| **Upstash**                | Redis (cache + BullMQ queue)                            | Session tokens (hashed), queue payloads, rate-limit counters                                      | US                                  | Yes                                    | `fly-westbridge-redis.upstash.io`. TLS in transit.                                                                        |
| **Frappe Cloud (ERPNext)** | Business-layer ERP (invoices, expenses, projects, etc.) | Customer ERP documents (per-tenant company)                                                       | India / multi-region                | Yes                                    | The downstream business layer. Each Westbridge tenant gets a dedicated ERPNext company.                                   |
| **Resend**                 | Transactional email                                     | Recipient email address, email body (account activation, password reset, invite, payment receipt) | US, EU                              | Yes (Resend DPA)                       | Westbridge falls back to dev-mode (skip + log) in non-production environments to prevent test emails reaching real users. |
| **Paddle**                 | Payments (Merchant of Record)                           | Customer email, billing address, payment metadata. Westbridge does NOT see card data.             | UK, EU, US                          | Yes (Paddle DPA)                       | MoR model — Paddle handles tax, compliance, and chargebacks.                                                              |
| **Anthropic**              | AI inference (Cortex assistant)                         | Conversation context (message history). PII is bounded to what the user types into the AI chat.   | US                                  | Yes (Anthropic Commercial Terms + DPA) | Used by `/api/cortex/chat` and `/api/ai/chat`. Westbridge respects Anthropic's data retention defaults (30 days).         |
| **Sentry**                 | Error tracking + performance monitoring                 | Stack traces, request metadata (paths + headers redacted by `beforeSend` hook in `src/server.ts`) | US, EU                              | Yes (Sentry DPA)                       | Cookies dropped, sensitive headers redacted, absolute filesystem paths stripped.                                          |
| **PostHog**                | Product analytics                                       | Event names, anonymized user IDs, page views                                                      | US, EU                              | Yes (PostHog DPA)                      | PII is not sent — only anonymized identifiers.                                                                            |
| **GitHub**                 | Source code hosting + CI/CD                             | Source code (no customer data in code)                                                            | US                                  | Yes (GitHub Enterprise DPA)            | Branch protection enforced. MFA required.                                                                                 |

## 3. Notification of Changes

Per the Privacy Policy and the DPA, Westbridge will provide reasonable advance notice of any new sub-processor or change to an existing sub-processor's role, including:

- A changelog entry on https://westbridgetoday.com/trust/subprocessors
- An email to the primary contact on every active customer account
- A 30-day objection window during which a customer can request termination of their contract for cause if they object to the new sub-processor

## 4. Verification

A customer or their security reviewer can verify any of the entries above by:

1. Reading the relevant DPA at the vendor's documented URL
2. Cross-referencing with the source code at https://github.com/westbridge-inc/Westbridge-ERP-2 (the codebase is private but a security reviewer under NDA can be given read access)
3. Asking via security@westbridgetoday.com — we will respond within 5 business days

## 5. Last review

This list was last reviewed against the actual codebase on 2026-04-09. The next quarterly review is 2026-07-09.

## 6. Related

- Vendor Management Policy (`vendor-management-policy.md`)
- Privacy Policy (`/privacy` on the marketing site)
- DPA (`/dpa` on the marketing site)
