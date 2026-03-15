# Change Management Policy

**Document ID:** CMP-001
**Version:** 1.0
**Effective Date:** 2026-03-15
**Last Reviewed:** 2026-03-15
**Next Review:** 2027-03-15
**Owner:** Chief Information Security Officer (CISO)
**Classification:** Internal

> SOC 2 Trust Service Criteria: CC8.1

---

## 1. Purpose

This policy defines the process for managing changes to the Westbridge ERP production systems, application code, infrastructure, and configurations. It ensures that all changes are authorized, tested, documented, and reversible — reducing the risk of service disruption while maintaining a complete audit trail.

This policy satisfies SOC 2 criterion CC8.1: The entity authorizes, designs, develops or acquires, configures, documents, tests, approves, and implements changes to infrastructure, data, software, and procedures to meet its objectives.

## 2. Scope

This policy applies to all changes to:

- Application source code (Westbridge ERP Backend)
- Database schemas (Prisma migrations)
- Infrastructure configuration (Fly.io, AWS ECS, Docker, Terraform)
- CI/CD pipeline definitions (GitHub Actions workflows)
- Environment variables and secrets
- Third-party integrations and dependencies
- Network and firewall rules
- Monitoring and alerting configurations

## 3. Change Categories

### 3.1 Standard Changes

**Definition:** Pre-approved, low-risk, routine changes that follow a well-established process and have been performed successfully multiple times.

**Examples:**

- Dependency updates flagged by Dependabot (patch and minor versions)
- Documentation updates
- Non-functional code changes (comments, formatting, variable renaming)
- Adding new log statements or metrics
- Updating monitoring thresholds

**Approval:** No additional approval beyond the standard PR process (1 reviewer). Automated CI must pass.

**Deployment:** May be deployed during business hours via standard CI/CD pipeline.

### 3.2 Normal Changes

**Definition:** Changes that introduce new functionality, modify existing behavior, alter database schemas, or affect security-sensitive components. These carry moderate risk and require thorough review.

**Examples:**

- New API endpoints or features
- Database schema migrations (Prisma)
- Changes to authentication, authorization, or encryption logic
- Infrastructure changes (scaling, new services, provider changes)
- Major dependency upgrades
- Changes to RBAC roles or permissions
- Changes to CI/CD pipeline or deployment process
- Integration changes (ERPNext, PowerTranz, Resend)

**Approval:** Requires at least 1 peer code review approval via GitHub Pull Request. Changes to security-sensitive files (`src/lib/rbac.ts`, `src/lib/encryption.ts`, `src/lib/csrf.ts`, `src/middleware/`) require CISO or security-designated reviewer approval.

**Deployment:** Deployed via standard CI/CD pipeline. Database migrations require a separate deployment step (`npx prisma migrate deploy`). Recommended deployment window: business hours with engineering team available.

### 3.3 Emergency Changes

**Definition:** Changes required to resolve a P0/P1 incident or patch an actively exploited security vulnerability. These bypass the standard approval process but are subject to retroactive review.

**Examples:**

- Hotfix for a production outage
- Security patch for a critical vulnerability (CVSS >= 9.0)
- Rollback of a broken deployment
- Emergency rate limit adjustments to mitigate an attack

**Approval:** Verbal approval from the on-call Engineering Lead or CTO is sufficient to proceed. A pull request must still be created (may be merged by the author) and retroactively reviewed within 24 hours.

**Deployment:** Deployed immediately via CI/CD pipeline or manual deployment. Rollback procedures in `docs/runbooks/rollback.md` apply.

## 4. Change Process

### 4.1 Pull Request Workflow

All code and configuration changes follow this workflow:

```
Developer → Branch → Code → PR → CI Pipeline → Review → Merge → Deploy
    │                         │        │            │        │        │
    │                         │        │            │        │        └─ Production
    │                         │        │            │        └─ GitHub merge
    │                         │        │            └─ Peer review (1+ approval)
    │                         │        └─ Lint, Typecheck, Test, Build,
    │                         │           CodeQL SAST, npm audit,
    │                         │           TruffleHog secret scan
    │                         └─ GitHub Pull Request created
    └─ Feature branch from main
```

### 4.2 Detailed Steps

1. **Branch Creation**
   - All changes are developed on feature branches from `main`.
   - Branch naming: `feat/`, `fix/`, `chore/`, `hotfix/`, `docs/` prefixes.

2. **Development**
   - Developer implements changes following Secure Coding Guidelines.
   - Tests written or updated to cover the change.
   - Secrets and credentials never committed to source control.

3. **Pull Request**
   - Developer opens a PR against `main` with:
     - Clear title describing the change.
     - Description explaining the _what_ and _why_.
     - Link to related issue or ticket (if applicable).
     - Screenshot or evidence of testing (for UI-affecting changes).
   - PR template ensures all required information is provided.

4. **Automated CI Pipeline**
   - The following checks must **all pass** before merge is permitted:
     - `npm run lint` — ESLint code quality checks
     - `npm run typecheck` — TypeScript type safety verification
     - `npm run test` — Unit and integration test suite
     - `npm run build` — Production build verification
     - CodeQL SAST — Static application security testing
     - `npm audit` — Dependency vulnerability scanning
     - TruffleHog — Secret detection in code and history
   - **Branch protection rules** enforce that all CI checks pass. No bypass is possible without admin override (which is logged).

5. **Peer Review**
   - At least 1 reviewer must approve the PR.
   - Reviewer verifies:
     - Code correctness and adherence to project standards.
     - Security implications (input validation, access control, data exposure).
     - Test coverage for the change.
     - Database migration safety (backward compatibility, rollback path).
   - For security-sensitive changes: security-designated reviewer required.

