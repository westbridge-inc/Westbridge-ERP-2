# Business Continuity Plan

**Document ID:** BCP-001
**Version:** 1.0
**Effective Date:** 2026-03-15
**Last Reviewed:** 2026-03-15
**Next Review:** 2027-03-15
**Owner:** Chief Information Security Officer (CISO)
**Classification:** Confidential

> SOC 2 Trust Service Criteria: A1.2, A1.3

---

## 1. Purpose

This Business Continuity Plan (BCP) ensures that Westbridge Inc. can maintain critical business operations and recover essential services within defined timeframes following a disruptive event. It establishes recovery time objectives (RTO), recovery point objectives (RPO), and documented procedures for each critical system component of the Westbridge ERP platform.

This plan satisfies SOC 2 Availability criteria A1.2 (environmental protections, including backup and recovery) and A1.3 (recovery plan testing).

## 2. Scope

This plan covers the following production systems and services:

- Westbridge ERP API (Node.js / Express / Hono application)
- PostgreSQL database (primary data store)
- Redis (session store, caching, rate limiting)
- ERPNext integration (inventory, accounting, and business process engine)
- Payment processing (PowerTranz gateway integration)
- Supporting infrastructure (DNS, CDN, monitoring, email delivery via Resend)

## 3. Business Impact Analysis

### 3.1 Critical System Classification

| System                  | Business Function                                 | Impact of Outage                                                                                                                | Max Tolerable Downtime |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **API Server**          | All client operations, authentication, RBAC       | Complete service unavailable. All users unable to access ERP. Revenue impact from inability to process transactions.            | 1 hour                 |
| **PostgreSQL Database** | Persistent storage for all business data          | Data inaccessible. API non-functional even if running. Potential data loss if corruption occurs.                                | 1 hour                 |
| **Redis**               | Session management, caching, rate limiting        | Users logged out. Degraded performance. Rate limiting disabled (fail-closed mode prevents abuse).                               | 30 minutes             |
| **ERPNext**             | Inventory, accounting, purchase orders, invoicing | ERP-dependent operations fail. API can still serve cached data and non-ERP endpoints. Accounting and inventory updates delayed. | 4 hours                |
| **Payment Processing**  | Customer payments via PowerTranz                  | Unable to process new payments. Existing payment data intact. Revenue impact for time-sensitive transactions.                   | 2 hours                |

### 3.2 Dependencies and Cascading Failures

```
DNS (Route 53 / Cloudflare)
 └── Load Balancer (ALB / Fly.io Proxy)
      └── API Server (ECS Fargate / Fly.io Machines)
           ├── PostgreSQL (RDS / Fly Postgres)  [CRITICAL]
           ├── Redis (ElastiCache / Upstash)     [HIGH]
           ├── ERPNext (External service)         [MEDIUM]
           ├── PowerTranz (External gateway)      [MEDIUM]
           ├── Resend (Email delivery)            [LOW]
           ├── Sentry (Error tracking)            [LOW]
           └── PostHog (Analytics)                [LOW]
```

## 4. Recovery Objectives

| System                             | RTO (Recovery Time Objective) | RPO (Recovery Point Objective)             | Priority |
| ---------------------------------- | ----------------------------- | ------------------------------------------ | -------- |
| **API Server**                     | 1 hour                        | 15 minutes                                 | P0       |
| **PostgreSQL Database**            | 1 hour                        | 5 minutes                                  | P0       |
| **Redis**                          | 30 minutes                    | 0 (ephemeral — session re-auth acceptable) | P1       |
| **ERPNext**                        | 4 hours                       | 1 hour                                     | P2       |
| **Payment Processing**             | 2 hours                       | 0 (stateless gateway)                      | P1       |
| **DNS**                            | 15 minutes (TTL-dependent)    | N/A                                        | P0       |
| **Monitoring (Sentry/Prometheus)** | 4 hours                       | 1 hour                                     | P2       |

## 5. Recovery Procedures

### 5.1 API Server Recovery

**Scenario:** API instances unresponsive or crash-looping.

**Fly.io environment:**

1. Check service status: `fly status`
2. Review logs for root cause: `fly logs`
3. If bad deployment — rollback: `fly deploy --image <previous-image-ref>` (see `docs/runbooks/rollback.md`)
4. If infrastructure issue — restart machines: `fly machine restart`
5. If regional outage — Fly.io automatically migrates to healthy regions (multi-region configured in `fly.toml`)
6. Scale up if capacity issue: `fly scale count <N>`

**AWS ECS environment:**

