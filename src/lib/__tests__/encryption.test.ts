/**
 * Encryption unit tests — AES-256-GCM encrypt/decrypt, key validation, key rotation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { encrypt, decrypt, isEncrypted, validateEncryptionKey, ENCRYPTION_CONTEXT } from "../encryption.js";
import { randomBytes as _randomBytes } from "crypto";

// Valid 32-byte hex key for testing
const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ALTERNATE_KEY = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

describe("Encryption — encrypt and decrypt", () => {
  beforeEach(() => {
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips a simple string", () => {
    const plaintext = "hello world";
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("round-trips a whitespace-only string", () => {
    const ciphertext = encrypt("   ");
    expect(decrypt(ciphertext)).toBe("   ");
  });

  it("round-trips unicode content", () => {
    const plaintext = "Héllo 世界 🔑";
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("round-trips a long string", () => {
    const plaintext = "a".repeat(10_000);
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("produces ciphertext in ivHex:authTagHex:encryptedHex format", () => {
    const ciphertext = encrypt("test");
    const parts = ciphertext.split(":");
    expect(parts).toHaveLength(3);
    // IV = 12 bytes = 24 hex chars
    expect(parts[0]).toMatch(/^[0-9a-f]{24}$/);
    // Auth tag = 16 bytes = 32 hex chars
    expect(parts[1]).toMatch(/^[0-9a-f]{32}$/);
    // Encrypted data (at least 1 hex pair)
    expect(parts[2]).toMatch(/^[0-9a-f]+$/);
  });

  it("produces different ciphertext for the same plaintext (unique IV)", () => {
    const a = encrypt("same");
    const b = encrypt("same");
    expect(a).not.toBe(b); // IVs should differ
    expect(decrypt(a)).toBe("same");
    expect(decrypt(b)).toBe("same");
  });
});

describe("Encryption — key validation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when ENCRYPTION_KEY is missing", () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    expect(() => encrypt("test")).toThrow("ENCRYPTION_KEY");
  });

  it("throws when ENCRYPTION_KEY is too short", () => {
    vi.stubEnv("ENCRYPTION_KEY", "abcdef");
    expect(() => encrypt("test")).toThrow("ENCRYPTION_KEY");
  });

  it("throws when ENCRYPTION_KEY contains invalid hex", () => {
    vi.stubEnv("ENCRYPTION_KEY", "gg" + "0".repeat(62)); // 'gg' is not valid hex
    expect(() => encrypt("test")).toThrow("ENCRYPTION_KEY");
  });

  // Regression test: production deploy had a 32-char key which silently
  // failed. Verify both the valid length (64) and several invalid lengths
  // are checked correctly.
  it("regression: throws when ENCRYPTION_KEY is exactly 32 chars (was deployed with this!)", () => {
    vi.stubEnv("ENCRYPTION_KEY", "a".repeat(32));
    expect(() => encrypt("test")).toThrow(/64 hex characters/);
  });

  it("throws when ENCRYPTION_KEY is 63 chars (one short)", () => {
    vi.stubEnv("ENCRYPTION_KEY", "a".repeat(63));
    expect(() => encrypt("test")).toThrow(/64 hex characters/);
  });

  it("throws when ENCRYPTION_KEY is 65 chars (one over)", () => {
    vi.stubEnv("ENCRYPTION_KEY", "a".repeat(65));
    expect(() => encrypt("test")).toThrow(/64 hex characters/);
  });

  it("accepts ENCRYPTION_KEY of exactly 64 hex chars", () => {
    vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef".repeat(4));
    expect(() => encrypt("test")).not.toThrow();
  });
});

describe("Encryption — tamper detection", () => {
  beforeEach(() => {
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects ciphertext with tampered auth tag", () => {
    const ciphertext = encrypt("secret data");
    const parts = ciphertext.split(":");
    // Flip a byte in the auth tag
    const tampered = parts[1]!.slice(0, -2) + "ff";
    const bad = `${parts[0]}:${tampered}:${parts[2]}`;
    expect(() => decrypt(bad)).toThrow();
  });

  it("rejects ciphertext with tampered encrypted data", () => {
    const ciphertext = encrypt("secret data");
    const parts = ciphertext.split(":");
    const tampered = parts[2]!.slice(0, -2) + "ff";
    const bad = `${parts[0]}:${parts[1]}:${tampered}`;
    expect(() => decrypt(bad)).toThrow();
  });

  it("rejects malformed ciphertext (wrong format)", () => {
    expect(() => decrypt("not-valid")).toThrow("Invalid ciphertext format");
    expect(() => decrypt("a:b")).toThrow("Invalid ciphertext format");
    expect(() => decrypt("::")).toThrow("one or more segments are empty");
  });

  it("rejects truncated auth tag (tag-truncation attack)", () => {
    const ciphertext = encrypt("secret data");
    const parts = ciphertext.split(":");
    // Truncate auth tag to 4 bytes (8 hex chars) — should be 16 bytes (32 hex chars)
    const truncated = parts[1]!.slice(0, 8);
    const bad = `${parts[0]}:${truncated}:${parts[2]}`;
    expect(() => decrypt(bad)).toThrow();
  });
});

describe("Encryption — key rotation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("decrypts data encrypted with previous key after rotation", () => {
    // Encrypt with old key
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "");
    const ciphertext = encrypt("rotate me");

    // Rotate: old key becomes previous
    vi.stubEnv("ENCRYPTION_KEY", ALTERNATE_KEY);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", TEST_KEY);

    expect(decrypt(ciphertext)).toBe("rotate me");
  });

  it("encrypts with new key after rotation", () => {
    vi.stubEnv("ENCRYPTION_KEY", ALTERNATE_KEY);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", TEST_KEY);

    const ciphertext = encrypt("new data");

    // Should decrypt with current key alone (no previous needed)
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "");
    expect(decrypt(ciphertext)).toBe("new data");
  });

  it("fails when both keys are wrong", () => {
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "");
    const ciphertext = encrypt("lost data");

    // Switch to entirely different keys
    vi.stubEnv("ENCRYPTION_KEY", ALTERNATE_KEY);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "aabbccdd" + "0".repeat(56));

    expect(() => decrypt(ciphertext)).toThrow("Decryption failed");
  });
});

describe("Encryption — isEncrypted", () => {
  beforeEach(() => {
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("recognises a real ciphertext blob", () => {
    const ct = encrypt("hello");
    expect(isEncrypted(ct)).toBe(true);
  });

  it("rejects plaintext", () => {
    expect(isEncrypted("hello world")).toBe(false);
    expect(isEncrypted("plain-text-secret")).toBe(false);
    expect(isEncrypted("base64==/+stuff")).toBe(false);
  });

  it("rejects malformed ciphertext lookalikes", () => {
    // 24 hex chars (correct IV length) but no auth tag or data
    expect(isEncrypted("a".repeat(24))).toBe(false);
    // Two segments with hex but missing data segment
    expect(isEncrypted("a".repeat(24) + ":" + "b".repeat(32))).toBe(false);
    // Right shape but wrong IV length (12 hex = 6 bytes, not 12 bytes)
    expect(isEncrypted("aaaaaaaaaaaa:" + "b".repeat(32) + ":" + "cc")).toBe(false);
    // Right shape but wrong tag length
    expect(isEncrypted("a".repeat(24) + ":" + "b".repeat(20) + ":" + "cc")).toBe(false);
  });

  it("rejects empty / non-string input", () => {
    expect(isEncrypted("")).toBe(false);
    // @ts-expect-error — runtime guard for non-string callers
    expect(isEncrypted(null)).toBe(false);
    // @ts-expect-error
    expect(isEncrypted(undefined)).toBe(false);
    // @ts-expect-error
    expect(isEncrypted(123)).toBe(false);
  });

  it("rejects ciphertexts that contain uppercase hex (encrypt only emits lowercase)", () => {
    // encrypt() always emits lowercase hex, so an uppercase blob is either
    // hand-crafted or corrupted — either way we should not consider it valid.
    const ct = encrypt("hi").toUpperCase();
    expect(isEncrypted(ct)).toBe(false);
  });
});

describe("Encryption — validateEncryptionKey (startup hook)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes with a valid 64-char hex key", () => {
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "");
    expect(() => validateEncryptionKey()).not.toThrow();
  });

  it("passes with both ENCRYPTION_KEY and ENCRYPTION_KEY_PREVIOUS valid", () => {
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", ALTERNATE_KEY);
    expect(() => validateEncryptionKey()).not.toThrow();
  });

  it("throws when ENCRYPTION_KEY is malformed (regression for silent prod failure)", () => {
    vi.stubEnv("ENCRYPTION_KEY", "not-hex-and-too-short");
    expect(() => validateEncryptionKey()).toThrow(/64 hex characters/);
  });

  it("throws when ENCRYPTION_KEY_PREVIOUS is set but malformed", () => {
    // The current key is fine, so without a previous-key check this would
    // pass and only fail later during a rotation-window decrypt — by which
    // time the bad key has already been deployed.
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "not-a-valid-key");
    expect(() => validateEncryptionKey()).toThrow(/64 hex characters/);
  });

  it("ignores ENCRYPTION_KEY_PREVIOUS when empty (the unrotated default)", () => {
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "");
    expect(() => validateEncryptionKey()).not.toThrow();
  });
});

describe("Encryption — IV length enforcement", () => {
  beforeEach(() => {
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects ciphertext with a non-12-byte IV", () => {
    const ciphertext = encrypt("guarded");
    const parts = ciphertext.split(":");
    // Replace 12-byte IV with an 8-byte one — still hex, still parseable,
    // but cryptographically distinct from anything encrypt() emits.
    const shortIv = "a".repeat(16); // 8 bytes
    const tampered = `${shortIv}:${parts[1]}:${parts[2]}`;
    expect(() => decrypt(tampered)).toThrow();
  });
});

describe("Encryption — v1 envelope with AAD context binding", () => {
  beforeEach(() => {
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips when encrypt + decrypt use the same context", () => {
    const ctx = "totp.secret:user-abc";
    const ciphertext = encrypt("topsecret", ctx);
    expect(decrypt(ciphertext, ctx)).toBe("topsecret");
  });

  it("produces a 4-part v1 envelope when context is provided", () => {
    const ciphertext = encrypt("data", "ctx-1");
    const parts = ciphertext.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toMatch(/^[0-9a-f]{24}$/); // IV
    expect(parts[2]).toMatch(/^[0-9a-f]{32}$/); // auth tag
    expect(parts[3]).toMatch(/^[0-9a-f]+$/); // ciphertext
  });

  it("produces a 3-part v0 envelope when context is omitted (back-compat)", () => {
    const ciphertext = encrypt("data");
    expect(ciphertext.split(":")).toHaveLength(3);
  });

  it("rejects v1 ciphertext when no context is supplied on decrypt", () => {
    const ciphertext = encrypt("data", "ctx-1");
    expect(() => decrypt(ciphertext)).toThrow(/v1 envelope requires AAD context/);
  });

  it("rejects v1 ciphertext when context is wrong (cross-context attack)", () => {
    const ciphertext = encrypt("data", "totp.secret:user-A");
    expect(() => decrypt(ciphertext, "totp.secret:user-B")).toThrow("Decryption failed");
  });

  it("rejects v1 ciphertext when context is empty string vs unset", () => {
    const ciphertext = encrypt("data", "ctx");
    expect(() => decrypt(ciphertext, "")).toThrow("Decryption failed");
  });

  it("v0 legacy ciphertext decrypts even when context is supplied (ignored)", () => {
    // Existing rows in the DB are v0; passing context to decrypt should not break them.
    const legacy = encrypt("legacy data");
    expect(legacy.split(":")).toHaveLength(3);
    expect(decrypt(legacy, "any-context")).toBe("legacy data");
    expect(decrypt(legacy)).toBe("legacy data");
  });

  it("AAD-bound ciphertexts cannot be moved between rows (cross-row attack)", () => {
    // Two TOTP secrets, one per user
    const userA = "user-a-id";
    const userB = "user-b-id";
    const secretA = encrypt("AAAAAAAAAA", ENCRYPTION_CONTEXT.totpSecret(userA));
    const secretB = encrypt("BBBBBBBBBB", ENCRYPTION_CONTEXT.totpSecret(userB));

    // Each decrypts under its own context
    expect(decrypt(secretA, ENCRYPTION_CONTEXT.totpSecret(userA))).toBe("AAAAAAAAAA");
    expect(decrypt(secretB, ENCRYPTION_CONTEXT.totpSecret(userB))).toBe("BBBBBBBBBB");

    // An attacker who copies user A's encrypted secret onto user B's row
    // (e.g. via SQL injection or a compromised admin) cannot decrypt it,
    // because the auth tag was computed against userA's AAD context.
    expect(() => decrypt(secretA, ENCRYPTION_CONTEXT.totpSecret(userB))).toThrow("Decryption failed");
    expect(() => decrypt(secretB, ENCRYPTION_CONTEXT.totpSecret(userA))).toThrow("Decryption failed");
  });

  it("v1 envelope survives key rotation when context still matches", () => {
    const ctx = "sso.clientSecret:account-xyz";
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "");
    const ciphertext = encrypt("rotated v1", ctx);

    // Rotate keys: old → previous, new → current
    vi.stubEnv("ENCRYPTION_KEY", ALTERNATE_KEY);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", TEST_KEY);

    expect(decrypt(ciphertext, ctx)).toBe("rotated v1");
  });

  it("ENCRYPTION_CONTEXT helpers produce stable, namespaced strings", () => {
    expect(ENCRYPTION_CONTEXT.totpSecret("u1")).toBe("totp.secret:u1");
    expect(ENCRYPTION_CONTEXT.ssoClientSecret("a1")).toBe("sso.clientSecret:a1");
    expect(ENCRYPTION_CONTEXT.sessionErpnextSid("u1")).toBe("session.erpnextSid:u1");
    expect(ENCRYPTION_CONTEXT.webhookSecret("e1")).toBe("webhook.secret:e1");
  });

  it("rejects malformed v1 envelope (claims v1 but missing parts)", () => {
    expect(() => decrypt("v1:onlyone", "ctx")).toThrow("Invalid ciphertext format");
    expect(() => decrypt("v1::", "ctx")).toThrow("Invalid ciphertext format");
  });

  it("v1 envelope with tampered auth tag is rejected (AAD does not weaken integrity)", () => {
    const ctx = "ctx-1";
    const ciphertext = encrypt("data", ctx);
    const parts = ciphertext.split(":");
    const tamperedTag = parts[2]!.slice(0, -2) + "ff";
    const bad = `${parts[0]}:${parts[1]}:${tamperedTag}:${parts[3]}`;
    expect(() => decrypt(bad, ctx)).toThrow();
  });

  it("isEncrypted recognises both v0 and v1 envelopes", () => {
    const v0 = encrypt("legacy");
    const v1 = encrypt("modern", "ctx");
    expect(isEncrypted(v0)).toBe(true);
    expect(isEncrypted(v1)).toBe(true);
    expect(isEncrypted("plaintext")).toBe(false);
    expect(isEncrypted("v1:not-real-hex")).toBe(false);
  });
});
