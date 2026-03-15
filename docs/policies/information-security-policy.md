# Information Security Policy

**Document ID:** ISP-001
**Version:** 1.0
**Effective Date:** 2026-03-15
**Last Reviewed:** 2026-03-15
**Next Review:** 2027-03-15
**Owner:** Chief Information Security Officer (CISO)
**Classification:** Internal

> SOC 2 Trust Service Criteria: CC1.1, CC1.2, CC1.3

---

## 1. Purpose

This Information Security Policy establishes the framework for protecting the confidentiality, integrity, and availability of all information assets owned, managed, or processed by Westbridge Inc. ("Westbridge," "the Company"). It defines the organizational commitment to information security, assigns roles and responsibilities, and sets the baseline controls that all personnel must follow.

This policy supports Westbridge's compliance with SOC 2 Type II Trust Service Criteria and demonstrates management's commitment to integrity and ethical values (CC1.1), board-level oversight of internal controls (CC1.2), and a well-defined management structure with clear lines of authority (CC1.3).

## 2. Scope

This policy applies to:

- **All personnel** — full-time employees, part-time employees, contractors, consultants, temporary workers, and interns who access Westbridge information systems.
- **All information assets** — data, software, hardware, network infrastructure, cloud services, and physical media used to store, process, or transmit Westbridge data.
- **All environments** — production, staging, development, and disaster recovery environments.
- **All locations** — on-premises, remote work locations, co-working spaces, and third-party data centers.

## 3. Roles and Responsibilities

### 3.1 Chief Information Security Officer (CISO)

- Owns this policy and all subordinate security policies.
- Establishes, implements, and maintains the information security management program.
- Reports security posture and risk assessments to executive leadership quarterly.
- Approves security exceptions and risk acceptance decisions.
- Ensures security incidents are properly investigated, documented, and resolved.
- Coordinates SOC 2 audit preparation and evidence collection.
- Chairs the Security Review Board.

### 3.2 Engineering Team

- Implements security controls in application code, including authentication, authorization, input validation, encryption, and audit logging.
- Conducts peer code reviews with security considerations for every pull request.
- Remediates vulnerabilities identified by SAST (CodeQL), dependency scanning (npm audit, Dependabot), and penetration testing.
- Follows secure development practices as outlined in the OWASP Top 10 and Westbridge's Secure Coding Guidelines.
- Maintains automated test suites that include security-relevant test cases.

### 3.3 DevOps / Infrastructure Team

- Manages production infrastructure across Railway, Fly.io, and AWS environments.
- Maintains infrastructure-as-code configurations and ensures least-privilege access to cloud resources.
- Implements and monitors network security controls, including firewalls, TLS termination, and DDoS mitigation.
- Manages secrets rotation, key management, and certificate lifecycle.
- Operates monitoring and alerting systems (Prometheus, Sentry, Grafana).
- Executes and documents backup and disaster recovery procedures.

### 3.4 All Staff

- Complete security awareness training within 30 days of hire and annually thereafter.
- Report suspected security incidents, policy violations, or vulnerabilities immediately to security@westbridge.co.
- Protect credentials — never share passwords, API keys, or access tokens.
- Lock workstations when unattended.
- Use company-approved tools and services for processing Westbridge data.
- Comply with this policy and all subordinate security policies; violations may result in disciplinary action up to and including termination.

## 4. Information Asset Classification

All information assets must be classified according to the following scheme. The classification level determines the minimum security controls applied during storage, transmission, and disposal.

### 4.1 Public

- **Definition:** Information explicitly approved for public release. Disclosure poses no risk to the Company.
- **Examples:** Marketing materials, public documentation, open-source code, published blog posts.
- **Controls:** No special handling required. Published through approved channels only.

### 4.2 Internal

- **Definition:** Information intended for use within the Company. Unauthorized disclosure could cause minor inconvenience or reputational impact.
- **Examples:** Internal process documentation, architecture decision records (ADRs), non-sensitive meeting notes, internal project plans.
- **Controls:** Accessible to authenticated employees. Stored in company-managed systems (GitHub, Notion, Google Workspace). No posting to public forums or personal devices without approval.

### 4.3 Confidential

- **Definition:** Sensitive business or technical information whose disclosure could cause significant harm to the Company, its customers, or its partners.
- **Examples:** Source code (proprietary modules), financial data, customer lists, business strategies, security configurations, infrastructure diagrams, audit reports, vendor contracts.
- **Controls:** Access granted on a need-to-know basis. Encrypted at rest (AES-256) and in transit (TLS 1.2+). Stored only in approved, access-controlled repositories. Access logged via audit trail. Disposal via secure deletion.

### 4.4 Restricted

- **Definition:** Highly sensitive data whose compromise could result in severe financial, legal, or regulatory consequences.
- **Examples:** Personally identifiable information (PII) as annotated with `/// @pii` in the Prisma schema, payment card data, authentication credentials, encryption keys, session secrets, customer financial records, health data.
- **Controls:** Strict need-to-know access enforced via RBAC (see `src/lib/rbac.ts`). Encrypted at rest (AES-256-GCM with key rotation) and in transit (TLS 1.2+). Multi-factor authentication required for systems hosting restricted data. Access reviewed quarterly. All access logged and monitored. Data retention and disposal governed by Data Retention Policy. Breach notification within 72 hours per applicable law.

