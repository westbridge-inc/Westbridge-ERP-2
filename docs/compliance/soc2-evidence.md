# SOC 2 Type I — Evidence Collection Framework

This document maps Westbridge ERP's existing controls to SOC 2 Trust Service Criteria and identifies gaps requiring attention before a formal audit.

## Trust Service Criteria Coverage

### CC1 — Control Environment

| Control                                        | Evidence                                   | Status   |
| ---------------------------------------------- | ------------------------------------------ | -------- |
| CC1.1 — Organizational commitment to integrity | Code of conduct, CONTRIBUTING.md           | Partial  |
| CC1.2 — Board oversight                        | N/A (early stage)                          | Gap      |
| CC1.3 — Management structure                   | Team roles defined in RBAC (`lib/rbac.ts`) | In place |
| CC1.4 — Commitment to competence               | Hiring process documentation               | Gap      |
| CC1.5 — Accountability                         | Audit logging (every API action logged)    | In place |

### CC2 — Communication and Information

| Control                          | Evidence                               | Status   |
| -------------------------------- | -------------------------------------- | -------- |
| CC2.1 — Internal communication   | ADRs in `docs/adr/`, CONTRIBUTING.md   | In place |
| CC2.2 — External communication   | Privacy policy, Terms of Service pages | In place |
| CC2.3 — Information requirements | `.env.example` documents all config    | In place |

### CC3 — Risk Assessment

| Control                     | Evidence                                            | Status   |
| --------------------------- | --------------------------------------------------- | -------- |
| CC3.1 — Risk identification | TECH-DEBT.md, security scanning in CI               | Partial  |
| CC3.2 — Risk analysis       | CodeQL SAST, npm audit, TruffleHog                  | In place |
| CC3.3 — Fraud risk          | Account lockout (5 attempts), brute force detection | In place |
| CC3.4 — Change impact       | CI pipeline (lint, typecheck, test, build)          | In place |

### CC4 — Monitoring Activities

| Control                          | Evidence                                  | Status   |
| -------------------------------- | ----------------------------------------- | -------- |
| CC4.1 — Ongoing monitoring       | Sentry error tracking, Prometheus metrics | In place |
| CC4.2 — Deficiency communication | Sentry alerts, GitHub Issues              | In place |

### CC5 — Control Activities

| Control                     | Evidence                                    | Status   |
| --------------------------- | ------------------------------------------- | -------- |
| CC5.1 — Control selection   | Security headers, CSRF, rate limiting, RBAC | In place |
| CC5.2 — Technology controls | Automated CI/CD, CodeQL, secret scanning    | In place |
| CC5.3 — Policy deployment   | `docs/policies/` (6 policy documents)       | In place |

### CC6 — Logical and Physical Access

| Control                       | Evidence                                  | Status   |
| ----------------------------- | ----------------------------------------- | -------- |
| CC6.1 — Access provisioning   | Invite-based user onboarding, RBAC roles  | In place |
| CC6.2 — Access revocation     | Session management, account deletion      | In place |
| CC6.3 — Infrastructure access | Non-root Docker user, env-based secrets   | In place |
| CC6.4 — Access review         | Audit log export endpoint                 | In place |
| CC6.5 — Authentication        | bcrypt (cost 12), session fingerprinting  | In place |
| CC6.6 — Access restrictions   | Role-based permissions (5 levels)         | In place |
| CC6.7 — Data transmission     | HTTPS enforced (HSTS), TLS-only cookies   | In place |
| CC6.8 — Threat prevention     | Rate limiting (fails closed), CSP, Helmet | In place |

### CC7 — System Operations

| Control                         | Evidence                                                         | Status   |
| ------------------------------- | ---------------------------------------------------------------- | -------- |
| CC7.1 — Vulnerability detection | CodeQL SAST, npm audit in CI, Dependabot                         | In place |
| CC7.2 — Anomaly monitoring      | Security event reporting to Sentry                               | In place |
| CC7.3 — Change evaluation       | CI pipeline gates (must pass before merge)                       | In place |
| CC7.4 — Incident response       | `docs/runbooks/incident-response.md` (P0-P3, escalation matrix)  | In place |
| CC7.5 — Recovery procedures     | `docs/runbooks/rollback.md` + `docs/runbooks/database-backup.md` | In place |

