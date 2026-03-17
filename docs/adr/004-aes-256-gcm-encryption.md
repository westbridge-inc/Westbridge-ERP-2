# ADR-004: AES-256-GCM for Data Encryption at Rest

## Status: Accepted

## Date: 2026-03-10

## Context

Sensitive data at rest -- specifically ERPNext session IDs stored alongside
user sessions -- needed authenticated encryption. Requirements:

- Confidentiality and integrity (tamper detection).
- Key rotation without downtime or mass re-encryption.
- No external KMS dependency for the initial launch.
- NIST-approved algorithm for SOC 2 compliance evidence.

## Decision

We use **AES-256-GCM** with a 12-byte (96-bit) IV, implemented in
`src/lib/encryption.ts` using Node.js `crypto`.

Implementation details:

- **Algorithm**: `aes-256-gcm` -- NIST SP 800-38D recommended.
- **IV**: 12 bytes from `crypto.randomBytes`. The 96-bit length avoids the
  extra GHASH derivation step that GCM applies to non-standard IV lengths.
- **Key**: 256-bit (32-byte) derived from `ENCRYPTION_KEY` environment
  variable. Strict hex validation (`/^[0-9a-fA-F]{64}$/`) runs before
  `Buffer.from` to prevent silent truncation of invalid characters.
- **Auth tag**: 128-bit (16 bytes). Enforced on decryption -- shorter tags
  are rejected to prevent tag-truncation forgery attacks.
- **Ciphertext format**: `ivHex:authTagHex:encryptedHex` -- a single string
  storable in any text column.
- **Key rotation**: `ENCRYPTION_KEY_PREVIOUS` provides a fallback. Decryption
  tries the current key first; on failure, tries the previous key. New
  encryptions always use the current key, so data migrates forward naturally.
- **Error handling**: Distinguishes authentication failures (tag mismatch)
  from wrong-key errors for observability, without exposing which key was
  tried to callers.

## Consequences

### Positive

- NIST-approved, auditor-friendly for SOC 2 CC6.1 (encryption at rest).
- Key rotation is zero-downtime: set `ENCRYPTION_KEY_PREVIOUS`, rotate
  `ENCRYPTION_KEY`, deploy. Old ciphertexts decrypt with the previous key.
- No external service dependency -- uses Node.js built-in `crypto`.
- Auth tag validation prevents both tampering and truncation attacks.

### Negative

- Key management is environment-variable based. A dedicated KMS (AWS KMS,
  HashiCorp Vault) would be more robust for production at scale.
- No automatic re-encryption of old ciphertexts -- they remain encrypted
  under the previous key until the record is next written.
- IV uniqueness relies on `crypto.randomBytes` quality. At 12 bytes and our
  volume (< 1M encryptions/year), birthday collision risk is negligible.
