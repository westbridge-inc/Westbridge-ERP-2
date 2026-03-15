import { describe, it, expect } from "vitest";

// env.ts runs parseEnv() on import, which reads process.env.
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
