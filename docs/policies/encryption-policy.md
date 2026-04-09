# Encryption Policy

**Document ID:** ENC-001
**Version:** 1.0
**Effective Date:** 2026-04-09
**Owner:** Engineering Lead
**Classification:** Internal

> SOC 2 Trust Service Criteria mapped: CC6.1, CC6.7, C1.1

---

## 1. Purpose

This policy specifies how Westbridge encrypts data at rest and in transit, manages encryption keys, and rotates them. It is designed to be verifiable by audit and to provide enough detail that an SRE on-call can rotate a key without paging the CISO.

## 2. Standards

| Asset                                        | Algorithm                   | Key length | Notes                                             |
| -------------------------------------------- | --------------------------- | ---------- | ------------------------------------------------- |
| Data at rest in Postgres (sensitive columns) | AES-256-GCM                 | 256 bits   | Application-layer encryption with AAD binding     |
| Storage volume encryption (Fly volumes)      | AES-256                     | 256 bits   | Fly.io platform default                           |
| Backup objects (Tigris bucket)               | AES-256                     | 256 bits   | Provider-managed (S3-compatible SSE)              |
| TLS in transit                               | TLS 1.2 minimum, prefer 1.3 | 256 bits   | Helmet HSTS 2yr, Fly's automatic Let's Encrypt    |
| Password hashing                             | bcrypt                      | cost ≥10   | Stored in `users.password_hash`                   |
| Session token storage                        | SHA-256                     | 256 bits   | Token issued client-side, only the hash is stored |
| HMAC signatures (CSRF, webhook, audit chain) | HMAC-SHA-256                | 256 bits   | Application-layer                                 |

## 3. Application-Layer Encryption (sensitive columns)

Implementation: `src/lib/encryption.ts`. The module exposes `encrypt(plaintext, context)` and `decrypt(ciphertext, context)`.

### 3.1 Algorithm

AES-256-GCM with a 12-byte random IV per ciphertext, 16-byte authentication tag, and a per-call associated data (AAD) string. The on-disk envelope is:

```
v1:<base64(iv)>:<base64(ciphertext+tag)>
```

The `v1:` prefix is the envelope version. v0 (legacy, no AAD) is detected by the absence of the prefix and decrypted without AAD for backwards compatibility during migration; new writes always use v1.

### 3.2 Associated data binding

Every encrypted field is bound to a context string in `ENCRYPTION_CONTEXT` (see `src/lib/encryption.ts`). The AAD makes ciphertexts non-portable: a TOTP secret encrypted with `ENCRYPTION_CONTEXT.totpSecret(userId)` cannot be successfully decrypted as a session SID, even by an attacker who has the encryption key, because the AAD mismatch fails GCM authentication.

Currently bound contexts:

- `ENCRYPTION_CONTEXT.totpSecret(userId)` — `totp_secrets.secret` column
- `ENCRYPTION_CONTEXT.sessionErpnextSid(userId)` — `sessions.erpnext_sid` column
- `ENCRYPTION_CONTEXT.webhookSecret(endpointId)` — `webhook_endpoints.secret` column
- `ENCRYPTION_CONTEXT.ssoClientSecret(accountId)` — `sso_configs.client_secret`
- `ENCRYPTION_CONTEXT.passwordResetToken(userId)` — `password_reset_tokens.token_hash` (HMAC, not encryption, but uses the same context binding pattern)

Adding a new restricted column requires adding a new context entry — code review enforces this.

### 3.3 Key storage

The encryption key is stored as the Fly.io secret `ENCRYPTION_KEY`. Fly envelopes secrets using its platform-managed KMS so the on-disk representation in Fly is itself encrypted. The application reads the secret at process start (`src/lib/env.ts:52`) and validates the key length and base64 format via `validateEncryptionKey()`.

### 3.4 Validation

`src/lib/__tests__/encryption.test.ts` covers:

- Round-trip plaintext → ciphertext → plaintext
- AAD mismatch causes decryption to throw
- Tampered ciphertext fails authentication
- Format-version detection (v0 vs v1)
- Key validation (length, base64)

The audit memo in `project_audit_remediation.md` rates cryptography 5/5.

## 4. TLS in Transit

### 4.1 Public endpoints

`fly.toml` and `fly.staging.toml` declare `force_https = true`. Helmet sets HSTS to 2 years with `includeSubDomains` and `preload` (`src/app.ts:94`). All public endpoints serve HTTPS via Fly's automatic Let's Encrypt certificates.

### 4.2 Sub-processor traffic

