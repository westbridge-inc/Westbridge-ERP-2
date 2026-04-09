# CAIQ-Lite Vendor Security Questionnaire — Westbridge Inc.

**Document ID:** CAIQ-001
**Version:** 1.0
**Effective Date:** 2026-04-09
**Owner:** CISO
**Classification:** Confidential (shared with prospective customers under NDA)

> Based on the Cloud Security Alliance Consensus Assessments Initiative Questionnaire — Lite (CAIQ-Lite v4). Complete CAIQ v4 (~261 questions) is available on request.

---

## Overview

This document is Westbridge's pre-filled response to the CAIQ-Lite vendor security questionnaire. It is intended to give a prospective customer's security team a first-pass view of our security posture without requiring a custom questionnaire exchange. Every "Yes" answer below is grounded in implemented code or operational controls — see the corresponding citation in `docs/policies/soc2-tsc-mapping.md` for the file:line reference.

For the longer custom questionnaires that some F500 buyers send (SIG, vendor-specific), Westbridge will respond on a per-engagement basis.

---

## Section 1 — Application & Interface Security (AIS)

| #     | Question                                                                                    | Y/N/NA | Notes                                                                                                                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AIS-1 | Are application security policies and procedures documented and reviewed at least annually? | **Y**  | Information Security Policy (`docs/policies/information-security-policy.md`) reviewed annually by the CISO. Subordinate policies (Encryption, Access Control, Change Management, etc.) are also annual.                                                                                                        |
| AIS-2 | Are application development standards documented?                                           | **Y**  | `CONTRIBUTING.md` and `CONTRIBUTING-PATTERNS.md` document the patterns enforced in code review.                                                                                                                                                                                                                |
| AIS-3 | Are applications designed in accordance with industry security guidelines (e.g., OWASP)?    | **Y**  | Helmet middleware sets CSP, HSTS, X-Frame-Options, and referrer policy. Zod validation on every request body. Prisma parameterized queries. CSRF middleware on all state-changing routes. SSRF protection on outbound webhook delivery. Authentication via bcrypt + TOTP. Tenant isolation via PostgreSQL RLS. |
| AIS-4 | Are applications scanned for vulnerabilities prior to release?                              | **Y**  | Every PR runs CodeQL SAST, Semgrep Cloud, npm audit, Snyk, OWASP dependency-check, and license compliance checks. See `.github/workflows/security.yml`.                                                                                                                                                        |
| AIS-5 | Are critical application vulnerabilities remediated within a defined SLA?                   | **Y**  | Vulnerability Management Policy: critical CVEs (CVSS ≥9.0) within 72 hours, high (7.0-8.9) within 14 days, medium (4.0-6.9) within 30 days. See `docs/policies/information-security-policy.md` §8.                                                                                                             |
| AIS-6 | Is access to source code restricted?                                                        | **Y**  | Both repos (`Westbridge-ERP-1`, `Westbridge-ERP-2`) are private GitHub repos under the `westbridge-inc` org with required MFA, branch protection on `main`, and per-person access.                                                                                                                             |

## Section 2 — Audit Assurance & Compliance (AAC)

| #     | Question                                      | Y/N/NA      | Notes                                                                                                                                                                                           |
| ----- | --------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AAC-1 | Do you hold a SOC 2 Type 1 attestation?       | **Pending** | Type 1 audit scheduled for 2026-Q3 with a recognized CPA firm. Self-attested gap analysis (`docs/policies/soc2-tsc-mapping.md`) shows every TSC criterion already implemented.                  |
| AAC-2 | Do you hold a SOC 2 Type 2 attestation?       | **N**       | Type 2 requires Type 1 first plus a 6-month observation window. Realistic target: early 2027.                                                                                                   |
| AAC-3 | Do you hold an ISO 27001 certification?       | **N**       | Not currently in scope. Will be evaluated based on customer demand.                                                                                                                             |
| AAC-4 | Do you hold a PCI-DSS attestation?            | **NA**      | Westbridge does not handle card data. All payments are processed by Paddle (Merchant of Record), which is PCI-DSS Level 1 attested. Customer card data never touches Westbridge infrastructure. |
| AAC-5 | Do you hold a HIPAA BAA?                      | **N**       | Westbridge is not currently a HIPAA-eligible service. Customers in regulated healthcare verticals should contact us before storing PHI.                                                         |
| AAC-6 | Do you perform third-party penetration tests? | **Pending** | Pen test engagement scheduled for 2026-Q2 with a recognized firm. Last in-house security audit (Big-4 style) was 2026-04-09 — see the audit memo in our private compliance archive.             |
| AAC-7 | Do you have an internal audit function?       | **Y**       | The CISO performs a quarterly review of access controls, sub-processor inventory, and risk register. Findings are recorded in `docs/compliance/`.                                               |

