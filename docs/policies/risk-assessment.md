# Risk Assessment + Treatment Plan

**Document ID:** RA-001
**Version:** 1.0
**Effective Date:** 2026-04-09
**Owner:** CISO
**Classification:** Confidential

> SOC 2 Trust Service Criteria mapped: CC3.1, CC3.2, CC3.3, CC3.4, CC9.1

---

## 1. Purpose

This document is the formal risk register for Westbridge Inc. It enumerates the threats Westbridge faces, the impact and likelihood of each, the controls in place to mitigate them, and the residual risk after mitigation. It is reviewed annually by the CISO and any time a significant new threat or change to the platform occurs.

## 2. Methodology

Each risk is rated on two dimensions, then multiplied to a final score:

| Dimension      | 1 (Low)                          | 2 (Medium)                                             | 3 (High)                                                                              |
| -------------- | -------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **Likelihood** | Theoretical / never occurred     | Plausible — has occurred at peer companies             | Likely within the next 12 months                                                      |
| **Impact**     | Inconvenience to a few customers | Material data loss, regulator inquiry, or 1-day outage | Material breach affecting all customers, regulator action, or contractual termination |

Score = Likelihood × Impact (1-9). Anything ≥6 is a P1 risk and requires an active treatment plan.

## 3. Risk Register

