# Database Backup Runbook

**Document ID:** DB-001
**Version:** 1.0
**Effective Date:** 2026-03-15
**Last Reviewed:** 2026-03-15
**Next Review:** 2027-03-15
**Owner:** DevOps Team Lead
**Classification:** Confidential

> SOC 2 Trust Service Criteria: A1.2

---

## 1. Purpose

This runbook documents the backup and recovery procedures for the Westbridge ERP PostgreSQL database. It ensures that data can be recovered within the defined RPO (5 minutes) and RTO (1 hour) targets established in the Business Continuity Plan. It satisfies SOC 2 Availability criterion A1.2 regarding environmental protections, backup, and recovery mechanisms.

## 2. Backup Strategy Overview

| Backup Type                     | Frequency                  | Retention       | Storage                | Encryption       |
| ------------------------------- | -------------------------- | --------------- | ---------------------- | ---------------- |
| **Daily Full Backup**           | Daily at 02:00 UTC         | 30 days         | S3 (cross-region)      | AES-256 (SSE-S3) |
| **Hourly WAL Archiving**        | Continuous (every segment) | 7 days          | S3 (same region)       | AES-256 (SSE-S3) |
| **Monthly Archival**            | 1st of each month          | 12 months       | S3 Glacier             | AES-256 (SSE-S3) |
| **Pre-Migration Snapshot**      | Before each migration      | 7 days          | RDS Snapshot / pg_dump | AES-256          |
| **Weekly Restore Verification** | Weekly (Wednesday)         | N/A (test only) | Staging environment    | N/A              |

### 2.1 Architecture

```
PostgreSQL Primary (RDS / Fly Postgres)
  ├── Continuous WAL archiving → S3 (hourly segments)
  ├── Daily pg_basebackup → S3 (full backup)
  ├── Synchronous replication → Read replica (same region)
  └── Asynchronous replication → Cross-region replica (DR)

S3 Backup Bucket
  ├── /daily/       — 30 days retention
  ├── /wal/         — 7 days retention
  ├── /monthly/     — 12 months retention (lifecycle → Glacier after 30 days)
  └── /pre-migrate/ — 7 days retention
```

## 3. Daily Full Backup

### 3.1 Automated Backup (AWS RDS)

AWS RDS automated backups are enabled with the following configuration:

- **Backup window:** 02:00-03:00 UTC (low-traffic period)
- **Retention period:** 30 days
- **Backup storage:** AWS-managed, encrypted with AES-256 (AWS KMS)
- **Multi-AZ:** Backup taken from standby instance to avoid performance impact on primary

Configuration verification:

```bash
aws rds describe-db-instances \
  --db-instance-identifier westbridge-db \
  --query 'DBInstances[0].{BackupRetention:BackupRetentionPeriod,BackupWindow:PreferredBackupWindow,Encrypted:StorageEncrypted,MultiAZ:MultiAZ}'
```

Expected output:

```json
{
  "BackupRetention": 30,
  "BackupWindow": "02:00-03:00",
  "Encrypted": true,
  "MultiAZ": true
}
```

### 3.2 Automated Backup (Fly Postgres)

Fly Postgres uses barman for automated backups:

```bash
# Verify backup status
fly postgres barman check westbridge-db

# List available backups
fly postgres barman list-backup westbridge-db
```

### 3.3 Manual Full Backup (pg_dump)

For ad-hoc full backups or pre-migration snapshots:

```bash
# Set connection variables
export PGHOST="<db-host>"
export PGPORT="5432"
export PGDATABASE="westbridge_production"
export PGUSER="westbridge_admin"
# PGPASSWORD sourced from secrets manager, never hardcoded

# Create compressed custom-format dump
pg_dump \
  --format=custom \
  --compress=9 \
  --verbose \
  --file="/tmp/westbridge-$(date +%Y%m%d-%H%M%S).dump" \
  westbridge_production

# Upload to S3 with server-side encryption
aws s3 cp \
  "/tmp/westbridge-$(date +%Y%m%d-%H%M%S).dump" \
  "s3://westbridge-backups/daily/westbridge-$(date +%Y%m%d-%H%M%S).dump" \
  --sse AES256

# Verify upload
aws s3 ls "s3://westbridge-backups/daily/" --human-readable | tail -3

# Clean up local file
rm "/tmp/westbridge-$(date +%Y%m%d-%H%M%S).dump"
```

