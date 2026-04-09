# Acceptable Use Policy

**Document ID:** AUP-001
**Version:** 1.0
**Effective Date:** 2026-04-09
**Owner:** CISO
**Classification:** Internal

> SOC 2 Trust Service Criteria mapped: CC1.4, CC1.5, CC2.2

---

## 1. Purpose

This policy defines what Westbridge personnel and contractors may and may not do with the systems, data, and access they are granted. It is binding on all personnel from the day of hire and is reviewed annually.

## 2. Scope

Applies to all employees, contractors, advisors, and any other personnel granted access to:

- Westbridge production infrastructure
- Westbridge source code repositories (`Westbridge-ERP-1`, `Westbridge-ERP-2`, internal tooling)
- Customer data (regardless of medium)
- Sub-processor consoles (Sentry, Resend, Paddle, Fly.io, Anthropic, Tigris, Upstash, ERPNext/Frappe Cloud, GitHub)

## 3. Acceptable Use

### 3.1 Authorized purposes

You may use Westbridge systems and data only for:

- Building, operating, and improving the Westbridge ERP product
- Investigating and remediating customer-reported issues with the customer's authorization (or under the contract's incident response provisions)
- Internal company operations: billing reconciliation, audit log review, security incident response
- Anything explicitly assigned by the CISO or engineering lead

### 3.2 Prohibited

You may NOT:

- Access customer ERP data outside the scope of an active support ticket, incident, or scheduled audit, even if you have technical access via the `prismaAdmin` client.
- Copy customer data to a personal device, personal cloud storage, or any system not on the approved sub-processor list.
- Share credentials. Every account is per-person. There are no shared accounts.
- Bypass security controls (CSRF, rate limiting, RLS) without explicit CISO approval, even for testing.
- Disable audit logging, even temporarily.
- Disable branch protection on `main` for any reason other than a documented operator action (e.g., the Phase 3 RLS rollout). Re-enable immediately afterward.
- Commit secrets, credentials, or PII to any git repository — public OR private.
- Use customer data for marketing, research, ML training, or any purpose other than serving that specific customer.
- Run untested SQL or destructive operations against the production database without (a) a backup having been taken, (b) the change being reviewed by a second engineer, (c) the operation being recorded in `docs/compliance/privileged-actions.md`.
- Connect to production from a device that has not been hardened per §4.

## 4. Endpoint Hardening Requirements

Any device used to access production must:

- Have full-disk encryption enabled (FileVault on macOS, BitLocker on Windows, LUKS on Linux)
- Have a screen lock with maximum 5-minute idle timeout
- Run a supported, patched OS (current major version - 1 minimum)
- Have an active firewall (built-in OS firewall is sufficient)
- Not have public-facing services (sshd, web servers) running on the same machine
- Use a password manager for all credentials (no plaintext storage in browser bookmarks, sticky notes, or unencrypted text files)
- Be the personal property of the engineer OR a company-issued device with documented inventory

## 5. Authentication

- All sub-processor accounts MUST have MFA enabled before being granted access. No exceptions.
- GitHub: required org-level MFA on `westbridge-inc`.
- Fly.io: token-based access; tokens scoped per environment; rotated every 90 days.
- All other consoles: provider's strongest available MFA (TOTP at minimum, hardware key preferred).

## 6. Reporting Security Concerns

Any suspected security incident, vulnerability, or unusual behavior MUST be reported immediately to the CISO via email or in-person. There is no penalty for reporting in good faith — only for failing to report. The Incident Response Runbook (`../runbooks/incident-response.md`) describes the escalation chain.

Examples of things to report:

- A device that may have been lost, stolen, or compromised
- Evidence of unauthorized access to a Westbridge or sub-processor account
- A coworker accessing data they should not have
- A vendor security incident notification (Sentry, Resend, etc.)
- Any third-party report of a vulnerability in Westbridge

## 7. Personal Use

Limited personal use of Westbridge systems (e.g., reading personal email through a browser tab, brief personal messages on Slack) is acceptable but must not interfere with work, expose Westbridge to malware, or violate other policies. Personal data should not be stored on Westbridge devices.

## 8. Customer Communication

When communicating with customers about a security incident, you MUST follow the Incident Response Runbook's communication template. You may NOT speculate, make commitments, or share details about other customers.

## 9. Departing Personnel

On the last day of employment (or contract end):

- All access is revoked the same day. GitHub org membership removed. Fly.io tokens deleted. Sub-processor accounts disabled.
- Company-issued devices returned. Personal devices: any production credentials and customer data must be deleted, witnessed by another engineer.
- The departing person signs an attestation that they have deleted all customer data from any device or storage they used.

## 10. Acknowledgement

Every person granted access to production signs an attestation that they have read and agree to this policy on hire and annually. The signed attestations are stored in `docs/compliance/aup-acknowledgements/<year>/`.

## 11. Violations

Violations are investigated by the CISO. Consequences range from a written warning to termination, depending on severity, intent, and prior history. Material violations may also result in legal action.

## 12. Related

- Information Security Policy (`information-security-policy.md`)
- Access Control Policy (`access-control-policy.md`)
- Incident Response Runbook (`../runbooks/incident-response.md`)
