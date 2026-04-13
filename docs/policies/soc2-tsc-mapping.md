# SOC 2 Trust Services Criteria Implementation Mapping

**Document ID:** SOC2-001
**Version:** 1.0
**Effective Date:** 2026-04-09
**Owner:** CISO
**Classification:** Confidential (shared with prospective customers under NDA)

---

## 1. Purpose

This document maps each SOC 2 Trust Services Criterion to the Westbridge control that satisfies it, with a citation to the source code, configuration, or policy where the control is implemented. It is the **single document a vendor security reviewer needs to perform a first-pass evaluation of Westbridge's SOC 2 readiness** before a formal Type 1 audit.

This is NOT a SOC 2 attestation. It is a self-attested gap analysis, written and grounded in actual operational reality, intended to help a prospective customer's security team understand exactly what controls are in place TODAY (2026-04-09) ahead of the formal Type 1 audit currently planned for 2026-Q3.

The criteria below cover the **Common Criteria (CC1–CC9)** plus the **Availability (A1)** and **Confidentiality ** trust principles. We are not pursuing Processing Integrity (PI) or Privacy (P) trust principles in the initial Type 1 — those are scoped for the Type 2.

## 2. Common Criteria

### CC1 — Control Environment

| Criterion | Implementation                                                                                                                                | Evidence                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| CC1.1     | Information Security Policy defines the framework, scope, and objectives. Reviewed annually by the CISO.                                      | `docs/policies/information-security-policy.md`    |
| CC1.2     | Roles and responsibilities documented in §4 of the Information Security Policy. CISO approves all security-relevant decisions.                | `docs/policies/information-security-policy.md` §4 |
| CC1.3     | Organization is small (founder-led, contractors as needed). Org chart and reporting lines documented in `docs/compliance/org-chart.md`.       | `docs/compliance/org-chart.md`                    |
| CC1.4     | All personnel sign the Acceptable Use Policy on hire and annually. Acknowledgements stored in `docs/compliance/aup-acknowledgements/<year>/`. | `docs/policies/acceptable-use-policy.md`          |
| CC1.5     | Personnel changes (new hires, departures) follow the documented onboarding/offboarding procedure in the Access Control Policy §5.             | `docs/policies/access-control-policy.md` §5       |

### CC2 — Communication and Information

| Criterion | Implementation                                                                                                                  | Evidence                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| CC2.1     | Data Classification Policy defines what data exists, how it's classified, and how each class is handled.                        | `docs/policies/data-classification-policy.md` |
| CC2.2     | Internal communication of policies via the `docs/` directory in the source repository, accessible to all personnel.             | `docs/policies/`                              |
| CC2.3     | External communication via the public Trust page (`/trust` on the marketing site), Privacy Policy, DPA, and Sub-processor List. | `docs/policies/subprocessor-list.md` (Public) |

### CC3 — Risk Assessment

| Criterion | Implementation                                                                                                                                            | Evidence                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| CC3.1     | Annual risk assessment process documented. 15 risks identified, scored, and treated.                                                                      | `docs/policies/risk-assessment.md`    |
| CC3.2     | Each P1 risk (score ≥6) has an active treatment plan with an owner.                                                                                       | `docs/policies/risk-assessment.md` §4 |
| CC3.3     | Risk register reviewed annually OR on any material change to the platform / threat model.                                                                 | `docs/policies/risk-assessment.md` §1 |
| CC3.4     | (compliance review)-04-09 by an external advisor; findings tracked in `~/.claude/projects/.../memory/project_audit_remediation.md` and remediated. | (audit memo)                          |

### CC4 — Monitoring Activities

| Criterion | Implementation                                                                                                                            | Evidence                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| CC4.1     | Continuous monitoring via Sentry, Pino logs, application audit log (hash-chained), Fly.io machine health checks, BullMQ failed-job queue. | `src/lib/services/audit.service.ts`, `src/server.ts` |
| CC4.2     | Anomalies reported via Sentry alerts (Slack + email + SMS for P1) and the security event reporter (`src/lib/security-monitor.ts`).        | `src/lib/security-monitor.ts`                        |

### CC5 — Control Activities