### 3.4 Pre-Migration Snapshot

Before every production database migration:

```bash
# Create RDS snapshot
aws rds create-db-snapshot \
  --db-instance-identifier westbridge-db \
  --db-snapshot-identifier "pre-migrate-$(date +%Y%m%d-%H%M%S)"

# Wait for snapshot to complete
aws rds wait db-snapshot-available \
  --db-snapshot-identifier "pre-migrate-$(date +%Y%m%d-%H%M%S)"

# Verify
aws rds describe-db-snapshots \
  --db-snapshot-identifier "pre-migrate-$(date +%Y%m%d-%H%M%S)" \
  --query 'DBSnapshots[0].{Status:Status,Size:AllocatedStorage,Encrypted:Encrypted}'
```

## 4. Hourly WAL Archiving

Write-Ahead Log (WAL) archiving provides continuous backup between daily full snapshots, enabling Point-in-Time Recovery (PITR) with a granularity of seconds.

### 4.1 Configuration (AWS RDS)

WAL archiving is automatically enabled when RDS automated backups are configured. No additional setup required. RDS retains WAL segments for the duration of the backup retention period (30 days).

### 4.2 Configuration (Self-Hosted / Fly Postgres)

PostgreSQL WAL archiving configuration in `postgresql.conf`:

```ini
wal_level = replica
archive_mode = on
archive_command = 'aws s3 cp %p s3://westbridge-backups/wal/%f --sse AES256'
archive_timeout = 3600  # Force archive every hour even if segment not full
```

### 4.3 Monitoring

WAL archiving is monitored via:

- **Prometheus metric:** `pg_stat_archiver_archived_count` — should increment regularly.
- **Alert:** If `pg_stat_archiver_last_archived_wal` has not changed in > 2 hours, a P2 alert fires.
- **Failed archive alert:** `pg_stat_archiver_failed_count` incrementing triggers a P1 alert.

## 5. Point-in-Time Recovery (PITR)

PITR allows restoring the database to any point within the WAL retention window (up to 30 days for RDS).

### 5.1 AWS RDS PITR

```bash
# Determine the latest restorable time
aws rds describe-db-instances \
  --db-instance-identifier westbridge-db \
  --query 'DBInstances[0].LatestRestorableTime'

# Restore to a specific point in time
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier westbridge-db \
  --target-db-instance-identifier westbridge-db-pitr \
  --restore-time "2026-03-15T10:30:00Z" \
  --db-instance-class db.t3.medium \
  --vpc-security-group-ids sg-xxxxxxxx \
  --db-subnet-group-name westbridge-db-subnet

# Wait for restore to complete
aws rds wait db-instance-available \
  --db-instance-identifier westbridge-db-pitr

# Verify restored instance
psql -h <pitr-endpoint> -U westbridge_admin -d westbridge_production \
  -c "SELECT count(*) FROM users; SELECT max(created_at) FROM audit_logs;"
```

### 5.2 Fly Postgres PITR

```bash
# Restore to a specific point in time
fly postgres barman restore westbridge-db \
  --target-time "2026-03-15T10:30:00Z"

# Monitor restore progress
fly postgres barman status westbridge-db
```

### 5.3 Manual PITR (Self-Hosted)

```bash
# 1. Stop PostgreSQL
systemctl stop postgresql

# 2. Clear the data directory (back it up first if needed)
mv /var/lib/postgresql/16/main /var/lib/postgresql/16/main.bak

# 3. Restore the base backup
pg_basebackup_restore from latest daily backup before target time

# 4. Create recovery.signal and configure recovery target
cat > /var/lib/postgresql/16/main/postgresql.auto.conf << EOF
restore_command = 'aws s3 cp s3://westbridge-backups/wal/%f %p'
recovery_target_time = '2026-03-15T10:30:00Z'
recovery_target_action = 'promote'
EOF

touch /var/lib/postgresql/16/main/recovery.signal

# 5. Start PostgreSQL — it will replay WAL to the target time
systemctl start postgresql

# 6. Verify recovery
psql -c "SELECT pg_is_in_recovery();"  # Should return false after promotion
```

