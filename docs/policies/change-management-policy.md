# Change Management Policy

**Document ID:** CMP-001
**Version:** 1.0
**Effective Date:** 2026-04-09
**Owner:** Engineering Lead
**Classification:** Internal

> SOC 2 Trust Service Criteria mapped: CC8.1, CC7.1

---

## 1. Purpose

This policy defines how changes to the Westbridge production environment are proposed, reviewed, tested, deployed, and rolled back. It exists to ensure that production changes are deliberate, reviewable, and reversible.

## 2. Scope

Applies to changes to:

- Application source code in `Westbridge-ERP-2` (backend) and `Westbridge-ERP-1` (frontend)
- Database schema (`prisma/schema.prisma` + migration files)
- CI/CD workflows (`.github/workflows/*.yml`)
- Fly.io application configuration (`fly.toml`, `fly.staging.toml`)
- Production secrets and environment variables
- Sub-processor configurations (Sentry, Resend, Paddle, Tigris, Upstash, ERPNext)

## 3. Change Categories

| Category            | Examples                                                                                                                | Approval                                | Process                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------ |
| **Standard**        | Bug fix, feature, refactor, doc update                                                                                  | 1 PR review                             | §4 (PR workflow)         |
| **Significant**     | New table, schema migration, infrastructure change                                                                      | 1 PR review + CISO awareness            | §4 + change record       |
| **Emergency**       | P1 incident response patch, critical security hotfix                                                                    | CISO approval (post-hoc OK if blocking) | §5 (emergency workflow)  |
| **Operator action** | Manual production action without code change (e.g., role swap, secret rotation, branch protection bypass for a hot fix) | CISO pre-approval                       | §6 (operator action log) |

## 4. Standard Change Workflow

1. **Branch.** Create a feature branch off `main` named `feat/<short-desc>`, `fix/<short-desc>`, `docs/<short-desc>`, etc.
2. **Code.** Follow the patterns in `CONTRIBUTING.md` and `CONTRIBUTING-PATTERNS.md`. Add tests.
3. **Local checks.** Before pushing, run: `npm test`, `npx tsc --noEmit`, `npx eslint src --max-warnings 0`.
4. **PR.** Open a pull request against `main`. Use the template in `.github/PULL_REQUEST_TEMPLATE.md`. Include:
   - Summary (what changed and why)
   - Test plan (how to verify)
   - Migration / deploy notes (if any)
5. **CI.** GitHub Actions runs all required status checks:
   - `Lint`
   - `Type Check`
   - `Unit Tests` (with coverage)
   - `Integration Tests` (Postgres + Redis services in CI)
   - `Build`
   - `Docker Build`
   - `Security Audit` (npm audit)
   - `Dependency Vulnerability Scan` (Snyk / OWASP)
   - `License Compliance`
   - `Secret Scanning`
   - `CodeQL SAST`
   - `semgrep-cloud-platform/scan`
   - `SBOM Generation`
   - `Load Test (Smoke)`
6. **Review.** At least 1 approving review from another engineer (branch protection enforced).
7. **Merge.** Squash-merge to `main`. The squash commit message should follow the conventional commit format (`feat(...)`, `fix(...)`, `chore(...)`, etc.) and include a `Co-Authored-By:` line for any AI assistance.
8. **Deploy.** Merge to `main` triggers the Deploy workflow:
   1. Pre-deploy tests run
   2. Staging deploy on Fly.io (`westbridge-api-staging`)
   3. Staging health check (12 attempts × 10s)
   4. Production canary deploy (1 machine)
   5. Production canary health check (5 attempts × 10s)
   6. Production rollout to remaining machines
   7. Production health check
   8. Failed health check at any step → automatic rollback to previous release
9. **Verify.** Engineer who merged is responsible for confirming the change is live and functional via `curl https://api.westbridgetoday.com/api/health` and a manual smoke test of the affected feature.

## 5. Emergency Change Workflow

For P1 incidents or critical security hotfixes where the standard workflow's review delay is unacceptable:

