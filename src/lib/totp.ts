/**
 * TOTP (RFC 6238) verification helpers shared between the 2FA setup
 * routes and the login flow.
 *
 * NOTE: SHA-1 is REQUIRED here by RFC 6238 for compatibility with every major
 * authenticator app (Google Authenticator, Authy, 1Password, Microsoft
 * Authenticator). HMAC-SHA1 is NOT weakened by SHA-1's collision vulnerabilities
 * because TOTP does not rely on collision resistance — it relies on HMAC's
 * pseudorandom function properties. Changing to SHA-256 would break 2FA for
 * every user enrolled in the system.
 */

import { createHmac } from "crypto";

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Encode a buffer to RFC 4648 base32. Used to render the secret a user
 * scans into their authenticator app at setup time.
 */
export function toBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_CHARS[(value << (5 - bits)) & 31];
  return output;
}

/**
 * Decode a base32 string into the original byte buffer. Tolerates
 * padding/whitespace/lowercase by skipping anything not in the alphabet.
 */
export function fromBase32(str: string): Buffer {
  let bits = "";
  for (const c of str.toUpperCase()) {
    const idx = BASE32_CHARS.indexOf(c);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * Verify a 6-digit TOTP code against a secret with ±1 time-step (30s)
 * clock-skew tolerance per RFC 6238 §5.2.
 */
export function verifyTotp(secret: Buffer, code: string): boolean {
  for (const offset of [-1, 0, 1]) {
    const time = Math.floor(Date.now() / 1000 / 30) + offset;
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeBigInt64BE(BigInt(time));
    // nosemgrep: javascript.node-stdlib.cryptography.crypto-weak-algorithm.crypto-weak-algorithm
    const hmac = createHmac("sha1", secret).update(timeBuffer).digest();
    const off = hmac[hmac.length - 1]! & 0xf;
    const c = ((hmac[off]! & 0x7f) << 24) | (hmac[off + 1]! << 16) | (hmac[off + 2]! << 8) | hmac[off + 3]!;
    if (String(c % 1000000).padStart(6, "0") === code) return true;
  }
  return false;
}