### CC8 — Change Management

| Control                      | Evidence                      | Status   |
| ---------------------------- | ----------------------------- | -------- |
| CC8.1 — Change authorization | CI pipeline, release workflow | In place |

### CC9 — Risk Mitigation

| Control                | Evidence                          | Status   |
| ---------------------- | --------------------------------- | -------- |
| CC9.1 — Vendor risk    | ERPNext as open-source dependency | Partial  |
| CC9.2 — Vendor changes | Dependabot for dependency updates | In place |

---

## Additional Criteria — Availability

| Control                       | Evidence                                                           | Status   |
| ----------------------------- | ------------------------------------------------------------------ | -------- |
| A1.1 — Capacity management    | k6 load tests (smoke, avg, stress, spike)                          | In place |
| A1.2 — Environmental controls | Docker healthchecks, Fly.io auto-restart                           | In place |
| A1.3 — Recovery procedures    | Rollback runbook, database backup runbook, automated daily backups | In place |

## Additional Criteria — Confidentiality

| Control                                 | Evidence                                | Status   |
| --------------------------------------- | --------------------------------------- | -------- |
| C1.1 — Confidential data identification | Prisma schema `/// @pii` annotations    | In place |
| C1.2 — Confidential data disposal       | Data retention policy, account deletion | In place |

## Additional Criteria — Privacy

| Control         | Evidence                                             | Status   |
| --------------- | ---------------------------------------------------- | -------- |
| P1 — Notice     | Privacy policy page                                  | In place |
| P2 — Choice     | Do Not Track support, cookie consent                 | Partial  |
| P3 — Collection | Minimal PII (email, name only)                       | In place |
| P4 — Use        | Data used only for ERP functionality                 | In place |
| P5 — Disclosure | No third-party data sharing (except Sentry, PostHog) | Partial  |
| P6 — Access     | GDPR data export endpoint                            | In place |
| P7 — Quality    | User profile editing                                 | In place |
| P8 — Monitoring | Audit log for all data access                        | In place |

---

## Gaps Requiring Action

### Priority 1 (Before Audit)

1. ~~**Formal information security policy**~~ — **ADDRESSED:** `docs/policies/information-security-policy.md`
2. **Background checks** — Policy for employee screening (requires HR process, not code)
3. ~~**Security awareness training**~~ — **ADDRESSED:** `docs/policies/security-training.md`
4. ~~**Change management approval**~~ — **ADDRESSED:** `docs/policies/change-management.md` + branch protection rules enforced
5. ~~**Database backup procedures**~~ — **ADDRESSED:** `docs/runbooks/database-backup.md` + `scripts/db-backup.sh` + `.github/workflows/backup.yml`
6. ~~**Business continuity plan**~~ — **ADDRESSED:** `docs/policies/business-continuity-plan.md`

### Priority 2 (During Observation Period)

7. **Access review cadence** — Quarterly access reviews with documented evidence
8. **Vendor risk assessments** — Formal assessment of ERPNext, Sentry, PostHog, Resend
9. **Penetration testing** — Annual pentest by external firm
10. **Incident response testing** — Tabletop exercise documentation

---

## Evidence Collection Automation

The following evidence is automatically generated and can be exported:

| Evidence                       | Source                        | Export Method            |
| ------------------------------ | ----------------------------- | ------------------------ |
| Audit logs                     | `GET /api/audit/export`       | CSV/JSON download        |
| User access list               | `GET /api/team`               | API response             |
| GDPR data export               | `GET /api/account/export`     | JSON download            |
| CI/CD pipeline results         | GitHub Actions                | API/UI                   |
| Dependency vulnerability scans | `npm audit` in CI             | GitHub Actions artifacts |
| SAST results                   | CodeQL                        | GitHub Security tab      |
| Secret scanning                | TruffleHog                    | GitHub Actions logs      |
| System availability            | Health endpoints + Prometheus | Prometheus/Grafana       |
| Error rates                    | Sentry                        | Sentry dashboard         |
