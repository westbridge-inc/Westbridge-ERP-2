# ADR-002: Server-Side Sessions Over JWT

## Status: Accepted

## Date: 2026-03-10

## Context

The API needed an authentication mechanism for browser-based SPA clients. The
two primary options were:

- **JWT (stateless)** -- signed tokens stored client-side, verified without a
  database hit.
- **Server-side sessions** -- random opaque tokens stored as SHA-256 hashes in
  PostgreSQL, cached in Redis, delivered via HttpOnly cookies.

Security requirements were high: the system handles financial data (invoices,
payroll), operates in a regulated Caribbean market, and stores encrypted
ERPNext session IDs alongside user sessions.

## Decision

We chose **server-side sessions with hashed tokens**.

Implementation (`src/lib/services/session.service.ts`):

- Tokens are 32-byte `crypto.randomBytes` encoded as base64url.
- Only the SHA-256 hash is stored in the database -- a database breach does
  not leak usable session tokens.
- Sessions are cached in Redis (30s TTL) with full security fields (expiresAt,
  lastActiveAt, fingerprint) so the cache path never bypasses expiry, idle
  timeout, or fingerprint checks.
- ERPNext session IDs are AES-256-GCM encrypted before storage (both DB and
  Redis).
- Max 5 concurrent sessions per user, enforced atomically in a Prisma
  transaction to prevent TOCTOU races.
- 7-day absolute expiry, 30-minute idle timeout.
- Fingerprint validation (User-Agent + IP /24 prefix) detects session
  hijacking.
- Immediate revocation on logout, password change, or security event via
  Redis pipeline flush of all user session cache keys.

## Consequences

### Positive

- Instant revocation -- no waiting for token expiry.
- Session hijack detection via fingerprint mismatch triggers security events.
- Encrypted ERPNext SID relay -- the proxy can authenticate to ERPNext on
  behalf of the user without exposing the SID to the client.
- Audit trail -- every session create, expire, idle-timeout, and revoke is
  logged.

### Negative

- Every authenticated request hits Redis (cache) or PostgreSQL (miss). The
  30s cache TTL keeps DB load manageable; k6 load tests confirm < 5ms p99 for
  the cache path.
- Session table grows with active users and requires periodic cleanup (handled
  by the `cleanup` BullMQ queue, hourly).
- The `toWebRequest` conversion in auth middleware is a compatibility shim
  because the session service uses the Web API `Request` interface while
  Express provides its own `req` object.
