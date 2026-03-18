# Vendor Risk Assessments

**Document ID:** VRA-001
**Version:** 1.0
**Assessment Date:** 2026-03-18
**Next Review:** 2027-03-18
**Owner:** CISO
**Classification:** Internal

---

## 1. ERPNext (Self-Hosted)

| Attribute               | Detail                                                                         |
| ----------------------- | ------------------------------------------------------------------------------ |
| **Vendor**              | Frappe Technologies (open source)                                              |
| **Data Processed**      | All ERP data: financial records, customer data, inventory, HR records, payroll |
| **Data Classification** | Confidential / Restricted (per ISP-001)                                        |
| **Risk Level**          | **High** — core business data store                                            |
| **Deployment**          | Self-hosted on Westbridge-controlled infrastructure                            |
| **Certifications**      | N/A (self-hosted; our infrastructure controls apply)                           |
| **Data Residency**      | Our infrastructure (AWS / Railway)                                             |
| **Encryption**          | TLS in transit; encryption at rest via infrastructure provider                 |

**Security Controls Verified:**

- Network isolation: ERPNext accessible only from backend API server
- Authentication: Session-based with encrypted SID storage (AES-256-GCM)
- Tenant isolation: Company-scoped queries with `verifyTenantAccess` defense-in-depth
- Path injection prevention: `encodeURIComponent` on all doctype/document name parameters
- Forbidden field stripping: Internal ERPNext fields stripped on write operations

**Exit Strategy:** ERPNext is open-source (GPLv3). Full data export available via ERPNext API. No vendor lock-in.

---

## 2. PowerTranz (Payment Processor)

| Attribute               | Detail                                                       |
| ----------------------- | ------------------------------------------------------------ |
| **Vendor**              | PowerTranz Ltd (Barbados)                                    |
| **Data Processed**      | Payment card data, transaction amounts, customer identifiers |
| **Data Classification** | Restricted (per ISP-001)                                     |
| **Risk Level**          | **Critical** — payment processing                            |
| **Certifications**      | PCI DSS Level 1                                              |
| **Data Residency**      | Caribbean (Barbados)                                         |
| **Encryption**          | TLS 1.2+ in transit; PCI-compliant at-rest encryption        |

**Security Controls Verified:**

- No card data stored locally — hosted payment page (HPP) flow
- HMAC-SHA256 callback signature verification (`src/lib/data/powertranz.client.ts`)
- Transaction ID and RRN stored for reconciliation (no card numbers)
- Idempotency checks on payment callbacks to prevent double-processing
- IP allowlist for webhook callbacks

**Contractual Protections:** PCI DSS compliance attestation. Caribbean-focused processor with local regulatory alignment.

**Exit Strategy:** Standard payment processor integration pattern. Switch to alternative processor (e.g., WiPay, First Atlantic Commerce) by implementing new client module.

---

## 3. Sentry (Error Tracking)

| Attribute               | Detail                                                  |
| ----------------------- | ------------------------------------------------------- |
| **Vendor**              | Functional Software Inc. (Sentry)                       |
| **Data Processed**      | Error traces, stack traces, user context (redacted PII) |
| **Data Classification** | Internal                                                |
| **Risk Level**          | **Medium**                                              |
| **Certifications**      | SOC 2 Type II                                           |
| **Data Residency**      | US (cloud)                                              |
| **Encryption**          | TLS in transit; AES-256 at rest                         |

**Security Controls Verified:**

- PII scrubbing configured in `sentry.client.config.ts` and `sentry.server.config.ts`
- Passwords, tokens, cookies, secrets, authorization headers all redacted
- Error sampling: 100% errors, 10% transactions in production
- No sensitive business data (financial amounts, customer names) sent to Sentry

**Exit Strategy:** Self-hosted Sentry available as alternative. GlitchTip as open-source option.

---

## 4. PostHog (Analytics)

| Attribute               | Detail                                                                 |
| ----------------------- | ---------------------------------------------------------------------- |
| **Vendor**              | PostHog Inc.                                                           |
| **Data Processed**      | Usage analytics, feature flag evaluations, anonymized user identifiers |
| **Data Classification** | Internal                                                               |
| **Risk Level**          | **Low**                                                                |
| **Certifications**      | SOC 2 Type II                                                          |
| **Data Residency**      | EU/US (cloud)                                                          |
| **Encryption**          | TLS in transit; encrypted at rest                                      |

**Security Controls Verified:**

- No PII tracked: user identified by account ID, not email/name
- Feature flags use HMAC-based deterministic rollout (no PII in evaluation)
- Self-hostable if data residency requirements change
- Analytics data is non-critical — service degradation is acceptable

**Exit Strategy:** PostHog is open-source. Self-host or migrate to alternative analytics platform.

---

## 5. Resend (Email Delivery)

| Attribute               | Detail                                                                       |
| ----------------------- | ---------------------------------------------------------------------------- |
| **Vendor**              | Resend Inc.                                                                  |
| **Data Processed**      | Email addresses, email content (account activation, password reset, billing) |
| **Data Classification** | Confidential (email addresses are PII)                                       |
| **Risk Level**          | **Medium**                                                                   |
| **Certifications**      | SOC 2 Type II                                                                |
| **Data Residency**      | US (cloud)                                                                   |
| **Encryption**          | TLS in transit                                                               |

**Security Controls Verified:**

- No sensitive data in email bodies (no passwords, no financial details beyond plan name/amount)
- Email templates reviewed to ensure minimal PII exposure
- API key stored as environment variable, not in code
- Fire-and-forget pattern: email delivery failure does not block business operations

**Exit Strategy:** Standard SMTP/API email provider. Switch to SendGrid, AWS SES, or self-hosted mail server.

---

## 6. Review Summary

| Vendor     | Risk Level | Last Assessment | Next Assessment      | Owner            |
| ---------- | ---------- | --------------- | -------------------- | ---------------- |
| ERPNext    | High       | 2026-03-18      | 2027-03-18           | CISO             |
| PowerTranz | Critical   | 2026-03-18      | 2026-09-18 (6-month) | CISO             |
| Sentry     | Medium     | 2026-03-18      | 2027-03-18           | Engineering Lead |
| PostHog    | Low        | 2026-03-18      | 2027-03-18           | Engineering Lead |
| Resend     | Medium     | 2026-03-18      | 2027-03-18           | Engineering Lead |

---

| Role | Name          | Date       |
| ---- | ------------- | ---------- |
| CISO | Mayur Goswami | 2026-03-18 |
| CTO  | Mayur Goswami | 2026-03-18 |
