# Business Continuity Plan

**Document ID:** BCP-001
**Version:** 1.0
**Effective Date:** 2026-04-09
**Owner:** CISO
**Classification:** Confidential

> SOC 2 Trust Service Criteria mapped: A1.1, A1.2, A1.3, CC9.1

---

## 1. Purpose

This Business Continuity Plan (BCP) defines how Westbridge Inc. continues to deliver the Westbridge ERP service during disruptive events ranging from a single-machine failure to a multi-day regional outage. It is paired with the Disaster Recovery Plan (the runbooks in `docs/runbooks/`) which provides the step-by-step procedures.

## 2. Scope

Covers continuity of:

- The Westbridge ERP backend API (`westbridge-api`)
- The Westbridge ERP frontend (`westbridge-frontend`)
- The PostgreSQL database (`westbridge-db`) and its backups (Tigris)
- The Redis cache and BullMQ queue (Upstash)
- ERPNext business layer (Frappe Cloud)
- Sub-processor integrations (Sentry, Resend, Paddle, Anthropic)

## 3. Recovery Objectives

| Metric                                         | Target                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RTO** (recovery time objective) for the API  | 1 hour for a non-database failure, 4 hours for a full DB restore from backup                                                                      |
| **RPO** (recovery point objective)             | 1 hour for the API tier (no persistent state), 5 minutes for the database (WAL archiving when enabled, otherwise daily snapshot granularity ≈24h) |
| **MTTR** (mean time to recover) — historical   | (TBD — first incident establishes baseline)                                                                                                       |
| **MTBF** (mean time between failures) — target | ≥30 days                                                                                                                                          |
| **Service availability** — target              | ≥99.5% over 30 days (Westbridge SLO)                                                                                                              |

## 4. Critical Dependency Inventory

| Dependency               | Single point of failure?                | Mitigation                                                                                                            |
| ------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Fly.io platform          | Yes (full Fly.io outage)                | Two-region deployment (iad + mia). Manual failover to a different cloud is documented but untested.                   |
| `westbridge-db` Postgres | Yes (single primary today)              | Daily backups to Tigris. Plan to add a hot read replica in 2026-Q3.                                                   |
| Upstash Redis            | Yes (Upstash outage)                    | Redis-down fail-mode policy (security patch) ensures application keeps serving most reads.                                    |
| Frappe Cloud (ERPNext)   | Yes (Frappe outage)                     | App-side caching of frequently-read documents in Redis. Read-only ERP data still available during a Frappe outage.    |
| Resend                   | No (best-effort with retries)           | Email retry budget (3 attempts) + permanent failure logged. Customers see "email not sent" but can retry from the UI. |
| Paddle                   | Yes for new payments (no other gateway) | New signups blocked during Paddle outage. Existing customers continue to use the platform. Paddle has its own SLA.    |
| Anthropic                | No (graceful degradation)               | AI assistant returns "service unavailable" with a graceful fallback. Core ERP unaffected.                             |
| Sentry                   | No (logs and alerts only)               | Application keeps running; we lose error visibility during a Sentry outage.                                           |
| GitHub                   | Yes for deploys                         | Cannot deploy during a GitHub outage. Hot-fix via direct Fly CLI deploy from a developer's machine is possible.       |

## 5. Recovery Scenarios

### 5.1 Single API machine failure

**Detection:** Fly.io load balancer marks the machine unhealthy after 3 failed health checks.

**Response:** Fly.io automatically restarts the machine OR routes traffic to the other machine. No manual intervention required.

**RTO:** ~30 seconds.

**Validation:** `curl https://api.westbridgetoday.com/api/health` returns 200.

### 5.2 Full API tier failure

**Detection:** All `/api/health` requests time out OR Fly.io reports both machines unhealthy.

**Response:**