6. **Merge**
   - Squash merge to `main` for clean commit history.
   - Merge commit includes PR number for traceability.
   - Branch deleted after merge.

7. **Deployment**
   - CI/CD pipeline automatically builds and deploys to staging.
   - Production deployment triggered manually or via release workflow.
   - Post-deployment health checks verify successful rollout.

### 4.3 Database Migration Process

Database schema changes receive additional scrutiny:

1. Migration created via `npx prisma migrate dev --name <description>`.
2. Migration SQL reviewed as part of the PR (Prisma generates SQL in `prisma/migrations/`).
3. Reviewer verifies:
   - No destructive operations without a migration plan (e.g., column drops phased over 2 releases).
   - Indexes added for new foreign keys or frequently queried columns.
   - Default values provided for new non-nullable columns.
   - Migration is backward-compatible with the currently deployed code.
4. Migration deployed separately from application code: `npx prisma migrate deploy`.
5. Rollback procedure documented in `docs/runbooks/rollback.md`.

## 5. Rollback Procedures

Every change must have a documented rollback path. The default rollback mechanisms are:

| Change Type        | Rollback Method                          | Reference                   |
| ------------------ | ---------------------------------------- | --------------------------- |
| Application code   | Redeploy previous version via Fly.io/ECS | `docs/runbooks/rollback.md` |
| Database migration | Prisma migration rollback or manual SQL  | `docs/runbooks/rollback.md` |
| Infrastructure     | Revert Terraform/IaC commit and apply    | `docs/runbooks/rollback.md` |
| Feature flag       | Disable flag immediately                 | `docs/runbooks/rollback.md` |
| DNS/routing        | Revert DNS record change (TTL-dependent) | `docs/runbooks/rollback.md` |

If a deployment causes a P0/P1 incident, the default action is **rollback first, investigate second**.

## 6. Emergency Hotfix Process

When a P0/P1 incident requires an immediate code change:

1. **Incident declared** — On-call engineer or Incident Commander confirms the issue.
2. **Hotfix branch** — Create `hotfix/<description>` from `main`.
3. **Minimal fix** — Implement the smallest possible change to resolve the issue.
4. **Abbreviated CI** — Run at minimum: lint, typecheck, and targeted tests. Full suite if time permits.
5. **Verbal approval** — Engineering Lead or CTO approves via Slack/phone.
6. **Deploy** — Merge and deploy immediately.
7. **PR created retroactively** — If the PR was not created before merge, one is created within 4 hours documenting the change.
8. **Retroactive review** — A peer review is completed within 24 hours. Any issues found are addressed in a follow-up PR.
9. **Postmortem** — If the hotfix was triggered by an incident, a blameless postmortem is conducted within 48 hours (see `docs/runbooks/incident-response.md`).

## 7. Audit Trail

All changes to production systems are traceable through the following mechanisms:

| Evidence                   | Source                                                      | Retention                           |
| -------------------------- | ----------------------------------------------------------- | ----------------------------------- |
| Code changes               | Git commit history (immutable SHA)                          | Indefinite                          |
| Approval records           | GitHub PR reviews and approvals                             | Indefinite                          |
| CI/CD results              | GitHub Actions workflow runs                                | 90 days (GitHub default) + archived |
| Deployment history         | Fly.io releases / ECS task definition revisions             | 90 days minimum                     |
| Database migration history | `_prisma_migrations` table + `prisma/migrations/` directory | Indefinite                          |
| Infrastructure changes     | Git-tracked IaC + cloud provider audit logs                 | 12 months minimum                   |
| Emergency change records   | GitHub PRs tagged with `emergency` label                    | Indefinite                          |

The combination of git history, GitHub PR records, and CI/CD logs provides a complete, tamper-evident audit trail for every change to production — satisfying SOC 2 CC8.1 evidence requirements.

## 8. Metrics and Reporting

The following metrics are tracked to measure the effectiveness of the change management process:

| Metric                        | Target               | Measurement                                       |
| ----------------------------- | -------------------- | ------------------------------------------------- |
| Change failure rate           | < 5%                 | Deployments causing incidents / total deployments |
| Mean time to recovery (MTTR)  | < 1 hour             | Time from incident detection to resolution        |
| Emergency change rate         | < 10%                | Emergency changes / total changes                 |
| CI pipeline pass rate         | > 95%                | Passing pipeline runs / total runs                |
| Retroactive review completion | 100% within 24 hours | Emergency PRs reviewed on time                    |

Metrics are reviewed monthly by the Engineering Lead and reported quarterly to the CISO.

## 9. Related Documents

| Document                    | Location                                       |
| --------------------------- | ---------------------------------------------- |
| Information Security Policy | `docs/policies/information-security-policy.md` |
| Rollback Runbook            | `docs/runbooks/rollback.md`                    |
| Incident Response Runbook   | `docs/runbooks/incident-response.md`           |
| Deployment Runbook (AWS)    | `docs/runbooks/deploy-aws.md`                  |
| Deployment Runbook (Fly.io) | `docs/runbooks/deploy-fly.md`                  |

## 10. Approval

| Role | Name                       | Date                       |
| ---- | -------------------------- | -------------------------- |
| CISO | ************\_************ | \_**\_/\_\_**/**\_\_\_\_** |
| CTO  | ************\_************ | \_**\_/\_\_**/**\_\_\_\_** |

---

_This document is classified as Internal. Distribute to all engineering personnel._