1. CISO is paged immediately. Verbal approval is sufficient if written approval is not feasible.
2. Open an emergency PR with `[EMERGENCY]` in the title and a one-line description of the incident it remediates.
3. CI must still pass — no exceptions. Emergency does NOT mean bypassing tests.
4. A second engineer reviews and approves (the founder/CISO can be the reviewer for emergencies).
5. Merge → standard deploy pipeline runs (still goes through staging).
6. Within 24 hours after the incident is resolved, a post-mortem is written and stored in `docs/compliance/incidents/<YYYY-MM-DD>-<short-description>.md`.

## 6. Operator Actions

Some changes happen outside the code repository:

- Production database role swap (e.g., the Phase 3 `westbridge_app` rollout)
- Secret rotation (`fly secrets set`, `fly secrets unset`)
- Backup enable / disable
- Branch protection toggle for an emergency merge
- Cluster scaling (`fly machines update`)
- Sub-processor account changes (adding a Resend domain, changing Paddle webhook URL)

These follow the operator action workflow:

1. CISO pre-approval (in writing — Slack message, commit message, PR comment).
2. Action is performed by an authorized person.
3. Action is recorded in `docs/compliance/operator-actions/<YYYY-MM-DD>-<action>.md` with:
   - What was done
   - Why
   - When (timestamp)
   - Who
   - Verification (what command was run to confirm success)
   - Any rollback plan or follow-up needed
4. If the action affects security posture, an audit log entry is also created via `audit.service.logAudit({ severity: "critical", action: "operator.<action>" })`.

## 7. Database Migrations

Schema changes follow the standard PR workflow with these additional rules:

1. Migration files are generated by `npx prisma migrate dev --name <description>` in development. NEVER edit a migration file after it has been merged to `main`.
2. The release_command in `fly.toml` runs `npx prisma db push` (NOT `migrate deploy` — see the comment in `fly.toml` for the rationale).
3. Destructive changes (DROP COLUMN, DROP TABLE, ALTER COLUMN to a narrower type) are explicitly forbidden by the `--accept-data-loss` flag being absent. If a destructive change is genuinely needed, it requires:
   - A two-phase deploy plan (add new, backfill, switch reads, switch writes, drop old)
   - CISO approval
   - A snapshot of the production database BEFORE the deploy

## 8. Rollback

### 8.1 Automated rollback

The Deploy workflow automatically rolls back if:

- The release_command (prisma db push) fails
- The canary machine fails health checks within 5 attempts
- The production health check fails within 10 attempts after rollout

Rollback restores the previous Fly.io image and the previous database schema state (note: schema changes are NOT auto-rollback-safe; see §7).

### 8.2 Manual rollback

```bash
# View recent releases
flyctl releases --app westbridge-api

# Roll back to a specific release
flyctl image show --app westbridge-api  # Get current image
flyctl deploy --image registry.fly.io/westbridge-api:<previous-tag>
```

### 8.3 Database rollback

Database schema changes are forward-only. To roll back a schema change:

1. Write a NEW migration that reverses the original
2. Test it in staging
3. Merge it through the normal PR workflow

PITR (point-in-time restore) from the Tigris backup is the last resort for catastrophic data loss. See the Database Backup Runbook for the procedure.

## 9. Branch Protection

`main` branch protection on both repos enforces:

- 1 required approving review
- Required status check: `build`
- Strict: branch must be up-to-date with `main`
- No force-push
- No deletions
- No bypass for administrators (the CISO/founder can disable temporarily for emergency operator actions, then must re-enable per the operator action workflow)

## 10. Audit Trail

Every change leaves a trail:

| Layer                 | Audit trail                                                 |
| --------------------- | ----------------------------------------------------------- |
| Code changes          | Git commit history + GitHub PR record + GitHub Actions logs |
| Database migrations   | `_prisma_migrations` table + git commit                     |
| Production secrets    | Fly.io secret history (visible via `flyctl secrets list`)   |
| Application audit log | `audit_logs` table (hash-chained, tamper-evident)           |
| Operator actions      | `docs/compliance/operator-actions/`                         |
| Incidents             | `docs/compliance/incidents/`                                |

## 11. Related

- Information Security Policy (`information-security-policy.md`)
- Access Control Policy (`access-control-policy.md`)
- Database Backup Runbook (`../runbooks/database-backup.md`)
- Incident Response Runbook (`../runbooks/incident-response.md`)
- Rollback Runbook (`../runbooks/rollback.md`)
