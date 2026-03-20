import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../erp.service.js", () => ({
  list: vi.fn(),
}));

import { buildDashboardData, formatRelativeTime, EMPTY_DATA } from "../dashboard.service.js";
import { list } from "../erp.service.js";

describe("dashboard.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("formatRelativeTime", () => {
    it("returns empty string for empty input", () => {
      expect(formatRelativeTime("")).toBe("");
    });

    it("formats minutes ago", () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      expect(formatRelativeTime(fiveMinutesAgo)).toMatch(/\dm ago/);
    });

    it("formats hours ago", () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      expect(formatRelativeTime(threeHoursAgo)).toMatch(/\dh ago/);
    });

    it("formats days ago", () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      expect(formatRelativeTime(twoDaysAgo)).toMatch(/\dd ago/);
    });
  });

  describe("buildDashboardData", () => {
    it("returns empty data when all ERP calls fail", async () => {
      (list as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "offline" });

      const result = await buildDashboardData("sid", "acc_1", "Co");
      expect(result).toEqual(EMPTY_DATA);
      expect(result.revenueMTD).toBe(0);
      expect(result.activity).toHaveLength(0);
    });

    it("returns real data when ERP calls succeed", async () => {
      (list as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: true,
          data: [
            {
              name: "INV-001",
              status: "Paid",
              posting_date: new Date().toISOString().slice(0, 10),
              grand_total: 1000,
              modified: new Date().toISOString(),
            },
            {
              name: "INV-002",
              status: "Unpaid",
              posting_date: "2026-01-01",
              grand_total: 500,
              modified: new Date().toISOString(),
            },
          ],
        })
        .mockResolvedValueOnce({ ok: true, data: [{ name: "SO-001" }] })
        .mockResolvedValueOnce({
          ok: true,
          data: [{ name: "EMP-001", status: "Active", date_of_joining: new Date().toISOString().slice(0, 10) }],
        });

      const result = await buildDashboardData("sid", "acc_1", "Co");
      expect(result.isOffline).toBe(false);
      expect(result.revenueMTD).toBeGreaterThanOrEqual(0);
      expect(result.openDealsCount).toBe(1);
      expect(result.employeeCount).toBe(1);
    });

    it("handles partial ERP failures gracefully", async () => {
      (list as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, data: [] }) // invoices ok but empty
        .mockResolvedValueOnce({ ok: false, error: "timeout" }) // orders fail
        .mockResolvedValueOnce({ ok: false, error: "timeout" }); // employees fail

      const result = await buildDashboardData("sid", "acc_1", null);
      expect(result.isOffline).toBe(false);
      expect(result.revenueMTD).toBe(0);
    });
  });
});
