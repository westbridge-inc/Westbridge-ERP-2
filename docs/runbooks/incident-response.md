# Incident Response Runbook

**Document ID:** IR-001
**Version:** 1.0
**Effective Date:** 2026-03-15
**Last Reviewed:** 2026-03-15
**Next Review:** 2027-03-15
**Owner:** Chief Information Security Officer (CISO)
**Classification:** Internal

> SOC 2 Trust Service Criteria: CC7.3, CC7.4, CC7.5

---

## 1. Purpose

This runbook defines Westbridge's incident response process — from detection through resolution and postmortem. It ensures that security incidents and service disruptions are handled consistently, communicated effectively, and documented thoroughly to satisfy SOC 2 criteria CC7.3 (evaluation of identified events), CC7.4 (incident response), and CC7.5 (recovery from identified events).

## 2. Severity Levels

### P0 — Critical

**Definition:** Complete service outage or confirmed security breach affecting production data.

**Examples:**

- Westbridge ERP API completely unreachable.
- PostgreSQL database down or corrupted.
- Confirmed unauthorized access to customer data.
- Active exploitation of a security vulnerability.
- Payment processing system compromised.
- Data breach involving PII or Restricted data.

**Response Requirements:**

- All-hands engineering response.
- Incident Commander (IC) assigned immediately.
- Status page updated within 15 minutes.
- Customer communication within 1 hour.
- Executive leadership notified immediately.
- Resolution target: 1 hour.

### P1 — High

**Definition:** Major service degradation affecting a significant portion of users, or a confirmed security vulnerability with high likelihood of exploitation.

**Examples:**

- API response times > 10x normal (> 5 seconds).
- Authentication system partially failing (intermittent login failures).
- ERPNext integration down (inventory/accounting operations blocked).
- Critical security vulnerability discovered (CVSS >= 9.0) but not yet exploited.
- Database replication lag > 30 minutes.
- Rate limiting disabled or bypassed.

**Response Requirements:**

- On-call engineer responds within 15 minutes.
- IC assigned within 30 minutes.
- Status page updated within 30 minutes.
- Engineering Lead and CISO notified.
- Resolution target: 4 hours.

### P2 — Medium

**Definition:** Partial service degradation affecting a subset of functionality or users, or a moderate security concern.

**Examples:**

- Single non-critical API endpoint returning errors.
- Email delivery (Resend) delayed or failing.
- Elevated error rates in Sentry (> 2x baseline) for non-critical paths.
- Moderate security vulnerability (CVSS 4.0-8.9) with no evidence of exploitation.
- Monitoring/alerting system degraded.
- Performance degradation for specific tenants.

**Response Requirements:**

- On-call engineer responds within 1 hour.
- Tracked as GitHub Issue.
- Resolution target: 24 hours (next business day).

### P3 — Low

**Definition:** Minor issue with negligible user impact, or informational security finding.

**Examples:**

- Cosmetic errors in API responses.
- Non-critical log noise or warning messages.
- Low-severity dependency vulnerability (CVSS < 4.0).
- Feature request misreported as bug.
- Performance degradation in development/staging environments only.

**Response Requirements:**

- Triaged within 1 business day.
- Tracked as GitHub Issue with `low-priority` label.
- Resolution target: next sprint cycle.

## 3. Detection Sources

| Source                         | What It Detects                                                              | Alert Channel                                    | Typical Severity |
| ------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------ | ---------------- |
| **Sentry**                     | Application errors, unhandled exceptions, error rate spikes                  | Slack #alerts, email                             | P1-P3            |
| **Prometheus / Grafana**       | Infrastructure metrics: CPU, memory, disk, latency, request rate, error rate | PagerDuty, Slack #alerts                         | P0-P2            |
| **Health Endpoints**           | Service availability (`/api/health`)                                         | Uptime monitor (e.g., Better Uptime) → PagerDuty | P0-P1            |
| **CodeQL / SAST**              | Security vulnerabilities in code                                             | GitHub Security tab, Slack #security             | P2-P3            |
| **npm audit / Dependabot**     | Dependency vulnerabilities                                                   | GitHub PR, Slack #security                       | P2-P3            |
| **TruffleHog**                 | Secrets committed to repository                                              | CI pipeline failure, Slack #security             | P1               |
| **AWS CloudTrail / GuardDuty** | Suspicious infrastructure access, API calls                                  | SNS → PagerDuty                                  | P0-P2            |
| **Customer Reports**           | User-visible issues not caught by automated monitoring                       | support@westbridge.co, Slack #support            | P1-P3            |
| **Security Researchers**       | Vulnerability reports via responsible disclosure                             | security@westbridge.co, GitHub Security Advisory | P1-P3            |
| **Audit Logs**                 | Anomalous access patterns (e.g., bulk data export, privilege escalation)     | Application-level alerts                         | P1-P2            |

