# Security Policy

Westbridge takes the security of our software and services seriously. This document outlines our security policy for the Westbridge ERP Backend, including how to report vulnerabilities and what to expect during the process.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

Only the latest release on the `main` branch receives security patches. We recommend always running the most recent version.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, please report them via email to:

**[security@westbridge.co](mailto:security@westbridge.co)**

Alternatively, you can report vulnerabilities through GitHub's private security advisory feature:

[Create a Security Advisory](https://github.com/westbridgeinc/Westbridge-ERP-2/security/advisories/new)

### What to Include

To help us triage and respond quickly, please include as much of the following as possible:

- **Description** of the vulnerability
- **Type of issue** (e.g., SQL injection, authentication bypass, CSRF, XSS, privilege escalation)
- **Affected component(s)** (e.g., route path, middleware, library)
- **Step-by-step instructions** to reproduce the issue
- **Proof-of-concept or exploit code** (if available)
- **Impact assessment** -- what an attacker could achieve
- **Full paths of source file(s)** related to the issue (if known)
- **Any special configuration** required to reproduce

## Response Timeline

| Stage                   | Target Timeline        |
| ----------------------- | ---------------------- |
| Acknowledgment          | Within 48 hours        |
| Initial Assessment      | Within 5 business days |
| Status Update           | Every 10 business days |
| Resolution Target       | Within 90 days         |

We will work with you to understand and validate the report. Once confirmed, we will:

1. Develop a fix in a private branch
2. Assign a CVE identifier (if applicable)
3. Prepare a security advisory
4. Release the patch and publish the advisory simultaneously
5. Credit the reporter (unless anonymity is requested)

## Responsible Disclosure Policy

We ask that you:

- **Do not** access, modify, or delete data belonging to other users or accounts
- **Do not** perform actions that could degrade service for other users (e.g., DoS)
- **Do not** publicly disclose the vulnerability before we have released a fix
- **Allow us** reasonable time (up to 90 days) to resolve the issue before public disclosure
- **Make a good faith effort** to avoid privacy violations and disruptions

We will coordinate the public disclosure timeline with you and credit your contribution.

## Out of Scope

The following issues are considered out of scope:

- Vulnerabilities in third-party dependencies without a demonstrated exploit against our application
- Issues in environments running unsupported or heavily modified versions
- Reports generated solely by automated scanning tools without verification
- Social engineering attacks against Westbridge employees or contractors
- Physical attacks against Westbridge infrastructure
- Denial of service (DoS/DDoS) attacks
- Missing security headers on non-sensitive pages that do not lead to exploitable vulnerabilities
- Missing best practices without a demonstrated security impact
- Clickjacking on pages with no sensitive actions
- Rate limiting on non-authentication endpoints (unless demonstrably exploitable)
- Email spoofing (SPF/DKIM/DMARC configuration)

## Safe Harbor

Westbridge supports safe harbor for security researchers who:

- Make a good faith effort to avoid privacy violations, destruction of data, and interruption or degradation of our services
- Only interact with accounts you own or with explicit permission of the account holder
- Do not exploit a security issue for purposes other than verification
- Report any vulnerability you discover promptly
- Follow the responsible disclosure guidelines above

We will not pursue civil or criminal action against researchers who follow these guidelines. If legal action is initiated by a third party, we will take steps to make it known that your actions were conducted in compliance with this policy.

## Recognition / Hall of Fame

We believe in recognizing security researchers who help keep Westbridge and our users safe. With your permission, we will:

- Acknowledge your contribution in our security advisories
- List your name (or handle) in our Security Hall of Fame
- Provide a letter of acknowledgment upon request

If you would like to be recognized, please let us know in your report how you would like to be credited.

## Compliance

Westbridge ERP maintains SOC 2 Type II compliance. For details on our compliance posture, controls, and evidence mapping, please refer to:

- `docs/compliance/` -- SOC 2 documentation, control mappings, and evidence artifacts

For compliance-related inquiries, contact [security@westbridge.co](mailto:security@westbridge.co).

## Security Architecture

The Westbridge ERP Backend implements multiple layers of security:

- **Authentication**: Session-based authentication with CSRF protection
- **Authorization**: 5-tier RBAC (owner, admin, manager, member, viewer) via `src/lib/rbac.ts`
- **Encryption**: AES-256-GCM with key rotation support via `src/lib/encryption.ts`
- **Input Validation**: Zod schemas on all API endpoints
- **Multi-tenancy Isolation**: All database queries scoped by `accountId`
- **Security Headers**: Applied via middleware in `src/middleware/`
- **CSRF Protection**: Token-based CSRF prevention via `src/lib/csrf.ts`
- **Rate Limiting**: Applied to authentication and sensitive endpoints
- **Security Monitoring**: Real-time event tracking and anomaly detection

---

_This policy is effective as of March 2026 and will be reviewed quarterly._
