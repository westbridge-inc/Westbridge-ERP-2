# Information Security Policy

**Document ID:** ISP-001
**Version:** 1.0
**Effective Date:** 2026-04-09
**Last Reviewed:** 2026-04-09
**Next Review:** 2027-04-09
**Owner:** CISO / Founder
**Classification:** Public (intentionally — published to /trust)

> SOC 2 Trust Service Criteria mapped: CC1.1, CC1.2, CC1.4, CC2.1, CC5.1, CC5.2

---

## 1. Purpose

This policy establishes the framework Westbridge Inc. ("Westbridge") uses to protect the confidentiality, integrity, and availability of customer data in the Westbridge ERP platform. It is the parent document for the more specific policies referenced in §11 and is binding on all Westbridge personnel, contractors, and sub-processors who handle customer data.

## 2. Scope

This policy applies to:

- All systems, services, and infrastructure that process, store, or transmit Westbridge customer data, including but not limited to: the production API (`westbridge-api` on Fly.io), the frontend (`westbridge-frontend` on Fly.io), the production PostgreSQL cluster (`westbridge-db`), the Redis cache and BullMQ queue (Upstash), the ERPNext business layer (Frappe Cloud), error tracking (Sentry), email delivery (Resend), and payments (Paddle).
- All Westbridge employees, contractors, and any sub-processor with access to customer data.
- All customer data classified as Confidential or Restricted (see Data Classification Policy, §2 of `data-classification-policy.md`).

## 3. Information Security Objectives

Westbridge commits to the following measurable objectives:

| ID  | Objective                                                       | Target                                            |
| --- | --------------------------------------------------------------- | ------------------------------------------------- |
| O1  | Customer data is encrypted in transit                           | TLS 1.2+ on all public endpoints, HSTS 2yr        |
| O2  | Customer secrets are encrypted at rest                          | AES-256-GCM with AAD binding                      |
| O3  | Tenant isolation is enforced at the database layer              | PostgreSQL RLS + AsyncLocalStorage tenant pinning |
| O4  | Audit trail is tamper-evident                                   | Hash-chained audit log entries                    |
| O5  | Authentication uses bcrypt-hashed passwords + optional TOTP MFA | bcrypt cost ≥10, TOTP RFC 6238                    |
| O6  | Critical incidents trigger paging within 5 minutes              | Sentry alerting (see §7)                          |
| O7  | Database backups support PITR within RPO of 1 hour              | Fly Postgres + Tigris bucket, daily + WAL         |
| O8  | Code changes pass automated security scans before merge         | CodeQL, npm audit, OWASP dep-check, semgrep, Snyk |

## 4. Roles and Responsibilities

| Role             | Responsibility                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| CISO / Founder   | Owns this policy. Approves exceptions. Reviews annually.                                                                                            |
| Engineering Lead | Owns implementation of technical controls. Reviews PRs that touch security-sensitive code.                                                          |
| All Engineers    | Follow secure coding patterns documented in `CONTRIBUTING.md` and `CONTRIBUTING-PATTERNS.md`. Report any security incident to the CISO immediately. |
| All Personnel    | Read and acknowledge this policy on hire and annually. Report suspected incidents.                                                                  |

## 5. Information Security Principles

### 5.1 Defense in depth

Every security-critical control has at least two independent layers. Examples implemented in the codebase today:

- **Tenant isolation:** Application-level `where: { accountId }` filtering AND PostgreSQL Row-Level Security policies (`prisma/migrations/20260318_add_row_level_security/migration.sql`, `prisma/migrations/20260409060845_cortex_and_user_scoped_rls/migration.sql`). The runtime database role (`westbridge_app`) is explicitly bound by RLS — see `src/lib/data/prisma.ts` for the AsyncLocalStorage tenant-pin extension.
- **Authentication:** Local bcrypt hash AND ERPNext credential check (`src/lib/services/auth.service.ts`).
- **CSRF:** Cookie-bound HMAC token AND SameSite cookies (`src/lib/csrf.ts`, `src/middleware/auth.ts`).
- **Audit logging:** Database write AND hash chain that links each row to its predecessor (`src/lib/services/audit.service.ts`).

### 5.2 Least privilege

- Database access: the runtime app connects as `westbridge_app`, a role bound by RLS. Cross-tenant administrative queries use a separate `prismaAdmin` client connecting as the schema-owner role (`src/lib/data/prisma-admin.ts`). Migration jobs use `MIGRATION_DATABASE_URL` via Prisma's `directUrl`.
- Application access: RBAC roles defined in `src/lib/rbac.ts`. Permission strings checked via `requirePermission()` middleware.
- Sub-processor access: only the minimum data necessary for each integration is shared (see Sub-processor List, `subprocessor-list.md`).

