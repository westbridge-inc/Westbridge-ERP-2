import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// env.ts runs parseEnv on import, which reads process.env.
// In test environment, NODE_ENV=test, so it should parse fine with defaults.
describe("env", () => {
  it("exports env object", async () => {
    const { env } = await import("../env.js");
    expect(env).toBeDefined();
    expect(env.NODE_ENV).toBe("test");
  });

  it("has default PORT", async () => {
    const { env } = await import("../env.js");
    expect(env.PORT).toBe(4000);
  });

  it("has default REDIS_URL", async () => {
    const { env } = await import("../env.js");
    expect(env.REDIS_URL).toBe("redis://localhost:6379");
  });

  it("has default FRONTEND_URL", async () => {
    const { env } = await import("../env.js");
    expect(env.FRONTEND_URL).toBe("http://localhost:3000");
  });

  it("has default cookie config", async () => {
    const { env } = await import("../env.js");
    expect(["none", "lax", "strict"]).toContain(env.COOKIE_SAME_SITE);
  });

  it("has default log level", async () => {
    const { env } = await import("../env.js");
    expect(env.LOG_LEVEL).toBe("info");
  });
});

// ─── Secret length + rotation validation (fresh import per test) ─────────────
//
// parseEnv runs at import time, so we re-import the module after stubbing
// env vars. NODE_ENV=test bypasses the production-only safety checks but the
// length checks (Zod schema) and rotation no-op check run in every environment.
describe("env — secret length + rotation validation", () => {
  const VALID_HEX_KEY = "0123456789abcdef".repeat(4);
  const VALID_HEX_KEY_2 = "fedcba9876543210".repeat(4);

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("accepts valid SESSION_SECRET, CSRF_SECRET, and ENCRYPTION_KEY", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ENCRYPTION_KEY", VALID_HEX_KEY);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "");
    vi.stubEnv("SESSION_SECRET", "a-test-session-secret-of-at-least-32-chars");
    vi.stubEnv("CSRF_SECRET", "a-test-csrf-secret-of-at-least-32-characters");
    await expect(import("../env.js")).resolves.toBeDefined();
  });

  it("rejects SESSION_SECRET shorter than 32 chars", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ENCRYPTION_KEY", "change-me-in-production");
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "");
    vi.stubEnv("SESSION_SECRET", "too-short");
    vi.stubEnv("CSRF_SECRET", "a-test-csrf-secret-of-at-least-32-characters");
    await expect(import("../env.js")).rejects.toThrow();
  });

  it("rejects CSRF_SECRET shorter than 32 chars", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ENCRYPTION_KEY", "change-me-in-production");
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "");
    vi.stubEnv("SESSION_SECRET", "a-test-session-secret-of-at-least-32-chars");
    vi.stubEnv("CSRF_SECRET", "tiny");
    await expect(import("../env.js")).rejects.toThrow();
  });

  it("rejects identical ENCRYPTION_KEY and ENCRYPTION_KEY_PREVIOUS (no-op rotation)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ENCRYPTION_KEY", VALID_HEX_KEY);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", VALID_HEX_KEY);
    vi.stubEnv("SESSION_SECRET", "a-test-session-secret-of-at-least-32-chars");
    vi.stubEnv("CSRF_SECRET", "a-test-csrf-secret-of-at-least-32-characters");
    await expect(import("../env.js")).rejects.toThrow(/must differ from ENCRYPTION_KEY/);
  });

  it("accepts a valid rotation pair (PREVIOUS != current)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ENCRYPTION_KEY", VALID_HEX_KEY);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", VALID_HEX_KEY_2);
    vi.stubEnv("SESSION_SECRET", "a-test-session-secret-of-at-least-32-chars");
    vi.stubEnv("CSRF_SECRET", "a-test-csrf-secret-of-at-least-32-characters");
    await expect(import("../env.js")).resolves.toBeDefined();
  });

  it("allows the change-me-in-production placeholder in non-prod", async () => {
    // The default is exactly 32 chars long ("change-me-in-production-change-me")
    // so it satisfies the length requirement, and parseEnv lets it through
    // in dev/test paths that don't actually exercise the crypto layer.
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ENCRYPTION_KEY", "change-me-in-production");
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "");
    vi.stubEnv("SESSION_SECRET", "change-me-in-production-change-me");
    vi.stubEnv("CSRF_SECRET", "change-me-in-production-change-me");
    await expect(import("../env.js")).resolves.toBeDefined();
  });
});