## Section 3 — Business Continuity & Operational Resilience (BCR)

| #     | Question                                                     | Y/N/NA      | Notes                                                                                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BCR-1 | Do you have a documented Business Continuity Plan?           | **Y**       | `docs/policies/business-continuity-plan.md`. Covers RTO/RPO targets, dependency inventory, recovery scenarios, and communication tree.                                                                                                                                      |
| BCR-2 | Are recovery objectives (RTO, RPO) defined?                  | **Y**       | RTO 1h for non-database failures, 4h for full DB restore. RPO target ≤24h (daily Tigris backups). See BCP §3. **Status as of 2026-04-09:** Postgres machine memory upgraded to 512MB to enable Fly Postgres backups; final Tigris bucket binding is the next operator step. |
| BCR-3 | Are backups tested for recoverability on a regular schedule? | **Pending** | Quarterly DR drill scheduled starting 2026-Q2 (after the backup binding completes). Backup runbook documented at `docs/runbooks/database-backup.md`.                                                                                                                        |
| BCR-4 | Are systems monitored for availability and performance?      | **Y**       | Sentry tracks p50/p95/p99 latency and error rates. Fly.io health checks every 15-30s. SLO middleware (`src/middleware/slo-tracking.ts`) records availability and latency per request. SLO targets: 99.5% availability, 500ms p95.                                           |
| BCR-5 | Are incidents documented and post-mortems conducted?         | **Y**       | Incident Response Runbook (`docs/runbooks/incident-response.md`). Post-mortems within 5 business days for all P1 incidents. Stored in `docs/compliance/incidents/`.                                                                                                         |

## Section 4 — Change Control & Configuration Management (CCC)

| #     | Question                                                            | Y/N/NA | Notes                                                                                                                                                                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CCC-1 | Do you have a documented change management process?                 | **Y**  | `docs/policies/change-management-policy.md`. Standard / significant / emergency / operator-action categories with defined approval requirements.                                                                                                                                                                                                               |
| CCC-2 | Are all changes tested before production deployment?                | **Y**  | CI runs 15 status checks on every PR (typecheck, lint, unit tests, integration tests, build, Docker build, security audit, dependency vulnerability scan, license compliance, secret scanning, CodeQL SAST, Semgrep, SBOM, load test smoke). Production deploy requires passing pre-deploy tests, then staging deploy, then staging health check, then canary. |
| CCC-3 | Do you use version control for all code?                            | **Y**  | Git on GitHub. All changes flow through PRs with required reviews and CI status checks. Branch protection enforces this on `main`.                                                                                                                                                                                                                             |
| CCC-4 | Are configuration baselines documented and enforced?                | **Y**  | Infrastructure-as-config: `fly.toml`, `fly.staging.toml`, `prisma/schema.prisma`, `.github/workflows/*.yml`. Application configuration is validated on startup by `src/lib/env.ts` (Zod schema enforced).                                                                                                                                                      |
| CCC-5 | Are production deployments separated from development environments? | **Y**  | Three environments: development (local), staging (`westbridge-api-staging` on Fly.io with separate Postgres database, separate Redis DB number, separate session/CSRF/encryption keys), and production (`westbridge-api`).                                                                                                                                     |

## Section 5 — Data Security & Information Lifecycle Management (DSI)

