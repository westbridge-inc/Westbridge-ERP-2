/**
 * AES-256-GCM authenticated encryption for field-level data at rest.
 *
 * Algorithm choice: AES-256-GCM (NIST SP 800-38D) — the same primitive used by
 * HashiCorp Vault, Themis, Acra, and TLS 1.3 GCM ciphersuites. AES-NI hardware
 * acceleration on every modern CPU keeps performance at ~1 GB/s.
 *
 * Envelope formats (auto-detected by decrypt):
 *
 *   v0 (legacy, 3 parts):  ivHex:authTagHex:encryptedHex
 *     • No additional authenticated data (AAD) binding.
 *     • Still readable for backwards compatibility with rows written before AAD.
 *
 *   v1 (current, 4 parts): v1:ivHex:authTagHex:encryptedHex
 *     • Caller passes a `context` string on both encrypt and decrypt.
 *     • The context becomes GCM Additional Authenticated Data — it is NOT
 *       secret, but is cryptographically bound to the ciphertext, so an
 *       attacker who substitutes one user's encrypted secret onto another row
 *       (cross-row attack) cannot decrypt it. The auth tag will not match.
 *     • Use a stable namespaced context like `totp.secret:${userId}` or
 *       `sso.clientSecret:${accountId}`. ENCRYPTION_CONTEXT below has helpers
 *       for the canonical strings.
 *     • The context is *not* stored in the envelope; both encrypt and decrypt
 *       must derive it identically from row metadata.
 *
 * Key rotation:
 *   ENCRYPTION_KEY          — current key, used for all encryption.
 *   ENCRYPTION_KEY_PREVIOUS — optional fallback key for decryption only.
 *   During rotation set ENCRYPTION_KEY=new and ENCRYPTION_KEY_PREVIOUS=old,
 *   re-encrypt rows lazily on read or via a background job, then unset
 *   PREVIOUS once the migration window closes.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
// NIST SP 800-38D recommends a 96-bit (12-byte) IV for AES-GCM. Using the
// recommended length avoids the extra GHASH derivation step that GCM applies
// to non-96-bit IVs, which is slightly slower and less well-analysed.
const IV_BYTES = 12;
// 128-bit (16-byte) authentication tag — the maximum supported by GCM and
// the only length we accept on decryption. Anything shorter weakens the
// integrity guarantee and enables tag-truncation forgery.
const AUTH_TAG_BYTES = 16;
// Envelope version prefix for the AAD-bound format. v0 had no prefix and is
// still accepted on decrypt for backwards compatibility with legacy rows.
const ENVELOPE_V1 = "v1";

const HEX_KEY_REGEX = /^[0-9a-fA-F]{64}$/;

// Ciphertext structural patterns. Used by isEncrypted to discriminate
// encrypted blobs from plaintext during transparent migration windows where a
// column may contain both formats.
//   v0: ivHex(24):authTagHex(32):encryptedHex(≥2)
//   v1: literal "v1:" + same three hex segments
const CIPHERTEXT_REGEX = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/;
const CIPHERTEXT_V1_REGEX = /^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/;

function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  // Validate strict hex format BEFORE Buffer.from — Buffer.from(secret, "hex") silently
  // truncates non-hex characters, so a 64-char string with invalid chars would produce
  // a short key that passes the length check but is cryptographically weak.
  if (!secret || !HEX_KEY_REGEX.test(secret))
    throw new Error(
      "ENCRYPTION_KEY must be exactly 64 hex characters (0-9, a-f) — generate with: openssl rand -hex 32",
    );
  const key = Buffer.from(secret, "hex");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY decoded to unexpected length — internal error");
  return key;
}

function getKeyFromHex(secret: string): Buffer {
  if (!secret || !HEX_KEY_REGEX.test(secret))
    throw new Error("Encryption key must be exactly 64 hex characters (0-9, a-f)");
  const key = Buffer.from(secret, "hex");
  if (key.length !== 32) throw new Error("Encryption key decoded to unexpected length — internal error");
  return key;
}

/**
 * Validate ENCRYPTION_KEY (and ENCRYPTION_KEY_PREVIOUS if set) at server
 * startup so misconfiguration crashes the process immediately rather than
 * surfacing later as the first encrypt call from a request handler.
 *
 * Called from src/lib/env.ts after Zod parsing.
 */
export function validateEncryptionKey(): void {
  // Throws synchronously with a clear error if the current key is malformed.
  getKey();

  // ENCRYPTION_KEY_PREVIOUS is optional. If set, it MUST be a valid 32-byte
  // hex key — silent acceptance of garbage here would cause every
  // rotation-window decrypt to fall back to a useless key and obscure the
  // real failure mode.
  const previous = process.env.ENCRYPTION_KEY_PREVIOUS;
  if (previous) {
    getKeyFromHex(previous);
  }
}

/**
 * Detect whether a string is a ciphertext blob produced by encrypt.
 *
 * Use this when migrating a column that may contain both plaintext (legacy)
 * and ciphertext (new writes) so reads can transparently decrypt-or-passthrough
 * without failing the request. Lazy re-encryption can then upgrade plaintext
 * rows on the next write path.
 *
 * Note: this is a STRUCTURAL check, not an integrity check. A string that
 * happens to match the format but was not produced by encrypt will pass
 * isEncrypted but fail decrypt with a tag-mismatch error. That's the
 * intended fail-closed behavior.
 */
export function isEncrypted(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  return CIPHERTEXT_REGEX.test(value) || CIPHERTEXT_V1_REGEX.test(value);
}

