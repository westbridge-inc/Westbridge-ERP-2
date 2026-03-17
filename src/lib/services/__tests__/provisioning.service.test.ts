import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../data/prisma.js", () => ({
  prisma: {
    account: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { provisionErpnextAccount } from "../provisioning.service.js";
import { prisma } from "../../data/prisma.js";

describe("provisioning.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("returns error when account not found", async () => {
    (prisma.account.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await provisionErpnextAccount("acc_missing");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not found");
  });

  it("provisions account successfully", async () => {
    (prisma.account.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      email: "admin@testco.com",
      companyName: "Test Company",
      currency: "USD",
      country: "US",
    });
    (prisma.account.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    // Mock all fetch calls to succeed
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) }) // company creation
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) }) // user creation
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) }) as any; // set default company

    const result = await provisionErpnextAccount("acc_1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.companyName).toBe("Test Company");
      expect(result.data.erpnextUser).toBe("admin@testco.com");
    }
  });

  it("handles company already exists", async () => {
    (prisma.account.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      email: "admin@testco.com",
      companyName: "Existing Co",
      currency: "GYD",
      country: "GY",
    });
    (prisma.account.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, text: () => Promise.resolve("already exists") }) // company exists
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) }) // user creation
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) }) as any;

    const result = await provisionErpnextAccount("acc_1");
    expect(result.ok).toBe(true);
  });

  it("handles fetch errors", async () => {
    (prisma.account.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      email: "admin@testco.com",
      companyName: "Test Co",
      currency: "USD",
      country: "US",
    });

    global.fetch = vi.fn().mockRejectedValue(new Error("Network error")) as any;

    const result = await provisionErpnextAccount("acc_1");
    expect(result.ok).toBe(false);
  });
});