1. Check ECS service events: `aws ecs describe-services --cluster westbridge --services westbridge-api`
2. Review CloudWatch logs for root cause
3. If bad deployment — rollback to previous task definition revision (see `docs/runbooks/deploy-aws.md`)
4. If capacity issue — ECS auto-scaling adjusts based on CPU threshold (70%)
5. If AZ failure — tasks automatically rescheduled to healthy AZs

**Verification:**

- `curl https://<api-domain>/api/health` returns `200 OK`
- Sentry error rate returns to baseline
- Prometheus metrics confirm normal latency

### 5.2 PostgreSQL Database Recovery

**Scenario:** Database corruption, accidental data deletion, or complete instance failure.

**Point-in-Time Recovery (PITR):**

1. Identify the target recovery timestamp (before the incident)
2. AWS RDS: Restore to a point in time via AWS Console or CLI:
   ```bash
   aws rds restore-db-instance-to-point-in-time \
     --source-db-instance-identifier westbridge-db \
     --target-db-instance-identifier westbridge-db-restored \
     --restore-time "2026-03-15T10:30:00Z"
   ```
3. Fly Postgres: Restore from WAL archive:
   ```bash
   fly postgres barman restore westbridge-db --target-time "2026-03-15T10:30:00Z"
   ```
4. Update connection string to point to restored instance
5. Run data integrity checks
6. Verify via application health endpoint and spot-check business data

**Full Restore from Backup:**

1. Identify most recent clean backup from daily full backups
2. Restore:
   ```bash
   pg_restore --clean --if-exists -d westbridge_production /backups/daily/latest.dump
   ```
3. Apply WAL logs to bring database to most recent consistent state
4. See `docs/runbooks/database-backup.md` for detailed procedures

**Verification:**

- Application health endpoint returns `200 OK` with database connectivity confirmed
- Row counts for critical tables match expected values
- Recent audit log entries are present
- Run `npx prisma migrate status` to confirm migration state is current

### 5.3 Redis Recovery

**Scenario:** Redis unavailable or data flushed.

Redis is treated as ephemeral. No data recovery is required — the system is designed to tolerate Redis loss gracefully:

1. If Redis instance is unhealthy, restart or replace:
   - Fly.io: `fly redis reset westbridge-redis` or create new instance
   - AWS ElastiCache: Failover to replica or create new cluster
2. Application rate limiting fails closed (secure default — no bypass possible)
3. Users will need to re-authenticate (sessions stored in Redis are lost)
4. Cache will rebuild automatically on subsequent API requests

**RTO:** 30 minutes
**RPO:** 0 — data loss is acceptable by design. Session re-authentication is the expected recovery path.

### 5.4 ERPNext Recovery

**Scenario:** ERPNext instance unreachable or returning errors.

1. Check ERPNext health: `curl https://<erpnext-url>/api/method/ping`
2. If self-hosted — restart ERPNext services:
   ```bash
   bench restart
   bench doctor  # diagnose issues
   ```
3. If using ERPNext Docker — restart containers:
   ```bash
   docker compose -f erpnext-docker/docker-compose.yml restart
   ```
4. If prolonged outage — the Westbridge API operates in degraded mode:
   - Authentication, session management, RBAC, and non-ERP endpoints remain functional
   - ERP-dependent endpoints (inventory, accounting, purchase orders) return `503 Service Unavailable`
   - Queued operations are retried when ERPNext recovers
5. If data loss — restore ERPNext from most recent MariaDB backup

### 5.5 Payment Processing Recovery

**Scenario:** PowerTranz gateway unreachable.

1. Confirm outage is on PowerTranz side (not network/firewall change on our end)
2. Check PowerTranz status page and contact their support
3. Enable maintenance banner for payment features in the frontend
4. Payment endpoints return `503 Service Unavailable` with retry guidance
5. If extended outage (> 2 hours):
   - Notify affected customers via email (Resend)
   - Log all attempted transactions for reconciliation after recovery
6. When gateway recovers — process any queued/retried transactions
7. Reconcile transaction records between Westbridge and PowerTranz

## 6. Communication Plan

### 6.1 Internal Communication

| Severity          | Channel                       | Frequency                   | Audience                        |
| ----------------- | ----------------------------- | --------------------------- | ------------------------------- |
| P0 (Service down) | Slack #incidents + phone tree | Every 30 min until resolved | All engineering, CTO, CISO, CEO |
| P1 (Degraded)     | Slack #incidents              | Every 1 hour until resolved | Engineering, CTO, CISO          |
| P2 (Minor impact) | Slack #engineering            | As needed                   | Engineering team                |
| P3 (No impact)    | GitHub Issue                  | Post-resolution             | Relevant engineers              |

### 6.2 External Communication

