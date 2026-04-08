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

const HEX_KEY_REGEX = /^[0-9a-fA-F]{64}$/;

// Ciphertext structural pattern: ivHex(24):authTagHex(32):encryptedHex(>=2).
// Used by isEncrypted() to discriminate encrypted blobs from plaintext during
// transparent migration windows where a column may contain both formats.
const CIPHERTEXT_REGEX = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/;

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
 * surfacing later as the first encrypt() call from a request handler.
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
 * Detect whether a string is a ciphertext blob produced by encrypt().
 *
 * Use this when migrating a column that may contain both plaintext (legacy)
 * and ciphertext (new writes) so reads can transparently decrypt-or-passthrough
 * without failing the request. Lazy re-encryption can then upgrade plaintext
 * rows on the next write path.
 *
 * Note: this is a STRUCTURAL check, not an integrity check. A string that
 * happens to match the format but was not produced by encrypt() will pass
 * isEncrypted() but fail decrypt() with a tag-mismatch error. That's the
 * intended fail-closed behavior.
 */
export function isEncrypted(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  return CIPHERTEXT_REGEX.test(value);
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
}

export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("Invalid ciphertext format: expected ivHex:authTagHex:encryptedHex");
  const [ivHex, authTagHex, encryptedHex] = parts;
  if (!ivHex || !authTagHex || !encryptedHex)
    throw new Error("Invalid ciphertext format: one or more segments are empty");
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
    // encrypt(), so anything else is either truncation or tampering.
    if (iv.length !== IV_BYTES) {
      throw new Error("Invalid IV length — expected 12 bytes");
    }
    const decipher = createDecipheriv(ALGORITHM, key, iv); // nosemgrep: javascript.node-crypto.security.gcm-no-tag-length.gcm-no-tag-length
    decipher.setAuthTag(authTag);
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