| Outbound dependency    | TLS                                      |
| ---------------------- | ---------------------------------------- |
| Resend                 | TLS 1.3 (provider default)               |
| Paddle                 | TLS 1.3                                  |
| Anthropic              | TLS 1.3                                  |
| Sentry                 | TLS 1.3                                  |
| ERPNext (Frappe Cloud) | TLS 1.2+                                 |
| Upstash Redis          | TLS 1.2+ (rediss:// or redis://+stunnel) |

### 4.3 Internal Postgres traffic (Fly.io WireGuard)

Postgres connections use `sslmode=disable` because the connection traverses Fly's encrypted WireGuard mesh, which provides the equivalent of TLS at the network layer. The boot-time check in `src/lib/env.ts:175-197` warns about non-strict sslmode and can be upgraded to a hard failure via `REQUIRE_DB_TLS=true`. The pre-existing log warning is documented in the env.ts comment.

## 5. Key Management

### 5.1 Rotation cadence

| Key                          | Rotation cadence                                           | Owner            |
| ---------------------------- | ---------------------------------------------------------- | ---------------- |
| `ENCRYPTION_KEY`             | Annually OR on suspected compromise                        | CISO             |
| `SESSION_SECRET`             | Annually OR on suspected compromise                        | CISO             |
| `CSRF_SECRET`                | Annually OR on suspected compromise                        | CISO             |
| `westbridge_app` DB password | Annually OR on personnel offboarding                       | Engineering Lead |
| Fly API tokens               | 90 days OR on personnel offboarding                        | Engineering Lead |
| Sub-processor API keys       | Annually OR on personnel offboarding                       | Engineering Lead |
| TLS certificates             | Auto-renewed by Fly (Let's Encrypt) ~60 days before expiry | Fly.io platform  |

### 5.2 Rotation procedure (`ENCRYPTION_KEY`)

The encryption module supports two-key rotation via `ENCRYPTION_KEY_PREVIOUS`:

1. Generate a new key: `openssl rand -hex 32`
2. Set `ENCRYPTION_KEY_PREVIOUS` to the current `ENCRYPTION_KEY`, then set `ENCRYPTION_KEY` to the new value: `fly secrets set --app westbridge-api ENCRYPTION_KEY_PREVIOUS=<old> ENCRYPTION_KEY=<new>`
3. Roll the deploy; the application starts trying decrypts with the new key first and falls back to `ENCRYPTION_KEY_PREVIOUS` on failure.
4. Run a backfill job that re-encrypts every row with the new key (TODO: write this script — currently rotation is in-place per row on next write).
5. After all rows are re-encrypted, unset `ENCRYPTION_KEY_PREVIOUS`.

Validation guard: `src/lib/env.ts:113-122` rejects a configuration where `ENCRYPTION_KEY_PREVIOUS == ENCRYPTION_KEY` because such a setup is a no-op rotation.

### 5.3 Rotation procedure (`SESSION_SECRET` / `CSRF_SECRET`)

These are HMAC keys, not encryption keys. Rotation invalidates outstanding sessions/tokens signed with the old key. The CSRF module supports a `CSRF_SECRET_PREVIOUS` rolling-window for graceful rotation; sessions are revoked and users re-login.

1. Generate new: `openssl rand -hex 32`
2. Set `CSRF_SECRET_PREVIOUS` to current, set `CSRF_SECRET` to new
3. Wait one CSRF cookie max-age (1 hour) for clients to refresh
4. Unset `CSRF_SECRET_PREVIOUS`

### 5.4 Rotation procedure (`westbridge_app` DB password)

1. SSH into the Postgres machine: `flyctl ssh console -a westbridge-db`
2. Run `psql -U postgres -c "ALTER ROLE westbridge_app WITH PASSWORD '<new-password>';"`
3. Update Fly secrets: `flyctl secrets set --app westbridge-api DATABASE_URL='postgres://westbridge_app:<new>@westbridge-db.flycast:5432/westbridge_api?sslmode=disable'`
4. The Fly secret update automatically rolls the API machines.
5. Verify health: `curl https://api.westbridgetoday.com/api/health`

The `scripts/provision-rls-role.sh --rotate-password` script automates steps 1-2.

## 6. Backup Encryption

Backups produced by `flyctl pg backup` are stored in a Tigris bucket. Tigris is S3-compatible and applies AES-256 server-side encryption (SSE) automatically. See `docs/runbooks/database-backup.md` for the backup runbook.

## 7. Validation and Testing

| Test                                        | File                                                 |
| ------------------------------------------- | ---------------------------------------------------- |
| AES-256-GCM round trip                      | `src/lib/__tests__/encryption.test.ts`               |
| AAD mismatch detection                      | `src/lib/__tests__/encryption.test.ts`               |
| Encryption key validation at startup        | `src/lib/__tests__/env.test.ts`                      |
| TOTP secret encryption (uses encryption.ts) | `src/routes/__tests__/totp.routes.test.ts`           |
| Session erpnext_sid encryption              | `src/lib/services/__tests__/session.service.test.ts` |
| Webhook secret encryption                   | `src/workers/__tests__/webhooks.worker.test.ts`      |

## 8. Exceptions

Any exception to this policy requires written CISO approval and is recorded in `docs/compliance/encryption-exceptions.md`.

## 9. Related

- Information Security Policy (`information-security-policy.md`)
- Access Control Policy (`access-control-policy.md`)
- Data Classification Policy (`data-classification-policy.md`)
- Database Backup Runbook (`../runbooks/database-backup.md`)