| #     | Question                                   | Y/N/NA | Notes                                                                                                                                                                                                                                                                                                                                         |
| ----- | ------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DSI-1 | Is customer data encrypted at rest?        | **Y**  | Sensitive columns (passwords, TOTP secrets, ERPNext SIDs, encryption keys, payment provider API keys, SSO secrets, webhook secrets) use AES-256-GCM with associated-data binding (`src/lib/encryption.ts`). Storage volumes encrypted at the platform layer by Fly.io.                                                                        |
| DSI-2 | Is customer data encrypted in transit?     | **Y**  | TLS 1.2+ on all public endpoints (HSTS preload, 2-year). Internal Fly.io traffic over WireGuard mesh.                                                                                                                                                                                                                                         |
| DSI-3 | Are customer datasets logically separated? | **Y**  | PostgreSQL Row-Level Security policies on every tenant table (`prisma/migrations/20260318_add_row_level_security/migration.sql`). Runtime DB role (`westbridge_app`) has no `BYPASSRLS` privilege. Application code also explicitly filters by `accountId`. Defense in depth — both layers must fail simultaneously for cross-tenant leakage. |
| DSI-4 | Is customer data deleted upon request?     | **Y**  | Account deletion is self-service. Soft delete (`deletedAt` set, all PII anonymized, all credentials revoked) is immediate. Hard delete via the `purge-deleted-accounts` cleanup worker after 30 days. Privacy Policy commits to this 30-day window. See `src/lib/services/account-cleanup.service.ts` and `src/workers/index.ts`.             |
| DSI-5 | Do you have a data classification policy?  | **Y**  | `docs/policies/data-classification-policy.md`. Four levels: Restricted, Confidential, Internal, Public. Each level mapped to specific handling requirements and storage locations.                                                                                                                                                            |
| DSI-6 | Are encryption keys managed securely?      | **Y**  | Encryption Policy `docs/policies/encryption-policy.md`. Keys stored as Fly.io secrets (envelope-encrypted by Fly's KMS). Annual rotation with two-key rolling-window via `ENCRYPTION_KEY_PREVIOUS`. Validation guard against `PREVIOUS == CURRENT` no-op rotation.                                                                            |

## Section 6 — Datacenter Security (DCS)

| #     | Question                                                          | Y/N/NA | Notes                                                                                                                                       |
| ----- | ----------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| DCS-1 | Do you operate your own datacenters?                              | **N**  | Westbridge runs entirely on Fly.io. Physical security is delegated to Fly.io and inherited from their datacenter providers (Equinix, etc.). |
| DCS-2 | Does your hosting provider offer SOC 2 attestation?               | **Y**  | Fly.io publishes SOC 2 Type 2 reports. Available at https://fly.io/legal/.                                                                  |
| DCS-3 | Are physical security controls in place at your hosting facility? | **Y**  | Inherited from Fly.io's datacenter providers. Documented in their SOC 2 report.                                                             |

## Section 7 — Encryption & Key Management (EKM)

| #     | Question                                                                   | Y/N/NA | Notes                                                                                                                                                                                                                                                                             |
| ----- | -------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EKM-1 | Do you use industry-standard encryption algorithms?                        | **Y**  | AES-256-GCM (data at rest), TLS 1.2+ (data in transit), bcrypt (passwords, cost ≥10), HMAC-SHA-256 (CSRF tokens, webhook signatures, audit hash chain), SHA-256 (session token storage).                                                                                          |
| EKM-2 | Are encryption keys rotated on a defined schedule?                         | **Y**  | Encryption Policy §5: ENCRYPTION_KEY annually, SESSION/CSRF_SECRET annually, DB password annually, Fly tokens 90 days. Sub-processor API keys annually. TLS certs auto-renewed by Let's Encrypt ~60 days before expiry.                                                           |
| EKM-3 | Are encryption keys protected from unauthorized access?                    | **Y**  | All keys stored as Fly.io secrets, which Fly envelope-encrypts using their platform KMS. Application reads secrets at process start and validates them via `src/lib/env.ts:validateEncryptionKey`. Keys are NEVER logged, NEVER returned in responses, NEVER committed to source. |
| EKM-4 | Is associated data (AAD) bound to encrypted ciphertexts where appropriate? | **Y**  | Every encrypted column has a per-context AAD string (`ENCRYPTION_CONTEXT.totpSecret(userId)`, etc.). A ciphertext for one record cannot be successfully decrypted as another, even by an attacker with the encryption key.                                                        |

## Section 8 — Governance & Risk Management (GRM)

| #     | Question                                              | Y/N/NA | Notes                                                                                                                                                                                                                                 |
| ----- | ----------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GRM-1 | Do you have a CISO or equivalent role?                | **Y**  | The founder serves as CISO. Engineering Lead serves as deputy. Both reviewed and approved this document.                                                                                                                              |
| GRM-2 | Do you have a documented Information Security Policy? | **Y**  | `docs/policies/information-security-policy.md`. Reviewed annually.                                                                                                                                                                    |
| GRM-3 | Do you have a documented Risk Assessment process?     | **Y**  | `docs/policies/risk-assessment.md`. 15 risks identified, scored on likelihood × impact, treated. Reviewed annually.                                                                                                                   |
| GRM-4 | Are security responsibilities documented?             | **Y**  | Information Security Policy §4. CISO, Engineering Lead, All Engineers, All Personnel each have defined roles.                                                                                                                         |
| GRM-5 | Are personnel trained on security topics?             | **Y**  | All personnel sign the Acceptable Use Policy on hire and annually. Acknowledgements in `docs/compliance/aup-acknowledgements/`. Security topics covered: phishing, MFA, device hardening, customer data handling, incident reporting. |

## Section 9 — Human Resources Security (HRS)

| #     | Question                                                             | Y/N/NA | Notes                                                                                                                                                                                                                                                            |
| ----- | -------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HRS-1 | Are background checks performed on personnel with production access? | **N**  | Westbridge is currently founder-led with one contractor. Background check policy is documented and will be applied to the next hire. For now, the limited team size and personal vetting by the CISO substitutes.                                                |
| HRS-2 | Do personnel sign confidentiality / NDA agreements?                  | **Y**  | Standard NDA signed at the start of each engagement. Full-time employees sign as part of the offer letter.                                                                                                                                                       |
| HRS-3 | Is security awareness training provided?                             | **Y**  | Acceptable Use Policy is the on-hire training document and is reviewed annually. Specific topics covered include phishing, MFA, device hardening, customer data handling, and incident reporting.                                                                |
| HRS-4 | Are personnel access rights reviewed regularly?                      | **Y**  | Quarterly access reviews documented in `docs/compliance/access-review-YYYY-QN.md`. Covers GitHub, Fly.io, sub-processor consoles, database role grants.                                                                                                          |
| HRS-5 | Are access rights revoked upon termination?                          | **Y**  | Access Control Policy §5: all access revoked the same day as termination. GitHub org membership removed, Fly.io tokens deleted, sub-processor accounts disabled. Departing person signs an attestation that they have deleted all customer data from any device. |

## Section 10 — Identity & Access Management (IAM)

| #      | Question                                                                 | Y/N/NA        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IAM-1  | Do you support Multi-Factor Authentication (MFA)?                        | **Y, opt-in** | TOTP (RFC 6238) MFA is available to all users on an opt-in basis. 8 single-use backup codes issued at TOTP enrollment, SHA-256 hashed. Login flow: password → if TOTP enabled, issue 5-min Redis-stored "TOTP challenge" token → client redeems via `/api/auth/login/totp`. Implementation: `src/routes/totp.routes.ts`, `src/lib/totp.ts`. **Org-wide enforcement for owner/admin roles is NOT yet in place** — see Honest Gaps (target 2026-Q3). |
| IAM-2  | Do you support Single Sign-On (SSO)?                                     | **Y**         | SAML 2.0 and OIDC. Per-account configuration. Implementation: `src/routes/sso.routes.ts`, `src/lib/services/sso.service.ts`.                                                                                                                                                                                                                                                                                                                       |
| IAM-3  | Are passwords stored using a one-way hash function?                      | **Y**         | bcrypt with cost factor 14 (~250 ms per hash) (`src/lib/services/auth.service.ts:20`). Plaintext is never stored. Legacy SHA-256 hashes are explicitly rejected on login and the user is forced to reset.                                                                                                                                                                                                                                          |
| IAM-4  | Are password complexity requirements enforced?                           | **Y**         | Minimum 10 characters; must contain at least one uppercase, one lowercase, one digit, and one special character. Maximum 128 chars to prevent DoS. Validated by `src/lib/password-policy.ts`.                                                                                                                                                                                                                                                      |
| IAM-5  | Are accounts locked after repeated failed login attempts?                | **Y**         | Account lockout after 5 consecutive failed attempts, locked for 15 minutes. State stored in `users.failed_login_attempts` and `users.locked_until`.                                                                                                                                                                                                                                                                                                |
| IAM-6  | Are sessions invalidated on password change?                             | **Y**         | All sessions for the user are revoked on password change, except the current session. See `src/lib/services/auth.service.ts:158-166`.                                                                                                                                                                                                                                                                                                              |
| IAM-7  | Do you use Role-Based Access Control (RBAC)?                             | **Y**         | Four roles: owner, admin, member, viewer. Permission strings checked by `requirePermission()` middleware. See `src/lib/rbac.ts`.                                                                                                                                                                                                                                                                                                                   |
| IAM-8  | Are session tokens cryptographically random?                             | **Y**         | 32-byte random session tokens (`crypto.randomBytes(32)`). Only the SHA-256 hash is persisted. Sessions also include a fingerprint (SHA-256 of User-Agent + IP /24) validated on every request to detect hijacking. 7-day absolute expiry, 30-min idle timeout, max 5 concurrent sessions per user.                                                                                                                                                 |
| IAM-9  | Do session cookies have HttpOnly, Secure, and SameSite attributes?       | **Y**         | HttpOnly always, SameSite per the COOKIE_SAME_SITE env var (default "none"), Secure in production. See `src/lib/constants.ts`.                                                                                                                                                                                                                                                                                                                     |
| IAM-10 | Is administrative access to production protected by additional controls? | **Y**         | Production database access requires per-person SSH certificates (1-day TTL) issued by Fly.io. All Fly.io console access requires MFA. Privileged actions are recorded in `docs/compliance/operator-actions/`.                                                                                                                                                                                                                                      |

## Section 11 — Infrastructure & Virtualization Security (IVS)

| #     | Question                                                | Y/N/NA      | Notes                                                                                                                                                                                                                                                                 |
| ----- | ------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IVS-1 | Are virtual machines hardened to a documented baseline? | **Y**       | Application runs in a Docker container built from a minimal Node.js base image. The Dockerfile is in source control. Fly.io provides the underlying VM (Firecracker microVM) hardening.                                                                               |
| IVS-2 | Are containers scanned for vulnerabilities?             | **Y**       | The Docker image is built in CI on every PR. Snyk scans the image. Dependabot tracks base image updates.                                                                                                                                                              |
| IVS-3 | Is network traffic between components encrypted?        | **Y**       | All public traffic uses TLS 1.2+. Internal traffic between Fly machines uses Fly's WireGuard mesh, which is encrypted.                                                                                                                                                |
| IVS-4 | Are firewalls in place between trust zones?             | **Y**       | Fly.io provides per-app network isolation. The Postgres cluster is only reachable via the Fly internal network (`westbridge-db.flycast`). The application enforces its own SSRF protection on outbound webhook delivery (`src/workers/index.ts:assertNotPrivateUrl`). |
| IVS-5 | Do you use Web Application Firewall (WAF) protection?   | **Pending** | Cloudflare WAF in front of Fly.io is being evaluated. Currently relying on Fly.io's edge DDoS protection plus the application's own rate limiting (`src/lib/api/rate-limit-tiers.ts`).                                                                                |

## Section 12 — Mobile Security (MOS)

| #     | Question                                        | Y/N/NA | Notes                                                                                                                                                                         |
| ----- | ----------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOS-1 | Do you provide a mobile application?            | **N**  | Westbridge is a responsive web application. There is no native mobile app today.                                                                                              |
| MOS-2 | Are personnel mobile devices managed by an MDM? | **N**  | Westbridge is small enough that personal device management is handled by the Acceptable Use Policy (full-disk encryption required, screen lock, supported OS) without an MDM. |

## Section 13 — Security Incident Management (SEF)

| #     | Question                                                          | Y/N/NA | Notes                                                                                                                                              |
| ----- | ----------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEF-1 | Do you have a documented Incident Response Plan?                  | **Y**  | `docs/runbooks/incident-response.md`. Defines severity levels (P1/P2/P3), responder roles, escalation chain, and customer communication templates. |
| SEF-2 | Are incidents categorized by severity?                            | **Y**  | P1 (system-wide outage or security breach), P2 (degraded service), P3 (single-customer impact). See the IRP for definitions.                       |
| SEF-3 | Are post-incident reviews conducted?                              | **Y**  | Within 5 business days of P1 resolution. Stored in `docs/compliance/incidents/`.                                                                   |
| SEF-4 | Do you notify customers of incidents that affect them?            | **Y**  | DPA commits to notification within 72 hours. Email to all account owners + status page update.                                                     |
| SEF-5 | Do you have a way for external parties to report security issues? | **Y**  | security@westbridgetoday.com. Documented on the public Trust page (`/trust`).                                                                      |

## Section 14 — Supply Chain Management, Transparency, and Accountability (STA)

| #     | Question                                                                      | Y/N/NA | Notes                                                                                                                                                                                             |
| ----- | ----------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| STA-1 | Do you maintain a list of sub-processors?                                     | **Y**  | `docs/policies/subprocessor-list.md` (internal) and the public version at https://westbridgetoday.com/trust/subprocessors. Updated whenever the inventory changes.                                |
| STA-2 | Do you have a Vendor Management Policy?                                       | **Y**  | `docs/policies/vendor-management-policy.md`. Quarterly reviews. Each vendor has a DPA on file.                                                                                                    |
| STA-3 | Do you generate Software Bill of Materials (SBOM)?                            | **Y**  | SBOM Generation runs in CI on every PR. See `.github/workflows/security.yml`.                                                                                                                     |
| STA-4 | Do you use third-party libraries with known vulnerabilities?                  | **N**  | Snyk + Dependabot + npm audit + OWASP dependency-check run in CI on every PR. Critical CVEs blocked from merge. Both repos passed `npm audit --omit=dev` with 0 vulnerabilities as of 2026-04-09. |
| STA-5 | Do you provide customers with reasonable notice of changes to sub-processors? | **Y**  | 30 days notice via email + Trust page changelog. Customers have a 30-day objection window during which they can request termination of contract for cause if they object.                         |

## Section 15 — Threat & Vulnerability Management (TVM)

| #     | Question                                            | Y/N/NA      | Notes                                                                                                                                                                                             |
| ----- | --------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TVM-1 | Do you have a Vulnerability Management Program?     | **Y**       | Information Security Policy §8. Critical CVEs within 72 hours, high within 14 days, medium within 30 days. Snyk + Dependabot + npm audit + CodeQL + Semgrep in CI.                                |
| TVM-2 | Do you scan production systems for vulnerabilities? | **Y**       | Application code scanned in CI. Dependencies scanned continuously by Snyk and Dependabot. Container images scanned. The infrastructure layer is Fly.io's responsibility (covered by their SOC 2). |
| TVM-3 | Do you have a process to apply security patches?    | **Y**       | Dependabot opens PRs for security advisories. Engineer reviews, merges, deploy pipeline ships through staging → canary → production within hours of merge for critical patches.                   |
| TVM-4 | Do you perform third-party penetration tests?       | **Pending** | First third-party pen test scheduled for 2026-Q2. The 2026-04-09 internal Big-4-style audit covered the same territory; results and remediation tracked in our private compliance archive.        |

---

## Honest gaps

These items are explicitly **not** in place today and we will not pretend otherwise. Each is on the F500-readiness roadmap with a target quarter.

| Item                                                              | Target                   | Owner            |
| ----------------------------------------------------------------- | ------------------------ | ---------------- |
| SOC 2 Type 1 attestation                                          | 2026-Q3                  | CISO             |
| SOC 2 Type 2 attestation                                          | 2027-Q1                  | CISO             |
| Third-party penetration test report                               | 2026-Q2                  | CISO             |
| Cyber liability insurance                                         | 2026-Q2                  | CISO             |
| Org-wide MFA enforcement for owner/admin roles (currently opt-in) | 2026-Q3                  | Engineering Lead |
| Tigris bucket binding for Fly Postgres backups (operator step)    | 2026-04-09 (today)       | CISO             |
| DR drill / restore-from-backup verification                       | 2026-Q2                  | Engineering Lead |
| CSP `style-src` tightening (currently allows `'unsafe-inline'`)   | 2026-Q3                  | Engineering Lead |
| API key rotation policy + automatic expiry                        | 2026-Q3                  | Engineering Lead |
| Periodic audit log hash chain verification job                    | 2026-Q3                  | Engineering Lead |
| Background checks on production-access personnel                  | Next hire                | CISO             |
| HIPAA BAA                                                         | Not currently scoped     | —                |
| ISO 27001 certification                                           | Not currently scoped     | —                |
| Mobile application                                                | Not currently scoped     | —                |
| MDM for personnel devices                                         | When team grows beyond 5 | CISO             |
| WAF in front of public endpoints                                  | Evaluating Cloudflare    | Engineering Lead |

We will share progress on every item above on request and update this document the day a new attestation or report becomes available.

---

## Verifying claims in this document

A vendor security reviewer can verify any claim above by:

1. **Source code claims**: read the cited file (NDA required for source access).
2. **Policy claims**: read the cited policy doc in `docs/policies/`.
3. **CI claims**: review the cited workflow YAML in `.github/workflows/`.
4. **Runtime claims**: hit the live endpoint and observe the response.
5. **Operational claims**: schedule a screen share via security@westbridgetoday.com.

For a deeper review (e.g., CAIQ v4 with all 261 questions, or a custom SIG questionnaire) please contact security@westbridgetoday.com and we will respond within 5 business days.

---

_Last reviewed against the actual codebase: 2026-04-09. Next review: 2026-07-09._
