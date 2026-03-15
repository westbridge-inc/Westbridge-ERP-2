# Rollback Runbook

**Document ID:** RB-001
**Version:** 1.0
**Effective Date:** 2026-03-15
**Last Reviewed:** 2026-03-15
**Next Review:** 2027-03-15
**Owner:** DevOps Team Lead
**Classification:** Internal

> SOC 2 Trust Service Criteria: CC7.5, CC8.1

---

## 1. Purpose

This runbook provides step-by-step procedures for rolling back the Westbridge ERP platform to a known-good state when a deployment causes a service disruption or introduces a critical defect. Rollback is the **default first response** for any deployment-related P0/P1 incident — rollback first, investigate second.

## 2. Decision Criteria

Initiate a rollback when any of the following conditions are met within 60 minutes of a deployment:

- Health endpoint (`/api/health`) returns non-200 status.
- Error rate in Sentry exceeds 5x baseline.
- API latency (p95) exceeds 5 seconds.
- Authentication or authorization failures spike.
- Database migration causes application errors.
- Customer-reported issues directly correlated with the deployment.

**Decision authority:** On-call engineer may rollback without additional approval. Notify the team in Slack #incidents after initiating.

## 3. Railway Rollback

### 3.1 Via Dashboard

1. Navigate to the Westbridge project in the Railway dashboard.
2. Select the production service.
3. Go to **Deployments** tab.
4. Find the last known-good deployment.
5. Click the three-dot menu and select **Rollback**.
6. Confirm the rollback.

### 3.2 Via CLI

```bash
# List recent deployments
railway deployments list

# Rollback to a specific deployment
railway rollback <deployment-id>

# Verify
railway logs --latest
curl https://<railway-domain>/api/health
```

### 3.3 Verification

- Health endpoint returns `200 OK` with all subsystem checks passing.
- Sentry error rate returns to pre-deployment baseline.
- Spot-check critical API endpoints (auth, team, invoices).

## 4. Fly.io Rollback

### 4.1 Identify Previous Good Release

```bash
# List recent releases
fly releases

# Output example:
# VERSION   STATUS    DESCRIPTION          DATE
# v42       active    Deploy image abc123  2026-03-15T10:00:00Z  ← BAD
# v41       succeeded Deploy image def456  2026-03-14T14:00:00Z  ← GOOD
```

### 4.2 Execute Rollback

```bash
# Deploy the previous known-good image
fly deploy --image <previous-image-ref>

# Monitor the rollback deployment
fly monitor

# Alternative: if you know the exact release version
fly releases rollback v41
```

### 4.3 Verification

```bash
# Check application status
fly status

# Verify health endpoint
curl https://westbridge-api.fly.dev/api/health

# Check logs for errors
fly logs --no-tail | head -50

# Verify machine health
fly machine list
```

## 5. AWS ECS Rollback

### 5.1 Identify Previous Task Definition

```bash
# List recent task definition revisions
aws ecs list-task-definitions \
  --family-prefix westbridge-api \
  --sort DESC \
  --max-items 5

# Describe current service to see active task definition
aws ecs describe-services \
  --cluster westbridge \
  --services westbridge-api \
  --query 'services[0].taskDefinition'
```

### 5.2 Execute Rollback

```bash
# Update service to previous task definition revision
aws ecs update-service \
  --cluster westbridge \
  --service westbridge-api \
  --task-definition westbridge-api:<previous-revision-number>

# Monitor rollback
aws ecs describe-services \
  --cluster westbridge \
  --services westbridge-api \
  --query 'services[0].deployments'

# Wait for deployment to stabilize
aws ecs wait services-stable \
  --cluster westbridge \
  --services westbridge-api
```

### 5.3 Verification

```bash
# Check service events for healthy targets
aws ecs describe-services \
  --cluster westbridge \
  --services westbridge-api \
  --query 'services[0].events[:5]'

# Verify via ALB health check
curl https://<alb-domain>/api/health

# Check CloudWatch logs for errors
aws logs tail /ecs/westbridge-api --since 10m
```

## 6. Prisma Database Migration Rollback

Database migration rollbacks require extra caution. Data loss may occur if a migration added columns that have since received data.

### 6.1 Assess the Migration

Before rolling back, determine:

1. **Is the migration additive?** (new tables, new columns, new indexes) — These are generally safe to leave in place. The previous application version will simply ignore them.
2. **Is the migration destructive?** (dropped columns, renamed tables, altered types) — Rollback is critical and may require data restoration.
3. **Has data been written to new structures?** — If yes, plan for data preservation.

### 6.2 Rollback an Additive Migration

If the migration only added new structures, you may not need to roll it back at all. Simply rollback the application code (Sections 3-5) and the old code will ignore the new columns/tables.

If cleanup is desired after stabilization:

```bash
# Mark the migration as rolled back in Prisma's migration table
npx prisma migrate resolve --rolled-back <migration-name>

# Manually drop the added structures (after confirming no data dependency)
# Connect to the database and execute:
psql $DATABASE_URL -c "DROP TABLE IF EXISTS <new_table>;"
# or
psql $DATABASE_URL -c "ALTER TABLE <table> DROP COLUMN IF EXISTS <new_column>;"
```

### 6.3 Rollback a Destructive Migration

If the migration dropped or altered existing structures:

1. **Stop the application** to prevent further writes:

   ```bash
   fly scale count 0  # Fly.io
   # or
   aws ecs update-service --cluster westbridge --service westbridge-api --desired-count 0
   ```

