import { describe, it, expect, vi, beforeEach } from "vitest";

// Set env before import
process.env.ERPNEXT_URL = "http://localhost:8080";

import { erpList, erpGet, erpCreate, erpUpdate, erpDelete } from "../erpnext.client.js";

describe("erpnext.client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("erpList", () => {
    it("returns list data on success", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ name: "INV-001" }] }),
      }) as any;

      const result = await erpList("Sales Invoice", "sid_123");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual([{ name: "INV-001" }]);
      }
    });

    it("returns empty array on 404", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: () => Promise.resolve({ data: [] }),
      }) as any;

      const result = await erpList("NonExistent", "sid_123");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual([]);
      }
    });

    it("adds company filter when erpnextCompany provided", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      }) as any;

      const result = await erpList("Sales Invoice", "sid_123", {}, "acc_1", "Test Co");
      expect(result.ok).toBe(true);
      const callUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(callUrl).toContain("filters");
    });

    it("returns error for invalid filters JSON", async () => {
      const result = await erpList("Sales Invoice", "sid_123", { filters: "not-json" }, "acc_1", "Co");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Invalid filters");
    });

    it("returns error for invalid filters without company", async () => {
      const result = await erpList("Sales Invoice", "sid_123", { filters: "{bad" });
      expect(result.ok).toBe(false);
    });

    it("handles server errors", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      }) as any;

      const result = await erpList("Sales Invoice", "sid_123");
      expect(result.ok).toBe(false);
    });

    it("uses API key auth when session is dev-local-session", async () => {
      process.env.ERPNEXT_API_KEY = "key";
      process.env.ERPNEXT_API_SECRET = "secret";

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      }) as any;

      await erpList("Sales Invoice", "dev-local-session");
      expect(global.fetch).toHaveBeenCalled();

      delete process.env.ERPNEXT_API_KEY;
      delete process.env.ERPNEXT_API_SECRET;
    });
  });

  describe("erpGet", () => {
    it("returns document data on success", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { name: "INV-001", total: 100 } }),
      }) as any;

      const result = await erpGet("Sales Invoice", "INV-001", "sid_123");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveProperty("name", "INV-001");
      }
    });

    it("returns error when data is null", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: null }),
      }) as any;

      const result = await erpGet("Sales Invoice", "MISSING", "sid_123");
      expect(result.ok).toBe(false);
    });
  });

  describe("erpCreate", () => {
    it("creates document", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { name: "INV-002" } }),
      }) as any;

      const result = await erpCreate("Sales Invoice", "sid_123", { customer: "Test" });
      expect(result.ok).toBe(true);
    });
  });

  describe("erpUpdate", () => {
    it("updates document", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { name: "INV-001" } }),
      }) as any;

      const result = await erpUpdate("Sales Invoice", "INV-001", "sid_123", { status: "Paid" });
      expect(result.ok).toBe(true);
    });
  });

  describe("erpDelete", () => {
    it("deletes document", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: "ok" }),
      }) as any;

      const result = await erpDelete("Sales Invoice", "INV-001", "sid_123");
      expect(result.ok).toBe(true);
    });
  });
});
