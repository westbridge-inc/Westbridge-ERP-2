# Access Control Policy

**Document ID:** ACL-001
**Version:** 1.0
**Effective Date:** 2026-04-09
**Last Reviewed:** 2026-04-09
**Next Review:** 2027-04-09
**Owner:** Engineering Lead
**Classification:** Confidential

> SOC 2 Trust Service Criteria mapped: CC6.1, CC6.2, CC6.3, CC6.6

---

## 1. Purpose

This policy defines how access to Westbridge production systems and customer data is provisioned, authenticated, authorized, monitored, and revoked. It ensures that the principle of least privilege is enforced and that every access decision is auditable.

## 2. Scope

Covers logical access to:

- Westbridge application accounts (customer-facing API + frontend)
- Production infrastructure (Fly.io, Tigris, ERPNext, Resend, Sentry, Paddle, Upstash Redis)
- Source code and CI/CD (GitHub repositories `Westbridge-ERP-1` and `Westbridge-ERP-2`)
- Customer data (`westbridge-db` PostgreSQL cluster, audit logs, backup storage)

Physical access is out of scope (Westbridge is fully remote, all infrastructure is hosted by sub-processors).

## 3. Identity and Authentication

### 3.1 User authentication (customer-facing)

- **Local password:** bcrypt hash with cost factor 14 (~250ms per hash on modern hardware). Plaintext is never stored. Minimum length 10 characters; must contain at least one uppercase, one lowercase, one digit, and one special character. Maximum 128 chars to prevent DoS. Validated by `src/lib/password-policy.ts`. Legacy SHA-256 hashes are explicitly rejected and the user is forced to reset.
- **Multi-factor authentication:** TOTP (RFC 6238) is **available** to all users on an opt-in basis. MFA is **not yet enforced** for owner/admin roles by org-wide policy — that is an open enhancement item targeted for 2026-Q3 (see `risk-assessment.md` R5 and `soc2-tsc-mapping.md` §5 known gaps). When TOTP is enabled, the secret is stored AES-256-GCM-encrypted with AAD bound to the userId, and 8 backup codes are issued at enrollment (SHA-256 hashed, single-use). Login flow: password verification → if TOTP is enabled, issue a short-lived (5 min) Redis-stored "TOTP challenge" token; the client redeems it via `/api/auth/login/totp`. Implementation: `src/routes/totp.routes.ts`, `src/lib/totp.ts`, `src/routes/auth.controller.ts:54-55`.
- **Single sign-on:** SAML 2.0 and OIDC supported via `src/routes/sso.routes.ts` + `src/lib/services/sso.service.ts`. SSO configuration is per-account; client secret is stored AES-256-GCM-encrypted with AAD bound to the accountId.
- **Account lockout:** After 5 consecutive failed login attempts, the account is locked for 15 minutes. Lockout state is enforced BEFORE the password check via `failedLoginAttempts`, `lastFailedLogin`, and `lockedUntil` columns on the `users` table. Counter resets on successful login. (No customer email is sent on lockout — that's a tracked enhancement.)
- **Password reset:** Token-based, single-use, expires in 1 hour. Token hash stored in `password_reset_tokens`. Implementation: `src/lib/services/password-reset.service.ts`.
- **Session lifetime:** 7-day absolute expiry. 30-minute idle timeout (enforced both via Redis cache and the persisted `lastActiveAt` column). Maximum 5 concurrent sessions per user, enforced atomically when a new session is created. Tokens are 32-byte random values stored as SHA-256 hashes; the encrypted ERPNext session ID is stored alongside (AES-256-GCM, AAD bound). A session **fingerprint** (SHA-256 of User-Agent + IP /24 prefix) is recorded at session creation and validated on each request to detect hijacking — fingerprint validation is intentionally skipped in NODE_ENV=development. See `src/lib/services/session.service.ts`.
- **Session revocation:** Triggered automatically on password change (preserves the current session, revokes all others — see `auth.service.ts:163-166`); manually via `revokeSession` and `revokeAllUserSessions`. Sessions also auto-expire from the cleanup worker hourly.

### 3.2 Internal authentication (employees / contractors)

- **GitHub:** Required MFA on all `westbridge-inc` org members. Personal access tokens scoped to minimum required permissions and rotated every 90 days.
- **Fly.io:** API tokens scoped per environment (`FLY_API_TOKEN`). Web console access via Fly.io's organization auth.
- **Sub-processor consoles:** Sentry, Resend, Paddle, Tigris — all gated by their respective MFA-enabled accounts.
- **Production database:** Direct console access via `flyctl ssh console -a westbridge-db`. SSH cert is issued per-user via `flyctl postgres renew-certs`. No shared credentials.

## 4. Authorization

### 4.1 Application RBAC

The application defines four customer-facing roles in `src/lib/rbac.ts`:

| Role   | Permissions                                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| owner  | Full access to all resources within the account, including billing, team management, account deletion, and audit log export. |
| admin  | Same as owner except cannot delete the account, cannot transfer ownership.                                                   |
| member | CRUD on ERP documents (sales invoices, expenses, projects, etc.). Cannot manage users, billing, or settings.                 |
| viewer | Read-only access to ERP documents.                                                                                           |

Permission checks use string identifiers (e.g., `users:invite`, `billing:refund`) and are enforced by the `requirePermission` middleware applied to every state-changing route.

### 4.2 Tenant isolation

Every authenticated request enters `requireAuth` (`src/middleware/auth.ts`), which:

1. Validates the session token against the database (via `prismaAdmin` so the lookup itself is not gated by RLS).
2. Publishes the active `accountId` into Node `AsyncLocalStorage` (`src/lib/data/tenant-als.ts`).
3. Calls the request handler.

Every Prisma query inside the handler is then automatically wrapped in a one-shot `$transaction` that runs `set_config('app.current_account_id', $accountId, true)` first. PostgreSQL RLS policies enforce that every read and write is scoped to that tenant. The `prisma` runtime client connects as the `westbridge_app` role, which has NO `BYPASSRLS` privilege — see `src/lib/data/prisma.ts`.

Cross-tenant administrative operations (login lookup, signup INSERT, signature-verified webhook handlers, cleanup workers) use the separate `prismaAdmin` client (`src/lib/data/prisma-admin.ts`), which connects as the schema-owner role and bypasses RLS by ownership. Each cross-tenant call site carries a one-line comment explaining why it must span tenants. The split is documented in `CONTRIBUTING.md` and `CONTRIBUTING-PATTERNS.md`.

### 4.3 Database-level access

The PostgreSQL cluster `westbridge-db` runs three roles:

| Role             | Used by                                | Privileges                                                                |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| `westbridge_api` | `prismaAdmin`, schema migrations       | Schema owner. Bypasses RLS by ownership.                                  |
| `westbridge_app` | `prisma` (runtime authenticated path)  | RLS-bound. Default-denies any query without `app.current_account_id` set. |
| `postgres`       | Operator (manual ops via `flyctl ssh`) | Superuser. Used only for incident response and migrations.                |

Role provisioning scripts: `scripts/provision-rls-role.sh`. Password rotation: see Encryption Policy §5.

### 4.4 Code repository access

- **`westbridge-inc/Westbridge-ERP-1` (frontend)** and **`westbridge-inc/Westbridge-ERP-2` (backend)** are private. Members are added to the `westbridge-inc` GitHub org with the minimum-needed role.
- Branch protection on `main` requires: 1 approving review, status checks (`build`), strict (branch must be up-to-date).
- Squash-merge is the only allowed merge strategy. Force-push is disabled.
- The disable-protection-merge-enable pattern is permitted only for the founder/CISO and only for documented operator actions (e.g., the v3.0 RLS rollout).

## 5. Provisioning and Deprovisioning

### 5.1 Customer accounts

- **Provision:** Self-service via `/signup`. Account is created with `owner` role. ERPNext company is auto-provisioned via the `provisioning` BullMQ queue.
- **Deprovision:** Customer-initiated via `DELETE /api/account`. Soft delete sets `deletedAt`, anonymizes PII, and revokes all credentials immediately. After 30 days, a cleanup worker hard-deletes the account and all child rows. See `src/lib/services/account-cleanup.service.ts`.

### 5.2 Internal personnel

- **Onboarding:** Founder/CISO adds the new person to the GitHub org, grants Fly.io org access, creates accounts on each sub-processor console with MFA enabled. Acknowledgement of all policies in `docs/policies/` is captured before any access is granted.
- **Offboarding:** All access is revoked the same day. GitHub org membership removed. Fly.io tokens rotated. Sub-processor accounts disabled. SSH certificates expire automatically (1-day TTL) and are not renewed.

## 6. Access Reviews

| Scope                                                     | Frequency        | Owner                                    |
| --------------------------------------------------------- | ---------------- | ---------------------------------------- |
| GitHub org membership                                     | Quarterly        | Engineering Lead                         |
| Fly.io org membership and tokens                          | Quarterly        | Engineering Lead                         |
| Sub-processor console accounts                            | Quarterly        | Engineering Lead                         |
| Customer admin accounts (per tenant)                      | Customer-managed | (see customer-side responsibility below) |
| Database role grants (`westbridge_app`, `westbridge_api`) | Annually         | CISO                                     |

Findings are recorded in `docs/compliance/access-review-YYYY-QN.md` (one file per review). Any unauthorized or stale access is revoked immediately.

## 7. Privileged Access

Privileged actions in production (production DB writes outside the application code path, secret rotation, infrastructure changes) require:

1. CISO approval, recorded in writing (commit message, PR description, or operator-action log).
2. Documented in `docs/compliance/privileged-actions.md`.
3. Audit-logged via `src/lib/services/audit.service.ts:logAudit({ severity: "critical" })` where the action touches the application database.

## 8. Customer-side responsibility

Westbridge enforces the controls above for the platform itself. Customers are responsible for:

- Managing their own account's user list (invite/revoke).
- Enabling MFA for their owner and admin users.
- Configuring SSO if they require it (free tier and above).
- Reviewing their account's audit log on a cadence that matches their internal compliance program.

We surface these responsibilities in the in-app onboarding flow and the trust page.

## 9. Exceptions

Any exception to this policy requires written approval from the CISO and is recorded in `docs/compliance/access-control-exceptions.md` with justification, scope, expiry, and compensating controls.

## 10. Related

- Information Security Policy (`information-security-policy.md`)
- Encryption Policy (`encryption-policy.md`)
- Vendor Management Policy (`vendor-management-policy.md`)
- Logging and Monitoring Policy (`logging-and-monitoring-policy.md`)
- Incident Response Runbook (`../runbooks/incident-response.md`)