## 5. Access Control Principles

Westbridge enforces the following access control principles across all systems:

1. **Least Privilege** — Users and service accounts receive the minimum permissions necessary to perform their duties. The Westbridge ERP Backend implements a 5-tier RBAC model: Owner, Admin, Manager, Member, and Viewer.

2. **Separation of Duties** — No single individual can provision their own access, approve their own code changes, or deploy without peer review. All pull requests require at least one approval from a different engineer.

3. **Need-to-Know** — Access to Confidential and Restricted data is granted only to personnel with a documented business need.

4. **Defense in Depth** — Multiple overlapping controls protect critical assets: network segmentation, application-level RBAC, database-level row isolation by `accountId`, encryption, and monitoring.

5. **Fail Secure** — Rate limiting and access controls fail closed. If an authorization check cannot be completed, the request is denied.

6. **Provisioning and Deprovisioning** — Access is provisioned through an invite-based onboarding process and revoked within 24 hours of role change or separation. Sessions are invalidated upon deprovisioning.

7. **Access Reviews** — Quarterly reviews of user access across production systems, cloud providers, and third-party services. Results documented and exceptions remediated within 30 days.

## 6. Acceptable Use

### 6.1 Permitted Use

Company information systems, including laptops, cloud accounts, and SaaS tools, are provided for conducting Westbridge business. Limited personal use is acceptable provided it does not interfere with work duties, consume excessive resources, or violate any provision of this policy.

### 6.2 Prohibited Activities

The following activities are strictly prohibited:

- Accessing, attempting to access, or assisting others in accessing systems or data without authorization.
- Sharing credentials, API keys, tokens, or multi-factor authentication devices with any other person.
- Storing Confidential or Restricted data on personal devices, personal cloud storage, or unapproved third-party services.
- Disabling, circumventing, or tampering with security controls (antivirus, endpoint detection, firewalls, audit logging).
- Installing unauthorized software on company devices or production systems.
- Using company systems for illegal activities, harassment, or dissemination of offensive content.
- Connecting to production databases or infrastructure from untrusted networks without VPN.
- Committing secrets, credentials, or private keys to version control (enforced by TruffleHog scanning in CI).

## 7. Incident Reporting

All personnel are required to report suspected or confirmed security incidents immediately. Incidents include but are not limited to:

- Unauthorized access to systems or data.
- Malware infection or suspected compromise of a device.
- Loss or theft of a device containing Westbridge data.
- Accidental disclosure of Confidential or Restricted information.
- Suspicious emails (phishing), social engineering attempts, or unusual system behavior.
- Vulnerabilities discovered in Westbridge applications or infrastructure.

**Reporting channels:**

| Channel                   | Use Case                                         |
| ------------------------- | ------------------------------------------------ |
| security@westbridge.co    | All security incidents and vulnerability reports |
| Slack #security-incidents | Real-time incident coordination                  |
| GitHub Security Advisory  | External vulnerability reports                   |

Detailed incident response procedures are documented in `docs/runbooks/incident-response.md`.

## 8. Policy Review and Maintenance

- This policy is reviewed **annually** by the CISO and executive leadership, or more frequently in response to:
  - Significant security incidents.
  - Material changes to infrastructure, services, or business operations.
  - Changes in regulatory or compliance requirements.
  - Results of audits, risk assessments, or penetration tests.
- All revisions are tracked via version control (git) to maintain a complete audit trail.
- Subordinate policies (change management, BCP, training, data retention) follow the same review cadence.

## 9. Enforcement

Violations of this policy may result in disciplinary action commensurate with the severity of the violation, including:

- Verbal or written warning.
- Mandatory remedial training.
- Revocation of system access.
- Suspension or termination of employment or contract.
- Civil or criminal legal action where applicable.

All enforcement actions are documented and maintained by Human Resources for the duration of the individual's employment plus seven years.

## 10. Related Documents

| Document                      | Location                                    |
| ----------------------------- | ------------------------------------------- |
| Business Continuity Plan      | `docs/policies/business-continuity-plan.md` |
| Change Management Policy      | `docs/policies/change-management.md`        |
| Security Training Policy      | `docs/policies/security-training.md`        |
| Incident Response Runbook     | `docs/runbooks/incident-response.md`        |
| Rollback Runbook              | `docs/runbooks/rollback.md`                 |
| Database Backup Runbook       | `docs/runbooks/database-backup.md`          |
| SOC 2 Evidence Framework      | `docs/compliance/soc2-evidence.md`          |
| Security Vulnerability Policy | `SECURITY.md`                               |

## 11. Approval

| Role | Name                       | Date                       |
| ---- | -------------------------- | -------------------------- |
| CISO | ************\_************ | \_**\_/\_\_**/**\_\_\_\_** |
| CEO  | ************\_************ | \_**\_/\_\_**/**\_\_\_\_** |
| CTO  | ************\_************ | \_**\_/\_\_**/**\_\_\_\_** |

---

_This document is classified as Internal. Do not distribute outside Westbridge Inc. without CISO approval._