## 6. Cross-Region Replication

### 6.1 AWS RDS Cross-Region Read Replica

```bash
# Create cross-region read replica
aws rds create-db-instance-read-replica \
  --db-instance-identifier westbridge-db-dr \
  --source-db-instance-identifier arn:aws:rds:us-east-1:<account>:db:westbridge-db \
  --region us-west-2 \
  --db-instance-class db.t3.medium

# Monitor replication lag
aws cloudwatch get-metric-data \
  --metric-data-queries '[{
    "Id": "replag",
    "MetricStat": {
      "Metric": {
        "Namespace": "AWS/RDS",
        "MetricName": "ReplicaLag",
        "Dimensions": [{"Name": "DBInstanceIdentifier", "Value": "westbridge-db-dr"}]
      },
      "Period": 300,
      "Stat": "Average"
    }
  }]' \
  --start-time "$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)"
```

### 6.2 Promotion for Disaster Recovery

If the primary region is unavailable:

```bash
# Promote read replica to standalone instance
aws rds promote-read-replica \
  --db-instance-identifier westbridge-db-dr \
  --region us-west-2

# Wait for promotion
aws rds wait db-instance-available \
  --db-instance-identifier westbridge-db-dr \
  --region us-west-2

# Update application connection string to point to promoted instance
# Then perform DNS failover (see docs/runbooks/rollback.md, Section 8)
```

## 7. Encryption

All backups are encrypted using AES-256 at every stage:

| Layer                  | Encryption Method                       | Key Management                          |
| ---------------------- | --------------------------------------- | --------------------------------------- |
| **RDS Storage**        | AES-256 via AWS KMS                     | AWS-managed CMK or customer-managed CMK |
| **RDS Snapshots**      | Inherits RDS encryption                 | Same KMS key as source instance         |
| **S3 Backup Objects**  | SSE-S3 (AES-256)                        | AWS-managed keys                        |
| **S3 Monthly Archive** | SSE-S3 (AES-256)                        | Maintained through Glacier transition   |
| **In Transit**         | TLS 1.2+                                | Certificate-based (RDS CA bundle)       |
| **pg_dump Output**     | GPG encryption before upload (optional) | Team GPG key stored in secrets manager  |

### 7.1 Verification

```bash
# Verify RDS instance encryption
aws rds describe-db-instances \
  --db-instance-identifier westbridge-db \
  --query 'DBInstances[0].StorageEncrypted'
# Expected: true

# Verify S3 bucket encryption policy
aws s3api get-bucket-encryption \
  --bucket westbridge-backups
# Expected: AES256 or aws:kms

# Verify a specific backup object is encrypted
aws s3api head-object \
  --bucket westbridge-backups \
  --key "daily/westbridge-20260315-020000.dump" \
  --query 'ServerSideEncryption'
# Expected: AES256
```

## 8. Retention Policy

| Backup Type             | Retention Period | Deletion Method                         | Compliance Note                |
| ----------------------- | ---------------- | --------------------------------------- | ------------------------------ |
| Daily full backups      | 30 days          | S3 lifecycle rule (auto-delete)         | Meets SOC 2 A1.2               |
| Hourly WAL segments     | 7 days           | S3 lifecycle rule (auto-delete)         | Sufficient for PITR within RPO |
| Monthly archival        | 12 months        | S3 lifecycle rule (Glacier → delete)    | Regulatory and audit retention |
| Pre-migration snapshots | 7 days           | Manual cleanup after migration verified | Short-term safety net          |
| RDS automated backups   | 30 days          | RDS-managed (auto-delete)               | Matches daily backup retention |

### 8.1 S3 Lifecycle Configuration

```json
{
  "Rules": [
    {
      "ID": "daily-backup-retention",
      "Filter": { "Prefix": "daily/" },
      "Status": "Enabled",
      "Expiration": { "Days": 30 }
    },
    {
      "ID": "wal-retention",
      "Filter": { "Prefix": "wal/" },
      "Status": "Enabled",
      "Expiration": { "Days": 7 }
    },
    {
      "ID": "monthly-archive",
      "Filter": { "Prefix": "monthly/" },
      "Status": "Enabled",
      "Transitions": [{ "Days": 30, "StorageClass": "GLACIER" }],
      "Expiration": { "Days": 365 }
    },
    {
      "ID": "pre-migrate-cleanup",
      "Filter": { "Prefix": "pre-migrate/" },
      "Status": "Enabled",
      "Expiration": { "Days": 7 }
    }
  ]
}
```