1. Page the on-call engineer.
2. Check Fly.io status page (https://status.flyio.net) and the Fly UI.
3. Deploy the previous release: `flyctl deploy --image registry.fly.io/westbridge-api:<previous-tag>`.
4. If the previous release also fails, escalate to disaster recovery (§5.5).

**RTO:** 1 hour.

### 5.3 Database performance degradation

**Detection:** `/api/health` reports database latency >500ms repeatedly OR alerts on slow queries.

**Response:**

1. Page the on-call engineer.
2. Check `westbridge-db` machine metrics in the Fly UI (CPU, memory, disk I/O).
3. Check active connections via `flyctl ssh console -a westbridge-db -C "psql -U postgres -c 'SELECT count(*) FROM pg_stat_activity'"`.
4. If a runaway query is identified, kill it: `pg_cancel_backend(<pid>)`.
5. If memory pressure is the issue, scale the machine: `flyctl m update <machine-id> --vm-memory <new-mb>`.

**RTO:** 30 minutes.

### 5.4 Database loss (data corruption, accidental DROP, hardware failure)

**Detection:** Application returns 500s on DB queries OR `/api/health` reports database unhealthy.

**Response:**

1. Page the on-call engineer AND CISO.
2. Verify the loss is real (don't assume — check `pg_dump` of the most recent backup against current state).
3. If recoverable from PITR, follow the procedure in `docs/runbooks/database-backup.md` §5.
4. If full restore is needed:
   - Identify the most recent good backup in Tigris (`flyctl pg backup list -a westbridge-db`).
   - Restore to a new cluster (`flyctl pg backup restore`).
   - Update `DATABASE_URL` and `MIGRATION_DATABASE_URL` Fly secrets to point at the new cluster.
   - Verify by querying a known account.
   - Switch DNS / Fly.io routing to the new cluster.
5. Communicate to all customers via email + status page within 1 hour of confirmed loss.
6. Post-mortem within 5 business days.

**RTO:** 4 hours.
**RPO:** Up to 24 hours (since we currently take daily backups).

### 5.5 Full Fly.io outage

**Detection:** Fly.io status page reports a regional or global incident, OR all Fly endpoints become unreachable.

**Response:**

1. Page the on-call engineer AND CISO.
2. Confirm via Fly's status page and out-of-band channels (Twitter, Discord, etc.).
3. Update the Westbridge status page (planned, see §6) with "Investigating — upstream provider issue".
4. Communicate to customers via email within 1 hour with an ETA based on Fly's reported impact.
5. If Fly's outage is expected to exceed 4 hours, evaluate switching to a backup provider:
   - Backup database from Tigris is provider-independent.
   - Backup container image is in `registry.fly.io/westbridge-api` and can be pulled with a Fly token, OR a fresh build can be done from `Westbridge-ERP-2` source.
   - DNS records (Cloudflare) can be repointed to a new provider in <5 minutes.
6. Post-mortem within 5 business days.

**RTO:** 8 hours for a true cross-cloud failover (not yet tested).

### 5.6 Sub-processor outage (Sentry, Resend, Anthropic, etc.)

**Detection:** Sub-processor's status page reports an incident OR application logs show repeated failures to that sub-processor.

**Response:**

- Sentry: no action — application continues to run. Errors are logged to Pino but not aggregated. Catch up on the Sentry side after their incident resolves.
- Resend: emails fail through the retry budget then return err. Customers see "email not sent" but the application stays up. After the outage, manually re-trigger any failed activation/reset emails from the audit log.
- Anthropic: AI assistant returns "service unavailable". Core ERP unaffected.
- Paddle: New checkouts fail. Existing customers unaffected. Communicate to the marketing site about the impact.

## 6. Status Communication

A public status page is planned for delivery in the today sprint at https://status.westbridgetoday.com (Fly app + simple statuspage clone, OR a third-party statuspage). Until then, status updates go to:

- Email to all account owners
- Tweet from @westbridgetoday (no, we don't have a Twitter — TODO)
- Direct support email reply for affected customers

## 7. Testing

| Test                                                        | Frequency | Last performed        |
| ----------------------------------------------------------- | --------- | --------------------- |
| Database restore drill from latest Tigris backup to staging | Quarterly | (planned for 2026-Q2) |
| Full DR plan walk-through (tabletop exercise)               | Annually  | (planned for 2026-Q4) |
| Incident response runbook review                            | Annually  | 2026-04-09            |
| Backup encryption verification (decrypt + checksum)         | Quarterly | (planned for 2026-Q2) |
| Failover to second region (mia)                             | Annually  | (planned for 2026-Q4) |

Test results are recorded in `docs/compliance/dr-tests/`.

## 8. Communication Tree

| Severity | First responder            | Second responder                | CISO                    | Customers                                |
| -------- | -------------------------- | ------------------------------- | ----------------------- | ---------------------------------------- |
| P1       | On-call engineer (founder) | Engineering Lead                | Paged immediately       | Email within 1 hour                      |
| P2       | On-call engineer           | Engineering Lead (after 30 min) | Notified within 4 hours | Email within 4 hours if customer-visible |
| P3       | On-call engineer           | (none)                          | Notified daily          | None unless customer-visible             |

## 9. Related

- Database Backup Runbook (`../runbooks/database-backup.md`)
- Incident Response Runbook (`../runbooks/incident-response.md`)
- Rollback Runbook (`../runbooks/rollback.md`)
- Risk Assessment (`risk-assessment.md`)