### 5.3 Fail secure

Where availability and security are in tension, security wins for credential-handling endpoints. Specifically: rate limiters fail CLOSED for `/api/auth/login`, `/api/signup`, password reset, 2FA, and SSO when Redis is unavailable; everything else fails OPEN with an in-process ceiling. See `src/lib/api/rate-limit-tiers.ts` and the Acceptable Use Policy for the complete fail-mode policy.

### 5.4 Secure defaults

New installations and new accounts inherit the strictest security posture without operator intervention. Specifically:

- Sessions are HttpOnly, SameSite=lax/none, Secure in production (`src/lib/constants.ts`).
- New users default to the lowest-privilege role (`viewer`) until promoted.
- ERPNext companies are auto-provisioned per-tenant so no two customers share the same business-layer namespace (`src/lib/services/provisioning.service.ts`).

## 6. Acceptable Use

All personnel must follow the Acceptable Use Policy (`acceptable-use-policy.md`). Notable points:

- Development laptops must have full-disk encryption enabled (FileVault on macOS, BitLocker on Windows, LUKS on Linux).
- Production access is gated by GitHub MFA and Fly.io API tokens scoped per-environment.
- Customer data must NOT be copied to local development environments without explicit written approval and only with a sanitized copy.

## 7. Security Monitoring and Incident Response

- **Continuous monitoring:** Sentry tracks unhandled errors and performance regressions. Alerts route to the on-call channel via webhook.
- **Audit logs:** Every authentication, authorization decision, ERP write, billing event, and admin action is logged to `audit_logs` with a SHA-256 hash chain so any post-hoc tampering of a single row breaks the chain (see `src/lib/services/audit.service.ts:logAudit`).
- **Health checks:** Public `/api/health/live` and `/api/health/ready` endpoints; deeper `/api/health` reports DB, Redis, ERP, memory, disk status.
- **Incident response:** See `docs/runbooks/incident-response.md` for the runbook. CISO is paged on every P1.

## 8. Vulnerability Management

- Dependency vulnerabilities are scanned in CI on every PR via `npm audit`, GitHub Dependabot, and Snyk (see `.github/workflows/security.yml`).
- Static analysis runs CodeQL and Semgrep on every PR.
- Container images are scanned via the Docker workflow.
- Critical CVEs (CVSS ≥9.0) must be patched within 72 hours. High (7.0-8.9) within 14 days. Medium (4.0-6.9) within 30 days.
- Any production vulnerability discovered out-of-cycle triggers an incident response per `docs/runbooks/incident-response.md`.

## 9. Change Management

All production code changes follow the Change Management Policy (`change-management-policy.md`). Summary:

1. Code changes start as a feature branch.
2. PR opened against `main`. CI must pass: typecheck, lint, unit tests, integration tests, security audit, dependency vulnerability scan, license compliance, secret scanning, CodeQL SAST, Semgrep, build, Docker build.
3. PR reviewed by at least one engineer (branch protection requires 1 approving review).
4. Merge to `main` triggers automated deploy: pre-deploy tests → staging → staging health check → production canary → production rollout.
5. Failed health checks trigger automated rollback.

## 10. Acceptance and Annual Review

This policy is reviewed annually by the CISO and any time a significant change occurs in the platform's threat model, regulatory environment, or customer base. Personnel acknowledge this policy on hire and annually thereafter.

## 11. Related Policies

| Document                              | File                               |
| ------------------------------------- | ---------------------------------- |
| Access Control Policy                 | `access-control-policy.md`         |
| Acceptable Use Policy                 | `acceptable-use-policy.md`         |
| Data Classification Policy            | `data-classification-policy.md`    |
| Encryption Policy                     | `encryption-policy.md`             |
| Change Management Policy              | `change-management-policy.md`      |
| Vendor Management Policy              | `vendor-management-policy.md`      |
| Logging and Monitoring Policy         | `logging-and-monitoring-policy.md` |
| Risk Assessment + Treatment Plan      | `risk-assessment.md`               |
| Business Continuity Plan              | `business-continuity-plan.md`      |
| Sub-processor List                    | `subprocessor-list.md`             |
| SOC 2 Trust Services Criteria Mapping | `soc2-tsc-mapping.md`              |
| Incident Response Runbook             | `../runbooks/incident-response.md` |
| Database Backup Runbook               | `../runbooks/database-backup.md`   |

---

_This policy is intentionally classified Public — it appears at https://westbridgetoday.com/trust as evidence of our security posture for customers and prospective customers performing vendor due diligence._