| Criterion | Implementation                                                                                                                                                                                                                                                                  | Evidence                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| CC5.1     | Control selection driven by the Risk Assessment §4 treatment plans and the Information Security Policy §3 objectives.                                                                                                                                                           | `docs/policies/risk-assessment.md` |
| CC5.2     | Technology controls implemented in code: encryption (`src/lib/encryption.ts`), authentication (`src/middleware/auth.ts`), authorization (`src/lib/rbac.ts`), audit logging (`src/lib/services/audit.service.ts`), tenant isolation (`src/lib/data/prisma.ts` + RLS migrations). | source repo                        |
| CC5.3     | Security policies enforce the human side: Acceptable Use, Access Control, Change Management, Vendor Management, Data Classification, Encryption, Logging and Monitoring.                                                                                                        | `docs/policies/`                   |

### CC6 — Logical and Physical Access Controls

| Criterion | Implementation                                                                                                                                                                                                                                                | Evidence                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| CC6.1     | Authentication: bcrypt password hashing (cost 14), TOTP MFA (opt-in; org-wide enforcement is a tracked gap targeted 2026-Q3), SSO (SAML 2.0 + OIDC), 7-day session expiry with 30-min idle + fingerprint validation, account lockout after 5 failed attempts. | `src/lib/services/auth.service.ts`, `src/lib/services/session.service.ts`, `src/routes/totp.routes.ts`, `src/routes/sso.routes.ts` |
| CC6.2     | RBAC with four roles (owner, admin, member, viewer) and string-based permission identifiers checked by `requirePermission` middleware.                                                                                                                      | `src/lib/rbac.ts`                                                                                                                  |
| CC6.3     | Access provisioning and deprovisioning procedures documented; access reviews quarterly.                                                                                                                                                                       | `docs/policies/access-control-policy.md` §5, §6                                                                                    |
| CC6.4     | Physical access — N/A; Westbridge is fully remote and all infrastructure is hosted by sub-processors with their own physical security controls.                                                                                                               | (sub-processor SOC 2 reports)                                                                                                      |
| CC6.5     | Logical separation between customer tenants enforced by PostgreSQL Row-Level Security policies + AsyncLocalStorage tenant pinning + explicit `where: { accountId }` in service code.                                                                          | `prisma/migrations/20260318_add_row_level_security/migration.sql`, `src/lib/data/prisma.ts`, `src/lib/data/tenant-als.ts`          |
| CC6.6     | Network security: HTTPS (TLS 1.2+) on all public endpoints, HSTS 2-year, Helmet CSP, CORS scoped to the frontend origin, SSRF protection in webhook delivery.                                                                                                 | `src/app.ts`, `src/workers/index.ts:assertNotPrivateUrl`                                                                           |
| CC6.7     | Encryption: AES-256-GCM with AAD binding for sensitive columns at rest. TLS 1.2+ in transit. See Encryption Policy.                                                                                                                                           | `src/lib/encryption.ts`, `docs/policies/encryption-policy.md`                                                                      |
| CC6.8     | Unauthorized software prevention: code review required for all changes, dependency vulnerability scanning in CI, license compliance check, manual review for new dependencies that touch crypto/payments/PII.                                                 | `.github/workflows/security.yml`, `docs/policies/change-management-policy.md`                                                      |

### CC7 — System Operations

| Criterion | Implementation                                                                                                                  | Evidence                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| CC7.1     | Vulnerability management: Snyk + Dependabot + npm audit + CodeQL + Semgrep on every PR. Critical CVEs patched within 72 hours.  | `.github/workflows/security.yml`                                                |
| CC7.2     | System monitoring: Sentry, Pino, Fly health checks, audit log, SLO tracking middleware.                                         | `src/middleware/slo-tracking.ts`, `src/lib/logger.ts`, `src/server.ts`          |
| CC7.3     | Incident response runbook documented; CISO paged on P1.                                                                         | `docs/runbooks/incident-response.md`                                            |
| CC7.4     | Incident communication via the Sentry alert channels and direct email; status page planned.                                     | `docs/policies/business-continuity-plan.md` §6                                  |
| CC7.5     | Recovery from incidents documented in the Disaster Recovery Plan (Business Continuity Plan §5) and the Database Backup Runbook. | `docs/policies/business-continuity-plan.md`, `docs/runbooks/database-backup.md` |

### CC8 — Change Management