| Trigger                 | Channel                              | Owner          | Timeline                                  |
| ----------------------- | ------------------------------------ | -------------- | ----------------------------------------- |
| Service outage > 15 min | Status page update                   | DevOps on-call | Within 15 minutes                         |
| Outage > 1 hour         | Email to affected customers          | CTO            | Within 1 hour                             |
| Data breach             | Email to affected users + regulators | CISO + Legal   | Within 72 hours (per GDPR/applicable law) |
| Outage resolved         | Status page + email follow-up        | DevOps on-call | Within 1 hour of resolution               |

### 6.3 Escalation Contacts

| Role             | Primary         | Backup            | Contact Method    |
| ---------------- | --------------- | ----------------- | ----------------- |
| On-Call Engineer | Rotating weekly | Secondary on-call | PagerDuty / Phone |
| Engineering Lead | ****\_\_****    | ****\_\_****      | Phone / Slack     |
| CTO              | ****\_\_****    | CISO              | Phone / Slack     |
| CISO             | ****\_\_****    | CTO               | Phone / Slack     |
| CEO              | ****\_\_****    | COO               | Phone             |

## 7. Disaster Recovery Roles

| Role                        | Responsibilities                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Incident Commander (IC)** | Owns the incident. Makes decisions on recovery strategy. Coordinates communication. Declares incident resolved. |
| **Technical Lead**          | Leads hands-on recovery. Directs engineering resources. Validates recovery success.                             |
| **Communications Lead**     | Manages status page, customer emails, and internal Slack updates. Shields technical team from interruptions.    |
| **Scribe**                  | Documents timeline, decisions, and actions taken. Preserves evidence for postmortem and audit.                  |
| **Executive Sponsor**       | Provides authority for resource allocation, vendor escalation, and customer communication.                      |

## 8. Testing and Exercises

### 8.1 Quarterly Testing Schedule

| Quarter | Exercise Type            | Systems Tested                             | Participants        |
| ------- | ------------------------ | ------------------------------------------ | ------------------- |
| Q1      | Database restore drill   | PostgreSQL PITR, full restore              | DevOps, DBA         |
| Q2      | Tabletop exercise        | Full BCP scenario walkthrough              | All roles above     |
| Q3      | Failover drill           | API rollback, Redis recovery, DNS failover | DevOps, Engineering |
| Q4      | Full disaster simulation | Multi-system failure scenario              | All roles above     |

### 8.2 Testing Procedures

1. **Notification:** BCP test announced 1 week in advance (except for unannounced drills, limited to 1/year).
2. **Execution:** Test conducted in a staging environment or isolated production replica.
3. **Measurement:** Actual RTO/RPO measured against targets. Deviations documented.
4. **Documentation:** Test results, findings, and corrective actions recorded in `docs/compliance/bcp-test-results/`.
5. **Review:** Results reviewed by CISO and executive leadership. BCP updated if targets not met.

### 8.3 Success Criteria

| Metric                        | Target                                    |
| ----------------------------- | ----------------------------------------- |
| API recovery within RTO       | < 1 hour                                  |
| Database recovery within RTO  | < 1 hour                                  |
| Database data loss within RPO | < 5 minutes                               |
| All stakeholders notified     | Within 15 minutes of incident declaration |
| Postmortem completed          | Within 48 hours                           |

## 9. Plan Maintenance

- This plan is reviewed and updated **quarterly** or immediately after:
  - Any activation of the BCP.
  - Significant infrastructure changes (new cloud provider, new critical dependency).
  - Results of BCP testing that reveal gaps.
  - Organizational changes that affect roles or contact information.
- All revisions tracked in version control (git).
- Contact information verified monthly by the DevOps team lead.

## 10. Related Documents

| Document                    | Location                                       |
| --------------------------- | ---------------------------------------------- |
| Information Security Policy | `docs/policies/information-security-policy.md` |
| Incident Response Runbook   | `docs/runbooks/incident-response.md`           |
| Rollback Runbook            | `docs/runbooks/rollback.md`                    |
| Database Backup Runbook     | `docs/runbooks/database-backup.md`             |
| Deployment Runbook (AWS)    | `docs/runbooks/deploy-aws.md`                  |
| Deployment Runbook (Fly.io) | `docs/runbooks/deploy-fly.md`                  |

## 11. Approval

| Role | Name                       | Date                       |
| ---- | -------------------------- | -------------------------- |
| CISO | ************\_************ | \_**\_/\_\_**/**\_\_\_\_** |
| CTO  | ************\_************ | \_**\_/\_\_**/**\_\_\_\_** |
| CEO  | ************\_************ | \_**\_/\_\_**/**\_\_\_\_** |

---

_This document is classified as Confidential. Distribution restricted to Westbridge personnel with a need to know and authorized auditors._
