# Logging and Monitoring Policy

**Document ID:** LMP-001
**Version:** 1.0
**Effective Date:** 2026-04-09
**Owner:** Engineering Lead
**Classification:** Internal

> SOC 2 Trust Service Criteria mapped: CC7.1, CC7.2, CC7.3, CC7.4, CC7.5

---

## 1. Purpose

This policy defines what events Westbridge logs, how those logs are protected from tampering, how long they are retained, who can access them, and how they are monitored to detect security and reliability incidents.

## 2. What Gets Logged

### 2.1 Application logs (Pino)

The application logs every request and every significant lifecycle event to stdout via Pino (`src/lib/logger.ts`). Fly.io ships these to its log stream where they are retained per Fly's defaults.

**Always logged at INFO:**

- Server startup, shutdown, graceful shutdown sequence
- Connection warmup (DB pool, Redis pool)
- Worker startup
- Every HTTP request: method, path, status, duration_ms, request_id

**Always logged at WARN:**

- Rate limit failures with Redis-down (per fail-mode policy in `src/lib/api/rate-limit-tiers.ts`)
- Email send failures that succeed on retry
- Webhook circuit breaker disable events
- Authentication anomalies (unknown role, locked-out account)

**Always logged at ERROR:**

- Email send permanent failures
- Webhook delivery failures
- ERPNext provisioning failures
- Any caught exception in route handlers
- Any unhandled promise rejection (forwarded to Sentry)

### 2.2 Audit log (database)

The application audit log (`audit_logs` table) is a separate, tamper-evident record of every security-relevant event. See `src/lib/services/audit.service.ts:logAudit`.

Events logged include:

- Authentication: login success/failure, logout, session revoke, password change, 2FA setup/verify/disable
- Authorization: permission check failures
- ERP writes: every doctype create/update/delete via `/api/erp/doc`
- Billing: invoice creation, refund, plan change, subscription cancellation
- Team: invite sent/accepted, member removed, role changed
- Account: signup, deletion, GDPR data export, account purge
- System: report generation, cleanup task runs, account-level critical events

Each row contains:

- `accountId` (nullable for system-level events that have no tenant)
- `userId` (nullable for unauthenticated or system events)
- `action` (e.g., `auth.login.success`, `erp.doc.create`)
- `resource` and `resourceId` (e.g., `Sales Invoice` and the invoice name)
- `severity` (`info`, `warning`, `critical`)
- `outcome` (`success`, `failure`)
- `ipAddress` (redacted to /24 — last octet zeroed by `redactIp()`)
- `userAgent` (SHA-256 hashed and truncated to 16 chars)
- `metadata` (JSON, recursively redacted for sensitive keys by `redactSensitive()`)
- `timestamp`
- Hash chain fields: `_hash` (SHA-256 of the row's content + previous row's hash), `_prevHash` (the previous row's `_hash`)

### 2.3 Hash chain (tamper evidence)

The audit log is a hash chain. The `_hash` field on row N is computed as:

```
SHA-256(canonical_json(row_N) + prev_row._hash)
```

The previous hash is cached in Redis (`audit:lastHash:<accountId>`) for performance. If a single audit log row is altered, deleted, or inserted out of order, the chain breaks: the recomputed hash for the affected row will not match the stored value, and every subsequent row's hash will diverge from the recomputed sequence.

A periodic verification job (TODO: scheduled cleanup task) will recompute the chain from any chosen starting row and alert on the first mismatch. For now, verification is on-demand via `/api/audit/verify` (admin-only).

### 2.4 PII redaction

Logs and audit metadata are scrubbed before persistence:

- **IP addresses**: last octet zeroed (`192.168.1.100` → `192.168.1.0`). Source: `audit.service.ts:redactIp`.
- **User agents**: SHA-256 hashed, truncated to 16 hex chars. Source: `audit.service.ts:hashUserAgent`.
- **Sensitive metadata keys**: any key matching `/password|secret|token|apiKey|api_key|cookie|authorization/i` is replaced with `[REDACTED]` recursively. Source: `audit.service.ts:redactSensitive`.
- **Sentry events**: cookies dropped entirely, request headers redacted (Authorization, Cookie, X-CSRF-Token, X-API-Key, etc.), absolute filesystem paths stripped from stack frames. Source: `src/server.ts` Sentry `beforeSend` hook.
- **Application logs**: Pino is invoked with structured fields; the developer is responsible for not passing PII into log fields. The encryption module's tests cover the audit redaction module to lock the regex in place.

## 3. Where Logs Live

| Stream                    | Storage                             | Retention                                                                |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| Application stdout (Pino) | Fly.io log stream + Vector tail     | ~30 days (Fly default)                                                   |
| Audit log                 | `audit_logs` table                  | 1 year (`DATA_RETENTION.AUDIT_LOGS_DAYS` in `src/lib/data-retention.ts`) |
| Sentry events             | Sentry SaaS                         | 90 days (Sentry default)                                                 |
| Database logs             | PostgreSQL log files on Fly machine | Lifetime of the machine                                                  |
| BullMQ failed jobs        | Redis (`bull:<queue>:failed:*`)     | Until `removeOnFail.count` (5000) is exceeded                            |

## 4. Monitoring and Alerting

### 4.1 Sentry alerts

Configured alert rules (configured in the Sentry web console):

| Alert                                      | Condition                              | Severity | Destination         |
| ------------------------------------------ | -------------------------------------- | -------- | ------------------- |
| New unique error in production             | First-seen event                       | P3       | Email               |
| Error rate spike                           | Rate ≥1% over 5min, baseline last 24h  | P2       | Slack + Email       |
| High p95 latency                           | p95 ≥2s over 5min                      | P2       | Slack               |
| Auth failure spike (potential brute-force) | `auth.login.failure` rate ≥5x baseline | P2       | Slack + Email       |
| Database error                             | Any `PrismaClientInitializationError`  | P1       | Slack + Email + SMS |
| Worker job failures                        | Any BullMQ job permanently failed      | P2       | Slack               |

(NOTE: as of 2026-04-09 the Sentry alert rules are configured manually in the Sentry web console; we have NOT automated their provisioning. Reconfigure in the Sentry UI if the project is recreated.)

### 4.2 Health checks

The deploy pipeline gates on:

- `/api/health/live` returning 200 (basic liveness)
- `/api/health/ready` returning 200 (DB + Redis reachable)

The full `/api/health` endpoint reports:

- Database (with latency_ms)
- Redis (with latency_ms)
- ERPNext (with latency_ms)
- Memory utilization
- Disk utilization

Fly.io's load balancer hits `/api/health/live` every 15s and `/api/health/ready` every 30s. A machine that fails 3 consecutive checks is marked unhealthy and traffic is diverted.

### 4.3 SLO tracking

The application tracks SLO metrics via `src/middleware/slo-tracking.ts`. Current targets:

| SLO                            | Target              |
| ------------------------------ | ------------------- |
| API availability (5xx rate)    | ≥99.5% over 30 days |
| API p95 latency                | <500ms              |
| Background worker success rate | ≥99% over 7 days    |

## 5. Access to Logs

| Log type                | Who can read           | How                                                |
| ----------------------- | ---------------------- | -------------------------------------------------- |
| Application logs (Pino) | All engineers          | `flyctl logs --app westbridge-api`                 |
| Audit log (per-tenant)  | Account owner + admin  | `/api/audit` endpoint, `/api/audit/export` for CSV |
| Audit log (system-wide) | CISO only              | Direct database query via `flyctl ssh console`     |
| Sentry events           | All engineers          | Sentry web console (MFA required)                  |
| Database logs           | Engineering Lead, CISO | `flyctl ssh console -a westbridge-db`              |

Customer admin export of their audit log is delivered as CSV with formula injection protection (single-quote prefix on cells starting with `=`, `+`, `-`, `@`, `\t`, `\r`) — see `audit.service.ts:rowToCsv` and the corresponding tests.

## 6. Retention

| Data                     | Retention                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| Audit logs               | 365 days (`DATA_RETENTION.AUDIT_LOGS_DAYS`). After this, the daily cleanup worker deletes older entries.  |
| Sessions                 | Until expiry (30 days sliding window) OR explicit revoke. Cleanup worker deletes expired sessions hourly. |
| Trial accounts (cleanup) | Per Privacy Policy: 30 days after soft-delete, hard-delete via `purge-deleted-accounts` worker            |
| BullMQ completed jobs    | 1000 most recent per queue (`removeOnComplete: { count: 1000 }`)                                          |
| BullMQ failed jobs       | 5000 most recent per queue (`removeOnFail: { count: 5000 }`)                                              |
| Backup objects           | 7 days for daily snapshots, configurable on the Tigris bucket                                             |

## 7. Tamper-Evidence Verification

`src/lib/services/__tests__/audit.service.test.ts` covers:

- Hash chain consistency (each row's `_hash` matches recomputation)
- Sensitive metadata redaction (recursive)
- IP address redaction
- User agent hashing
- CSV formula injection neutralization
- Failure-on-DB-error (does not throw)

## 8. Related

- Information Security Policy (`information-security-policy.md`)
- Data Classification Policy (`data-classification-policy.md`)
- Incident Response Runbook (`../runbooks/incident-response.md`)