## 4. Response Process

### Phase 1: Detection and Triage (0-15 minutes)

1. **Alert received** — On-call engineer acknowledges alert in PagerDuty/Slack.
2. **Initial assessment** — Determine:
   - What is the user impact? (complete outage vs. degradation vs. no impact)
   - What systems are affected?
   - Is this a security incident?
   - What is the severity level (P0-P3)?
3. **Declare incident** — For P0/P1: post in Slack #incidents with severity, affected systems, and initial assessment.
4. **Assign Incident Commander** — P0: Engineering Lead or CTO. P1: On-call engineer (may escalate).

### Phase 2: Containment (15-60 minutes)

1. **Stabilize the system** — Priority is to stop further damage:
   - If bad deployment → rollback immediately (see `docs/runbooks/rollback.md`)
   - If security breach → isolate affected systems, revoke compromised credentials
   - If database issue → stop writes if corruption is spreading
   - If DDoS/abuse → enable emergency rate limiting, block offending IPs
2. **Preserve evidence** — Before making changes:
   - Screenshot current monitoring dashboards
   - Export relevant log segments: `fly logs > incident-YYYY-MM-DD.log`
   - Capture database state if relevant (read-only replica if available)
   - Note timestamps of all actions taken
3. **Communicate** — IC posts initial Slack update: what is known, what is being done, ETA for next update.

### Phase 3: Investigation (ongoing)

1. **Root cause analysis** — While containment is in progress:
   - Review Sentry error traces for the relevant timeframe
   - Check Prometheus metrics for anomalies (CPU, memory, latency, error rate)
   - Review recent deployments and merge history in git
   - Check dependency status (ERPNext, PowerTranz, Redis, external services)
   - Review audit logs for suspicious access patterns
2. **Document findings** — Scribe maintains a running timeline in the incident Slack thread.
3. **Escalate if needed** — If root cause is unclear after 30 minutes (P0) or 2 hours (P1), escalate:
   - Cloud provider support (AWS, Fly.io)
   - Third-party vendor (ERPNext, PowerTranz, Resend)
   - External security consultant (if security breach)

### Phase 4: Resolution

1. **Implement fix** — Deploy the fix following the emergency change process (see `docs/policies/change-management.md`, Section 6).
2. **Verify resolution:**
   - Health endpoint returns `200 OK`
   - Error rates return to baseline in Sentry
   - Affected functionality manually verified
   - Performance metrics return to normal in Prometheus/Grafana
3. **Declare resolved** — IC posts resolution message in Slack #incidents.
4. **Update status page** — Confirm service restored.
5. **Notify stakeholders** — Customer communication if external impact occurred.

### Phase 5: Post-Incident

1. **Blameless postmortem** — Completed within 48 hours of resolution (see Section 7).
2. **Follow-up actions** — Track remediation items as GitHub Issues.
3. **Evidence archival** — All incident artifacts stored in `docs/compliance/incident-records/`.

## 5. Response Timelines Summary

| Severity | Acknowledge    | IC Assigned | Status Page | First Update | Resolution Target | Postmortem |
| -------- | -------------- | ----------- | ----------- | ------------ | ----------------- | ---------- |
| P0       | 5 min          | 15 min      | 15 min      | 30 min       | 1 hour            | 48 hours   |
| P1       | 15 min         | 30 min      | 30 min      | 1 hour       | 4 hours           | 48 hours   |
| P2       | 1 hour         | N/A         | N/A         | 4 hours      | 24 hours          | 1 week     |
| P3       | 1 business day | N/A         | N/A         | N/A          | Next sprint       | N/A        |

