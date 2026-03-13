/**
 * Encryption unit tests — AES-256-GCM encrypt/decrypt, key validation, key rotation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { encrypt, decrypt } from "../encryption.js";
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