/**
 * Encrypt plaintext using AES-256-GCM with a fresh random 96-bit IV.
 *
 * @param plaintext  UTF-8 string to encrypt.
 * @param context    Optional Additional Authenticated Data (AAD). When supplied,
 *                   the ciphertext is bound to this context — the exact same
 *                   string must be passed to decrypt, or the auth tag will not
 *                   verify. Pass a stable namespaced identifier such as
 *                   `"totp.secret:" + userId`. This prevents an attacker who
 *                   can write to your DB from moving one user's encrypted
 *                   secret onto another user's row.
 *
 *                   When omitted, produces a v0 envelope (no AAD) for
 *                   backwards compatibility with legacy callers.
 */
export function encrypt(plaintext: string, context?: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (context !== undefined) {
    // setAAD must be called BEFORE update — Node enforces this ordering.
    cipher.setAAD(Buffer.from(context, "utf8"));
  }
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const segments = [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")];
  if (context !== undefined) {
    return [ENVELOPE_V1, ...segments].join(":");
  }
  return segments.join(":");
}

/**
 * Decrypt a ciphertext produced by encrypt. Auto-detects envelope version.
 *
 * @param ciphertext  3-part v0 (`iv:tag:ct`) or 4-part v1 (`v1:iv:tag:ct`).
 * @param context     Required when the envelope is v1; ignored for v0. Must
 *                    match the value passed to encrypt exactly.
 */
export function decrypt(ciphertext: string, context?: string): string {
  if (typeof ciphertext !== "string" || ciphertext.length === 0) {
    throw new Error("Invalid ciphertext: empty or non-string input");
  }

  const parts = ciphertext.split(":");

  let envelopeVersion: "v0" | "v1";
  let ivHex: string | undefined;
  let authTagHex: string | undefined;
  let encryptedHex: string | undefined;

  if (parts.length === 4 && parts[0] === ENVELOPE_V1) {
    envelopeVersion = "v1";
    [, ivHex, authTagHex, encryptedHex] = parts;
  } else if (parts.length === 3) {
    envelopeVersion = "v0";
    [ivHex, authTagHex, encryptedHex] = parts;
  } else {
    throw new Error("Invalid ciphertext format: expected v0 (iv:tag:ct) or v1 (v1:iv:tag:ct)");
  }

  if (!ivHex || !authTagHex || !encryptedHex)
    throw new Error("Invalid ciphertext format: one or more segments are empty");

  // v1 envelopes require an AAD context — fail closed rather than silently
  // decrypting without the integrity binding the writer intended.
  if (envelopeVersion === "v1" && context === undefined) {
    throw new Error("Decryption failed: v1 envelope requires AAD context but none was provided");
  }

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");

  const tryDecrypt = (key: Buffer): string => {
    // Enforce the expected 128-bit (16-byte) GCM authentication tag length
    // before decryption to prevent tag-truncation forgery attacks.
    // An attacker who controls the ciphertext could otherwise supply a
    // shorter auth tag that passes verification by chance.
    if (authTag.length !== AUTH_TAG_BYTES) {
      throw new Error("Invalid authentication tag length — expected 16 bytes");
    }
    // Reject zero-length IVs and any IV that is not the recommended 96 bits.
    // Non-12-byte IVs are technically supported by GCM but go through GHASH
    // derivation, which has worse analysis. We always emit 12-byte IVs in
    // encrypt, so anything else is either truncation or tampering.
    if (iv.length !== IV_BYTES) {
      throw new Error("Invalid IV length — expected 12 bytes");
    }
    const decipher = createDecipheriv(ALGORITHM, key, iv); // nosemgrep: javascript.node-crypto.security.gcm-no-tag-length.gcm-no-tag-length
    decipher.setAuthTag(authTag);
    if (envelopeVersion === "v1") {
      // setAAD must be called BEFORE update — Node enforces this ordering.
      decipher.setAAD(Buffer.from(context!, "utf8"));
    }
    return decipher.update(encrypted, undefined, "utf8") + decipher.final("utf8");
  };

  try {
    return tryDecrypt(getKey());
  } catch (primaryErr) {
    const prevSecret = process.env.ENCRYPTION_KEY_PREVIOUS;
    if (prevSecret) {
      try {
        return tryDecrypt(getKeyFromHex(prevSecret));
      } catch {
        // Both keys failed — fall through to throw.
      }
    }
    // Distinguish integrity failure from wrong-key for observability.
    // Do not expose which key was tried to callers.
    const isAuthFailure =
      primaryErr instanceof Error &&
      (primaryErr.message.includes("Unsupported state") ||
        primaryErr.message.includes("bad decrypt") ||
        primaryErr.message.includes("authentication"));
    throw new Error(isAuthFailure ? "Decryption failed: authentication tag mismatch" : "Decryption failed", {
      cause: primaryErr,
    });
  }
}

/**
 * Stable AAD context strings used by callers across the codebase. Defined here
 * (rather than at each call site) so the binding strings are auditable in one
 * place and never accidentally diverge between encrypt and decrypt sides.
 */
export const ENCRYPTION_CONTEXT = {
  /** Per-user TOTP secret. Bound to the userId so a TOTP secret cannot be
   *  cross-substituted onto another user's row. */
  totpSecret: (userId: string) => `totp.secret:${userId}`,
  /** Per-account SSO OIDC client secret. Bound to accountId. */
  ssoClientSecret: (accountId: string) => `sso.clientSecret:${accountId}`,
  /** Per-session ERPNext SID. Bound to the user the session belongs to. */
  sessionErpnextSid: (userId: string) => `session.erpnextSid:${userId}`,
  /** Per-account webhook signing secret. Bound to the endpoint id. */
  webhookSecret: (endpointId: string) => `webhook.secret:${endpointId}`,
} as const;