| ID  | Risk                                                                                                     | Likelihood | Impact | Score | Mitigation                                                                                                                                                                                                                                                                 | Residual |
| --- | -------------------------------------------------------------------------------------------------------- | ---------- | ------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| R1  | Cross-tenant data leak (one customer reads another customer's records)                                   | 1          | 3      | 3     | Defense in depth: explicit `where: { accountId }` in every service AND PostgreSQL RLS on every tenant table AND a separate `prismaAdmin` client for cross-tenant flows. Phase 3 RLS shipped 2026-04-09. Integration test `tenant-isolation.integration.test.ts` covers it. | Low      |
| R2  | Credential stuffing / brute force on `/api/auth/login`                                                   | 3          | 2      | 6     | Rate limiter on login (10 req/min per IP) + per-email rate limit (5 req/min) + account lockout after 5 failed attempts + bcrypt password hashing + TOTP MFA available + fail-CLOSED rate limit policy when Redis is down (M7 fix shipped 2026-04-09).                      | Low      |
| R3  | Database loss (machine failure, accidental DROP, malicious destruction)                                  | 1          | 3      | 3     | Daily Tigris backups (enabled 2026-04-09 — see operator action log). WAL archiving for PITR. Documented restore procedure. Pre-migration snapshots before destructive changes. `--accept-data-loss` flag removed from `prisma db push` (audit fix from 2026-04-09).        | Low      |
| R4  | Compromise of a sub-processor (Resend, Sentry, Anthropic, Paddle, Tigris, Upstash, Frappe Cloud, Fly.io) | 2          | 2      | 4     | Vendor management policy with annual review. DPA on file with each. PII redaction in Sentry. Email best-effort with retries. Webhook signature verification on incoming Paddle hooks. Sub-processor list publicly disclosed.                                               | Medium   |
| R5  | Compromise of a Westbridge employee laptop                                                               | 2          | 3      | 6     | AUP §4 mandates full-disk encryption. Production access via per-person SSH certs (1-day TTL). MFA on every console. No customer data on local devices without sanitization. Offboarding revokes all access same-day.                                                       | Medium   |
| R6  | Application code vulnerability (XSS, SQL injection, SSRF, CSRF)                                          | 2          | 3      | 6     | Helmet with strict CSP. Zod validation on every request body. Prisma parameterized queries. CSRF middleware on every state-changing route. SSRF protection in webhook delivery (`workers/index.ts:assertNotPrivateUrl`). Static analysis (CodeQL, Semgrep) in CI.          | Low      |
| R7  | Supply chain attack (compromised npm package)                                                            | 2          | 3      | 6     | Snyk + Dependabot + npm audit in CI. License compliance check. Manual review for new dependencies that touch crypto, payments, or PII. SBOM generated on every build.                                                                                                      | Medium   |
| R8  | Audit log tampering by an attacker who gained DB access                                                  | 1          | 3      | 3     | Hash-chained audit log: any tampered row breaks the chain. Verification endpoint and (planned) periodic chain audit job. Sensitive operations also leave a trail in Fly.io audit logs (separate trust boundary).                                                           | Low      |
| R9  | DoS / availability attack on the public API                                                              | 3          | 2      | 6     | Per-tier and per-endpoint rate limits. Fly.io's edge has DDoS protection. Redis-based sliding window. In-process fail-open ceiling (M7 fix). Auto-scaling on the Fly machine layer. Two regions (iad + mia) for Caribbean latency.                                         | Medium   |
| R10 | Webhook secret leak (incoming or outgoing)                                                               | 1          | 2      | 2     | Webhook secrets encrypted at rest (AES-256-GCM, AAD bound to endpointId). Verified via signature on every delivery. Rotation supported via the secret rotation procedure in the Encryption Policy.                                                                         | Low      |
| R11 | Phishing / business email compromise targeting the founder                                               | 3          | 2      | 6     | MFA on all consoles (mandatory). Domain key alignment (DKIM/SPF/DMARC) on the Resend sending domain. Privacy Policy and trust page direct customers to `security@westbridgetoday.com` rather than the founder's personal email.                                            | Medium   |
| R12 | Loss of the encryption key (`ENCRYPTION_KEY` Fly secret)                                                 | 1          | 3      | 3     | Encryption key stored as Fly secret with platform-level KMS envelope encryption. `ENCRYPTION_KEY_PREVIOUS` rolling-window for rotation. Validation guard against `PREVIOUS == CURRENT` no-op rotation. Backup of the key is offline (printed and stored in safe).          | Low      |
| R13 | Catastrophic Fly.io platform outage                                                                      | 1          | 3      | 3     | Two regions (iad + mia). Fly's underlying volumes are durable. Tigris backup storage is independent of Fly compute. Fail-back is manual but documented in the Disaster Recovery Plan.                                                                                      | Medium   |
| R14 | Customer admin compromise (one of our customers' admin accounts is taken over)                           | 2          | 2      | 4     | Customer-side responsibility per Access Control Policy §8. We provide TOTP MFA, SSO, password complexity, audit log export. We do NOT enforce MFA on customer admins yet — that's a planned enhancement.                                                                   | Medium   |
| R15 | Regulator action (GDPR, CCPA, ePrivacy)                                                                  | 1          | 3      | 3     | Privacy Policy + DPA + Sub-processor list published. Cookie consent banner (planned for the today sprint). 30-day deletion guarantee in `purge-deleted-accounts` worker. EU customers can request SCCs Module 2.                                                           | Medium   |

## 4. Treatment Plans (P1 risks, score ≥6)

### R2 — Credential stuffing on /api/auth/login

- Status: **Mitigated**. Acceptable residual.
- Owner: Engineering Lead
- Next review: 2026-Q3 to evaluate hardware-key support (WebAuthn).

### R5 — Employee laptop compromise

- Status: **Mitigated** to acceptable residual.
- Open enhancement: Roll out a hardware key (YubiKey or equivalent) for the founder before 2026-Q3 — eliminates the SSO password phishing path entirely.

### R6 — Application code vulnerability

- Status: **Mitigated**. Acceptable residual.
- Open enhancement: Engage a third-party penetration test in 2026-Q2 (planned per the F500 readiness roadmap).

### R7 — Supply chain attack

- Status: **Mitigated**. Acceptable residual.
- Open enhancement: Pin transitive dependencies via `npm shrinkwrap` or `pnpm`. Add SLSA provenance to release artifacts in 2026-Q3.

### R9 — DoS / availability attack

- Status: **Mitigated** with M7 rate-limit fix shipped 2026-04-09. Acceptable residual.
- Open enhancement: Cloudflare WAF in front of Fly.io for further L7 protection (evaluating).

### R11 — Phishing / business email compromise

- Status: **Partially mitigated**.
- Open enhancement: Force WebAuthn (hardware key) on the GitHub org and Fly.io org for the founder. Drop password-based fallback. Target 2026-Q3.

## 5. Acceptance

The CISO accepts the residual risk on each item above as the current operating posture. Items rated Medium residual will be revisited at the next quarterly review or any time a related incident occurs.

## 6. Related

- Information Security Policy (`information-security-policy.md`)
- Vendor Management Policy (`vendor-management-policy.md`)
- Incident Response Runbook (`../runbooks/incident-response.md`)
- Big-4 Audit Report (internal, `~/Downloads/WESTBRIDGE_BIG4_AUDIT_REPORT.md`)
