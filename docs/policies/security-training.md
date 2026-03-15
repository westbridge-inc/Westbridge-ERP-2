# Security Awareness Training Policy

**Owner:** Engineering Lead
**Approved:** 2026-03-15
**Review Cycle:** Annual
**SOC 2 Reference:** CC1.4 — Commitment to Competence

---

## 1. Purpose

This policy establishes requirements for security awareness training to ensure all Westbridge personnel understand their responsibilities for protecting company and customer data.

## 2. Scope

Applies to all employees, contractors, and third-party personnel with access to Westbridge systems, code repositories, or customer data.

## 3. New Hire Onboarding (First Week)

All new team members must complete the following within their first 5 business days:

- [ ] Read and acknowledge the [Information Security Policy](./information-security-policy.md)
- [ ] Read and acknowledge the [Access Control Policy](./access-control.md)
- [ ] Review the [CONTRIBUTING.md](../../CONTRIBUTING.md) for secure development practices
- [ ] Complete OWASP Top 10 overview (developer roles)
- [ ] Set up MFA on all company accounts (GitHub, Railway, Fly.io, Sentry)
- [ ] Review the [Incident Response Runbook](../runbooks/incident-response.md)

**Verification:** Engineering Lead confirms completion and records the date.

## 4. Annual Security Awareness Training

All personnel must complete annual training covering:

### 4.1 General Topics (All Staff)

- Phishing and social engineering recognition
- Password hygiene and MFA best practices
- Data classification (public, internal, confidential, restricted)
- Acceptable use of company systems
- Incident reporting procedures
- Physical security (laptop locking, screen privacy)
- Data handling and privacy (GDPR obligations)

### 4.2 Developer-Specific Topics

- OWASP Top 10 vulnerabilities and mitigations
- Secure coding practices (input validation, output encoding, parameterized queries)
- Secret management (never commit secrets, use env vars)
- Dependency security (reviewing Dependabot alerts, npm audit)
- Code review security checklist
- Session management and authentication best practices
- Caribbean regulatory requirements (GRA, NIS data handling)

### 4.3 DevOps/Infrastructure Topics

- Container security (non-root users, minimal images, health checks)
- Network segmentation and firewall rules
- Database access controls and connection security
- Backup and disaster recovery procedures
- Log management and monitoring alerting

## 5. Phishing Simulations

- **Frequency:** Quarterly
- **Scope:** All personnel with email accounts
- **Process:** Engineering Lead sends simulated phishing emails using an approved tool
- **Follow-up:** Personnel who click are required to complete additional training within 5 business days
- **Metrics tracked:** Click rate, report rate, time to report

## 6. Compliance Tracking

| Record                         | Storage                               | Retention                       |
| ------------------------------ | ------------------------------------- | ------------------------------- |
| Training completion dates      | Internal spreadsheet or HR system     | 3 years                         |
| Phishing simulation results    | Simulation tool dashboard             | 2 years                         |
| New hire onboarding checklists | HR files                              | Duration of employment + 1 year |
| Policy acknowledgement records | Signed documents / digital signatures | Duration of employment + 1 year |

## 7. Non-Compliance

Personnel who fail to complete required training within the specified timeframe will:

1. Receive a reminder from Engineering Lead
2. If not completed within 10 additional business days, access to production systems may be restricted
3. Repeated non-compliance is escalated to management

## 8. Training Resources

- OWASP Top 10: https://owasp.org/www-project-top-ten/
- SANS Security Awareness: https://www.sans.org/security-awareness-training/
- Westbridge internal docs: `docs/policies/`, `docs/runbooks/`, `SECURITY.md`

## 9. Policy Review

This policy is reviewed annually by the Engineering Lead. Changes require management approval and are communicated to all personnel within 30 days.