## 9. Weekly Restore Verification

A weekly restore drill verifies that backups are valid and can be restored within the RTO.

### 9.1 Schedule

- **When:** Every Wednesday at 10:00 UTC
- **Environment:** Staging (isolated from production)
- **Responsible:** DevOps on-call engineer
- **Duration:** ~30 minutes

### 9.2 Procedure

```bash
# 1. Identify the latest daily backup
LATEST_BACKUP=$(aws s3 ls s3://westbridge-backups/daily/ | sort | tail -1 | awk '{print $4}')
echo "Restoring: $LATEST_BACKUP"

# 2. Download the backup
aws s3 cp "s3://westbridge-backups/daily/$LATEST_BACKUP" /tmp/restore-test.dump

# 3. Restore to staging database
pg_restore \
  --clean --if-exists \
  --no-owner \
  --dbname="$STAGING_DATABASE_URL" \
  /tmp/restore-test.dump

# 4. Verify data integrity
psql "$STAGING_DATABASE_URL" << 'SQL'
-- Check table counts
SELECT schemaname, relname, n_live_tup
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC
LIMIT 20;

-- Verify recent data exists (should have data from yesterday)
SELECT max(created_at) AS latest_record FROM audit_logs;
SELECT count(*) AS user_count FROM users;
SELECT count(*) AS account_count FROM accounts;

-- Verify migration state
SELECT * FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 5;
SQL

# 5. Record the result
echo "Restore test completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Backup file: $LATEST_BACKUP"
echo "Restore duration: [measure and record]"

# 6. Clean up
rm /tmp/restore-test.dump
```

### 9.3 Success Criteria

| Check                                                | Expected Result                             |
| ---------------------------------------------------- | ------------------------------------------- |
| Restore completes without errors                     | `pg_restore` exits with code 0              |
| Table row counts match production (within 24h delta) | Counts are consistent                       |
| Most recent audit log entry within 24 hours          | `max(created_at)` > now - 24h               |
| Prisma migration state current                       | All migrations show `finished_at` populated |
| Restore completes within RTO                         | < 1 hour                                    |

### 9.4 Failure Response

If a weekly restore verification fails:

1. Immediately notify the DevOps team lead and CISO.
2. Investigate root cause (corrupt backup, configuration change, schema mismatch).
3. Perform a manual backup and verify it can be restored.
4. If backups are confirmed broken, escalate to P1 and fix within 24 hours.
5. Document the failure and resolution in `docs/compliance/backup-test-results/`.

## 10. Monitoring and Alerting

| Metric / Check               | Threshold                         | Severity | Alert Channel                  |
| ---------------------------- | --------------------------------- | -------- | ------------------------------ |
| Daily backup age             | > 26 hours since last backup      | P1       | PagerDuty + Slack #alerts      |
| WAL archiving lag            | > 2 hours since last archived WAL | P2       | Slack #alerts                  |
| WAL archive failures         | `failed_count` incrementing       | P1       | PagerDuty + Slack #alerts      |
| Backup S3 bucket size        | Unexpected decrease (> 20%)       | P2       | Slack #alerts                  |
| Cross-region replication lag | > 30 minutes                      | P2       | Slack #alerts                  |
| Weekly restore test          | Failed or not run                 | P2       | Slack #alerts (Thursday check) |
| RDS storage space            | < 20% free                        | P2       | PagerDuty                      |
| RDS storage space            | < 10% free                        | P1       | PagerDuty                      |

## 11. Related Documents

| Document                  | Location                                    |
| ------------------------- | ------------------------------------------- |
| Business Continuity Plan  | `docs/policies/business-continuity-plan.md` |
| Rollback Runbook          | `docs/runbooks/rollback.md`                 |
| Incident Response Runbook | `docs/runbooks/incident-response.md`        |
| Deployment Runbook (AWS)  | `docs/runbooks/deploy-aws.md`               |

---

_This document is classified as Confidential. Contains infrastructure details — restrict distribution to authorized DevOps and engineering personnel._
