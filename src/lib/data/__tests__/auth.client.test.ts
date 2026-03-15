import { describe, it, expect, vi, beforeEach } from "vitest";

describe("auth.client — erpLogin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok with session ID on success", async () => {
    const mockHeaders = new Headers();
    mockHeaders.set("set-cookie", "sid=abc123; Path=/; HttpOnly");
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: mockHeaders,
    } as Response);

    const { erpLogin } = await import("../auth.client.js");
    const result = await erpLogin("test@test.com", "password");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe("abc123");
  });

  it("returns error on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      headers: new Headers(),
    } as Response);

    const { erpLogin } = await import("../auth.client.js");
    const result = await erpLogin("test@test.com", "wrong");
    expect(result.ok).toBe(false);
  });

  it("returns error when no set-cookie header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: new Headers(),
    } as Response);

    const { erpLogin } = await import("../auth.client.js");
    const result = await erpLogin("test@test.com", "password");
    expect(result.ok).toBe(false);
  });

  it("returns error on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const { erpLogin } = await import("../auth.client.js");
    const result = await erpLogin("test@test.com", "password");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ECONNREFUSED");
  });
});