## 6. Escalation Matrix

| Condition                          | Escalate To                        | Method                        |
| ---------------------------------- | ---------------------------------- | ----------------------------- |
| P0 alert not acknowledged in 5 min | Secondary on-call                  | PagerDuty auto-escalation     |
| P0 not resolved in 30 min          | Engineering Lead + CTO             | Phone call                    |
| P0 not resolved in 1 hour          | CEO                                | Phone call                    |
| Confirmed security breach          | CISO                               | Phone call immediately        |
| Customer data compromised          | CISO + Legal counsel               | Phone call immediately        |
| P1 not resolved in 2 hours         | Engineering Lead                   | Slack + phone                 |
| P1 not resolved in 4 hours         | CTO                                | Phone call                    |
| Third-party system causing P0/P1   | Vendor support (critical priority) | Vendor support portal + phone |
| Regulatory notification required   | CISO + Legal counsel               | Email + phone                 |

## 7. Blameless Postmortem

### 7.1 Requirement

A blameless postmortem is **mandatory** for all P0 and P1 incidents. P2 postmortems are conducted at the IC's discretion.

### 7.2 Timeline

- **Draft completed:** Within 48 hours of incident resolution.
- **Review meeting:** Within 5 business days.
- **Follow-up actions assigned:** During or immediately after review meeting.

### 7.3 Postmortem Template

```markdown
# Postmortem: [Incident Title]

**Date:** YYYY-MM-DD
**Severity:** P0/P1/P2
**Duration:** HH:MM (from detection to resolution)
**Incident Commander:** [Name]
**Author:** [Name]

## Summary

[1-2 sentence description of what happened and user impact]

## Impact

- **Users affected:** [number or percentage]
- **Duration:** [minutes/hours]
- **Revenue impact:** [if applicable]
- **Data impact:** [any data loss or exposure]

## Timeline (UTC)

| Time  | Event                              |
| ----- | ---------------------------------- |
| HH:MM | [Detection — how was it detected?] |
| HH:MM | [Actions taken...]                 |
| HH:MM | [Resolution]                       |

## Root Cause

[Detailed technical explanation. Focus on systemic causes, not individual blame.]

## Contributing Factors

- [Factor 1 — e.g., missing monitoring for X]
- [Factor 2 — e.g., configuration change without testing]

## What Went Well

- [e.g., Alerting detected the issue within 2 minutes]
- [e.g., Rollback was executed in under 5 minutes]

## What Went Poorly

- [e.g., Initial responder did not have access to X]
- [e.g., Communication to customers was delayed]

## Action Items

| Action        | Owner  | Due Date   | Ticket |
| ------------- | ------ | ---------- | ------ |
| [Description] | [Name] | YYYY-MM-DD | [Link] |

## Lessons Learned

[Key takeaways for the team]
```

### 7.4 Blameless Culture

- Postmortems focus on **systemic issues**, not individual mistakes.
- The goal is to improve processes, tooling, and monitoring — not to assign blame.
- Individuals are never named as the "cause" of an incident. Root causes are framed as systemic failures (e.g., "insufficient test coverage for edge case" not "developer X didn't test").
- Attendance at postmortem review meetings is expected for all involved parties.

## 8. Communication Templates

### 8.1 Internal — Incident Declaration (Slack #incidents)

```
:rotating_light: **INCIDENT DECLARED — [P0/P1]**

**What:** [Brief description of the issue]
**Impact:** [Who/what is affected]
**IC:** @[Incident Commander name]
**Status:** Investigating
**Next update:** [Time, e.g., "in 30 minutes"]
```

### 8.2 Internal — Status Update (Slack #incidents)

```
**UPDATE — [P0/P1] [Incident title]**

**Status:** [Investigating / Identified / Mitigating / Resolved]
**Current understanding:** [What we know now]
**Actions taken:** [What has been done]
**Next steps:** [What happens next]
**Next update:** [Time]
```