| Criterion | Implementation                                                                                                                                                                                                   | Evidence                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| CC8.1     | Change Management Policy documents the workflow: PR → CI (15 status checks) → review → squash-merge → automated deploy through staging → production canary → production rollout → automated rollback on failure. | `docs/policies/change-management-policy.md`, `.github/workflows/deploy.yml`, `.github/workflows/ci.yml` |

### CC9 — Risk Mitigation

| Criterion | Implementation                                                                                     | Evidence                                                                          |
| --------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| CC9.1     | Risk identified, scored, treated per the Risk Assessment.                                          | `docs/policies/risk-assessment.md`                                                |
| CC9.2     | Vendor risk managed via the Vendor Management Policy + Sub-processor List + DPA on file with each. | `docs/policies/vendor-management-policy.md`, `docs/policies/subprocessor-list.md` |

## 3. Availability (A1)

| Criterion | Implementation                                                                                                                                                         | Evidence                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| A1.1      | Capacity managed via Fly.io auto-scaling on the soft concurrency limit. Two regions (iad + mia) for HA. Background workers separated from the request path via BullMQ. | `fly.toml`, `src/lib/jobs/queue.ts`         |
| A1.2      | Backup, recovery, and PITR enabled via Fly Postgres + Tigris. Daily snapshots, WAL archiving, restore procedure documented.                                            | `docs/runbooks/database-backup.md`          |
| A1.3      | Disaster recovery tested quarterly (planned). Recovery objectives documented in the Business Continuity Plan.                                                          | `docs/policies/business-continuity-plan.md` |

## 4. Confidentiality 

| Criterion | Implementation                                                                                                                                         | Evidence                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| C1.1      | Confidential data identified via the Data Classification Policy. Confidential and Restricted data are encrypted at rest and tenant-isolated by RLS.    | `docs/policies/data-classification-policy.md`                                                         |
| C1.2      | Confidential data is destroyed on customer request and on account deletion (30-day soft-delete grace period, then hard delete via the cleanup worker). | `src/lib/services/account-cleanup.service.ts`, `src/workers/index.ts` (`purge-deleted-accounts` task) |

## 5. Known Gaps (will be remediated before SOC 2 Type 1 attestation)

| Gap                                                                               | Owner            | Target                                  |
| --------------------------------------------------------------------------------- | ---------------- | --------------------------------------- |
| No formal SOC 2 Type 1 attestation yet                                            | CISO             | 2026-Q3 (with Vanta or Drata)           |
| No third-party penetration test in the last 12 months                             | CISO             | 2026-Q2                                 |
| Disaster recovery drill not yet performed                                         | Engineering Lead | 2026-Q2                                 |
| Cyber liability insurance not yet bound                                           | CISO             | 2026-Q2                                 |
| Hardware key (WebAuthn) for founder GitHub + Fly access                           | CISO             | 2026-Q3                                 |
| Org-wide MFA enforcement for owner/admin roles (currently opt-in)                 | Engineering Lead | 2026-Q3                                 |
| CSP `style-src` tightening (currently allows `'unsafe-inline'` for compatibility) | Engineering Lead | 2026-Q3 (depends on inline-style audit) |
| API key rotation policy + automatic expiry                                        | Engineering Lead | 2026-Q3                                 |
| Cookie consent banner not yet rendered                                            | Engineering Lead | 2026-Q2 (today sprint)                  |
| Periodic audit log hash chain verification job (currently on-demand only)         | Engineering Lead | 2026-Q3                                 |
| Cross-cloud DR failover (currently single-cloud Fly.io)                           | CISO             | 2026-Q4                                 |

## 6. How to Verify

A vendor security reviewer can verify any control claim above by:

1. **Source code claims**: Read the cited file (under NDA for source access).
2. **Policy claims**: Read the cited policy doc in `docs/policies/`.
3. **Configuration claims**: Verify via `flyctl config show`, `flyctl secrets list`, GitHub branch protection settings, the relevant CI workflow YAML.
4. **Runtime claims**: Run the cited test file (`vitest run <file>`) in a clean checkout.
5. **End-to-end claims**: Hit the live `/api/health` endpoint, observe the response.

For deeper verification (e.g., "show me a real audit log row with the hash chain populated"), email security@westbridgetoday.com to arrange a screen share.

## 7. Related

- Information Security Policy (`information-security-policy.md`)
- All policies in `docs/policies/`
- All runbooks in `docs/runbooks/`
- The Westbridge (compliance review)(internal, not part of this document set)