2. **Restore database from backup** (see `docs/runbooks/database-backup.md`):

   ```bash
   # Point-in-time recovery to just before the migration
   aws rds restore-db-instance-to-point-in-time \
     --source-db-instance-identifier westbridge-db \
     --target-db-instance-identifier westbridge-db-restored \
     --restore-time "<timestamp-before-migration>"
   ```

3. **Update connection string** to point to the restored database.

4. **Deploy previous application version** (Sections 3-5).

5. **Verify data integrity:**

   ```bash
   # Check migration state
   npx prisma migrate status

   # Verify row counts for critical tables
   psql $DATABASE_URL -c "SELECT 'users' as tbl, count(*) FROM users
     UNION ALL SELECT 'accounts', count(*) FROM accounts
     UNION ALL SELECT 'invoices', count(*) FROM invoices;"
   ```

6. **Restart the application:**
   ```bash
   fly scale count 2  # Fly.io
   ```

### 6.4 Prevention

To minimize destructive migration risks:

- **Two-phase migrations:** Phase 1 adds new structures, deploys code that writes to both old and new. Phase 2 (after verification) removes old structures.
- **Always test migrations** against a production-like dataset in staging.
- **Backup before migration:** Take a manual snapshot immediately before running `prisma migrate deploy` in production.

## 7. Feature Flag Emergency Disable

If the issue is isolated to a specific feature behind a feature flag:

### 7.1 Via Environment Variable

```bash
# Fly.io — disable feature flag
fly secrets set FEATURE_<FLAG_NAME>=false

# Railway — update environment variable in dashboard or CLI
railway variables set FEATURE_<FLAG_NAME>=false

# AWS ECS — update SSM parameter or Secrets Manager value
aws ssm put-parameter \
  --name "/westbridge/production/FEATURE_<FLAG_NAME>" \
  --value "false" \
  --overwrite
# Then force a new deployment to pick up the change
aws ecs update-service --cluster westbridge --service westbridge-api --force-new-deployment
```

### 7.2 Via Configuration Service

If using a feature flag service (e.g., LaunchDarkly, Unleash):

1. Log in to the feature flag dashboard.
2. Navigate to the flag controlling the problematic feature.
3. **Kill switch:** Toggle the flag to OFF for all environments.
4. Verify the feature is disabled by testing the affected endpoint.

### 7.3 Verification

- Test the specific feature to confirm it is disabled.
- Confirm the rest of the application functions normally.
- Monitor error rates to ensure they return to baseline.

## 8. DNS Failover

If the primary hosting provider is experiencing a complete outage and cannot recover within RTO:

### 8.1 Prerequisites

- Secondary deployment in an alternate provider (e.g., if primary is Fly.io, secondary is AWS ECS, or vice versa).
- Database replica accessible from the secondary provider.
- DNS managed via Cloudflare or Route 53 with low TTL (60-300 seconds).

### 8.2 Failover Procedure

```bash
# Cloudflare — update DNS A/CNAME record to point to secondary
# Via Cloudflare dashboard: DNS → Edit record → Change target to secondary IP/domain

# Route 53 — update record set
aws route53 change-resource-record-sets \
  --hosted-zone-id <zone-id> \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.westbridge.co",
        "Type": "CNAME",
        "TTL": 60,
        "ResourceRecords": [{"Value": "<secondary-domain>"}]
      }
    }]
  }'
```

### 8.3 Post-Failover

1. Wait for DNS propagation (TTL-dependent, up to 5 minutes with low TTL).
2. Verify traffic is flowing to secondary: `dig api.westbridge.co` should show secondary IP.
3. Monitor secondary for health and capacity.
4. When primary recovers, plan a controlled failback during a maintenance window.

### 8.4 Failback Procedure

1. Ensure primary is healthy and fully operational.
2. Sync any data written to secondary back to primary (if applicable).
3. Update DNS to point back to primary.
4. Monitor for 30 minutes to confirm stability.

## 9. Post-Rollback Checklist

After any rollback, complete the following:

- [ ] Health endpoint returns `200 OK`.
- [ ] Sentry error rate at or below pre-deployment baseline.
- [ ] API latency (p95) at or below pre-deployment baseline.
- [ ] Authentication flow tested (login, session validation).
- [ ] Critical business endpoints tested (team, invoices, inventory).
- [ ] Database migration state is consistent (`npx prisma migrate status`).
- [ ] Monitoring dashboards reviewed — no anomalies.
- [ ] Slack #incidents updated with rollback confirmation.
- [ ] Status page updated (if public-facing impact occurred).
- [ ] Incident timeline documented (who did what, when).
- [ ] Follow-up ticket created to investigate root cause and re-deploy safely.

## 10. Related Documents

| Document                    | Location                                    |
| --------------------------- | ------------------------------------------- |
| Incident Response Runbook   | `docs/runbooks/incident-response.md`        |
| Database Backup Runbook     | `docs/runbooks/database-backup.md`          |
| Change Management Policy    | `docs/policies/change-management.md`        |
| Business Continuity Plan    | `docs/policies/business-continuity-plan.md` |
| Deployment Runbook (AWS)    | `docs/runbooks/deploy-aws.md`               |
| Deployment Runbook (Fly.io) | `docs/runbooks/deploy-fly.md`               |

---

_This document is classified as Internal. Distribute to all engineering and on-call personnel._