### 8.3 External — Status Page (Customer-Facing)

**Investigating:**

> We are investigating reports of [degraded performance / service unavailability] affecting [description]. Our engineering team is actively working on this. We will provide an update within [time].

**Identified:**

> We have identified the cause of [the issue] and are implementing a fix. [Brief non-technical description]. We expect to resolve this within [time estimate].

**Resolved:**

> The issue affecting [description] has been resolved as of [time]. [Brief description of what happened and what was done]. We apologize for the inconvenience. A detailed review is being conducted to prevent recurrence.

### 8.4 External — Customer Email (Major Incident)

```
Subject: [Resolved/Update] Westbridge ERP Service Disruption — [Date]

Dear [Customer/Team],

We want to inform you about a service disruption that occurred on [date/time]
affecting [description of impact].

**What happened:** [Non-technical explanation]
**Impact:** [What customers experienced]
**Duration:** [Start time — end time]
**Resolution:** [What was done to fix it]

**What we're doing to prevent recurrence:**
- [Action 1]
- [Action 2]

We sincerely apologize for the inconvenience. If you have questions or
concerns, please contact support@westbridge.co.

Sincerely,
[Name]
[Title], Westbridge Inc.
```

## 9. Evidence Preservation

For SOC 2 compliance and potential legal requirements, the following evidence must be preserved for every P0/P1 incident:

| Evidence                                    | Responsible Party       | Retention Period                    |
| ------------------------------------------- | ----------------------- | ----------------------------------- |
| Incident timeline and Slack transcripts     | Scribe / IC             | 3 years                             |
| Application logs (Sentry)                   | DevOps                  | 90 days (Sentry) + exported archive |
| Infrastructure logs (CloudWatch / Fly.io)   | DevOps                  | 90 days + exported archive          |
| Monitoring dashboards (screenshots/exports) | On-call engineer        | 3 years                             |
| Git commits and PRs related to the fix      | Automatic (GitHub)      | Indefinite                          |
| Postmortem document                         | IC / Author             | Indefinite (git-tracked)            |
| Customer communication records              | Communications Lead     | 3 years                             |
| Audit log entries for the incident period   | Automatic (application) | Per data retention policy           |

Evidence is stored in `docs/compliance/incident-records/YYYY-MM-DD-<incident-slug>/`.

## 10. Security Incident Specifics

When an incident involves a confirmed or suspected security breach, the following additional steps apply:

1. **Isolate affected systems** — Revoke compromised credentials, rotate secrets, block attacker IPs.
2. **Engage CISO** — CISO takes over as IC or co-leads with technical IC.
3. **Preserve forensic evidence** — Do not destroy logs, do not reimage affected systems until forensic capture is complete.
4. **Assess data impact** — Determine what data was accessed, modified, or exfiltrated. Reference Prisma schema `/// @pii` annotations to identify PII exposure.
5. **Legal notification** — If customer PII is compromised, engage Legal counsel for breach notification requirements (72 hours under GDPR, varies by jurisdiction).
6. **Credential rotation** — Rotate all potentially compromised secrets:
   - `ENCRYPTION_KEY`, `CSRF_SECRET`, `SESSION_SECRET`
   - Database credentials
   - API keys (ERPNext, PowerTranz, Resend, Sentry, PostHog)
7. **External communication** — CISO approves all external communication regarding security incidents.

## 11. Related Documents

| Document                      | Location                                       |
| ----------------------------- | ---------------------------------------------- |
| Information Security Policy   | `docs/policies/information-security-policy.md` |
| Business Continuity Plan      | `docs/policies/business-continuity-plan.md`    |
| Change Management Policy      | `docs/policies/change-management.md`           |
| Rollback Runbook              | `docs/runbooks/rollback.md`                    |
| Database Backup Runbook       | `docs/runbooks/database-backup.md`             |
| Security Vulnerability Policy | `SECURITY.md`                                  |

---

_This document is classified as Internal. Distribute to all engineering and on-call personnel._
