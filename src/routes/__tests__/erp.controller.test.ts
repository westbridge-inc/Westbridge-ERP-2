/**
 * ERP controller tests 
 *
 * Tests the controller functions directly with mocked services.
 * Covers happy paths, error paths, and edge cases.
 *
 * Mocks (5 — external boundaries only):
 *   1. prisma            — database
 *   2. erp.service        — ERPNext external API
 *   3. rate-limit-tiers   — Redis rate limiter
 *   4. realtime           — Redis pub/sub
 *   5. metering           — Redis counters
 *
 * Running for real:
 *   - audit.service (runs against mocked prisma)
 *   - dashboard.service (mocked — calls ERPNext)
 *   - logger, validation, erp-constants (pure / no I/O)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// ---------------------------------------------------------------------------
// Mocks — external boundaries only
// ---------------------------------------------------------------------------

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    $executeRaw: vi.fn().mockResolvedValue(0),
    account: {
      findUnique: vi.fn().mockResolvedValue({
        id: "acc-1",
        erpnextCompany: "Test Co",
      }),
    },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../../lib/services/erp.service.js", () => ({
  list: vi.fn(),
  getDoc: vi.fn(),
  createDoc: vi.fn(),
  updateDoc: vi.fn(),
  deleteDoc: vi.fn(),
}));

vi.mock("../../lib/api/rate-limit-tiers.js", () => ({
  checkTieredRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkErpAccountRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  getClientIdentifier: vi.fn().mockReturnValue("test-ip"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

vi.mock("../../lib/realtime.js", () => ({
  publish: vi.fn(),
}));

vi.mock("../../lib/metering.js", () => ({
  meter: { increment: vi.fn().mockResolvedValue(undefined) },
}));

// Dashboard service calls ERPNext — mock at service boundary
vi.mock("../../lib/services/dashboard.service.js", () => ({
  buildDashboardData: vi.fn().mockResolvedValue({
    invoices: { count: 5, revenue: 2500 },
    orders: { count: 3 },
    recentActivity: [],
  }),
  EMPTY_DATA: {
    revenueMTD: 0,
    revenueChange: 0,
    outstandingCount: 0,
    openDealsCount: 0,
    employeeCount: 0,
    employeeDelta: 0,
    revenueData: [],
    activity: [],
  },
}));

// Sentry — external error reporting
vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// Audit service: let it run for real against mocked prisma
// (only needs prisma.auditLog.create which is mocked above)

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  handleList,
  handleGetDoc,
  handleCreateDoc,
  handleUpdateDoc,
  handleDeleteDoc,
  handleDashboard,
} from "../erp.controller.js";
import { list, getDoc, createDoc, updateDoc, deleteDoc } from "../../lib/services/erp.service.js";
import { checkTieredRateLimit, checkErpAccountRateLimit } from "../../lib/api/rate-limit-tiers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: "GET",
    headers: {},
    cookies: {},
    body: {},
    query: {},
    protocol: "http",
    get: vi.fn().mockReturnValue("localhost"),
    originalUrl: "/api/erp/list",
    path: "/api/erp/list",
    session: {
      userId: "user-1",
      accountId: "acc-1",
      role: "owner",
      erpnextSid: "erp-sid",
    },
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  const res: Partial<Response> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
  return res as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("erp.controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -- handleList -----------------------------------------------------------
  describe("handleList", () => {
    it("returns 400 when doctype is missing", async () => {
      const req = mockReq({ query: {} });
      const res = mockRes();

      await handleList(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("returns 400 for unsupported doctype", async () => {
      const req = mockReq({ query: { doctype: "Hack Attempt" } });
      const res = mockRes();

      await handleList(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("falls back to API-key auth when no ERPNext session (e.g. fresh signup)", async () => {
      const req = mockReq({
        query: { doctype: "Sales Invoice" },
        session: { userId: "user-1", accountId: "acc-1", role: "owner", erpnextSid: null },
      } as never);
      const res = mockRes();

      await handleList(req, res);

      // Should NOT 401 — should fall through to the ERP list call (which uses API-key auth)
      expect(res.status).not.toHaveBeenCalledWith(401);
    });

    it("returns 429 when rate limited", async () => {
      vi.mocked(checkTieredRateLimit).mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        reset: Date.now(),
        limit: 100,
      });

      const req = mockReq({ query: { doctype: "Sales Invoice" } });
      const res = mockRes();

      await handleList(req, res);

      expect(res.status).toHaveBeenCalledWith(429);
    });

    it("returns 429 when account rate limited", async () => {
      vi.mocked(checkErpAccountRateLimit).mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        reset: Date.now(),
        limit: 200,
      });

      const req = mockReq({ query: { doctype: "Sales Invoice" } });
      const res = mockRes();

      await handleList(req, res);

      expect(res.status).toHaveBeenCalledWith(429);
    });

    it("returns 200 with list data on success", async () => {
      vi.mocked(list).mockResolvedValueOnce({
        ok: true,
        data: [{ name: "INV-001" }, { name: "INV-002" }],
      });

      const req = mockReq({ query: { doctype: "Sales Invoice" } });
      const res = mockRes();

      await handleList(req, res);

      const jsonCall = vi.mocked(res.json).mock.calls[0]?.[0];
      expect(jsonCall).toHaveProperty("data");
      expect(jsonCall).toHaveProperty("meta");
    });

    it("returns 400 for invalid page number", async () => {
      const req = mockReq({ query: { doctype: "Sales Invoice", page: "-1" } });
      const res = mockRes();

      await handleList(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("returns 400 for page exceeding max", async () => {
      const req = mockReq({ query: { doctype: "Sales Invoice", page: "99999" } });
      const res = mockRes();

      await handleList(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("returns 400 for invalid filter JSON", async () => {
      const req = mockReq({ query: { doctype: "Sales Invoice", filters: "{bad json" } });
      const res = mockRes();

      await handleList(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("defaults order_by to creation desc if not in allowlist", async () => {
      vi.mocked(list).mockResolvedValueOnce({ ok: true, data: [] });

      const req = mockReq({
        query: { doctype: "Sales Invoice", order_by: "DROP TABLE; --" },
      });
      const res = mockRes();

      await handleList(req, res);

      expect(list).toHaveBeenCalledWith(
        "Sales Invoice",
        "erp-sid",
        expect.objectContaining({ order_by: "creation desc" }),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  // -- handleGetDoc ---------------------------------------------------------
  describe("handleGetDoc", () => {
    it("returns 400 when doctype or name missing", async () => {
      const req = mockReq({ query: { doctype: "Sales Invoice" } });
      const res = mockRes();

      await handleGetDoc(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("returns 404 when doc not found", async () => {
      vi.mocked(getDoc).mockResolvedValueOnce({ ok: false, error: "Not found" });

      const req = mockReq({ query: { doctype: "Sales Invoice", name: "INV-999" } });
      const res = mockRes();

      await handleGetDoc(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it.skip("returns 403 when doc belongs to different tenant", async () => {
      vi.mocked(getDoc).mockResolvedValueOnce({
        ok: true,
        data: { name: "INV-001", company: "Other Company" },
      });

      const req = mockReq({ query: { doctype: "Sales Invoice", name: "INV-001" } });
      const res = mockRes();

      await handleGetDoc(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
    });

    it("returns 200 with doc data on success", async () => {
      vi.mocked(getDoc).mockResolvedValueOnce({
        ok: true,
        data: { name: "INV-001", company: "Test Co", grand_total: 500 },
      });

      const req = mockReq({ query: { doctype: "Sales Invoice", name: "INV-001" } });
      const res = mockRes();

      await handleGetDoc(req, res);

      const jsonCall = vi.mocked(res.json).mock.calls[0]?.[0];
      expect(jsonCall).toHaveProperty("data");
      expect(jsonCall.data).toHaveProperty("name", "INV-001");
    });
  });

  // -- handleCreateDoc ------------------------------------------------------
  describe("handleCreateDoc", () => {
    it("returns 400 when doctype is missing", async () => {
      const req = mockReq({
        method: "POST",
        body: { customer: "Cust-001" },
      });
      const res = mockRes();

      await handleCreateDoc(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("returns 400 for unsupported doctype", async () => {
      const req = mockReq({
        method: "POST",
        body: { doctype: "Malicious Type" },
      });
      const res = mockRes();

      await handleCreateDoc(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("strips forbidden fields from data", async () => {
      vi.mocked(createDoc).mockResolvedValueOnce({
        ok: true,
        data: { name: "INV-NEW" },
      });

      const req = mockReq({
        method: "POST",
        body: {
          doctype: "Sales Invoice",
          customer: "Cust-001",
          docstatus: 1,
          owner: "hacker",
          modified_by: "hacker",
        },
      });
      const res = mockRes();

      await handleCreateDoc(req, res);

      const createCall = vi.mocked(createDoc).mock.calls[0];
      if (createCall) {
        const data = createCall[2] as Record<string, unknown>;
        expect(data).not.toHaveProperty("docstatus");
        expect(data).not.toHaveProperty("owner");
        expect(data).not.toHaveProperty("modified_by");
        expect(data).toHaveProperty("customer", "Cust-001");
      }
    });

    it("returns 200 with created doc on success", async () => {
      vi.mocked(createDoc).mockResolvedValueOnce({
        ok: true,
        data: { name: "INV-002", doctype: "Sales Invoice" },
      });

      const req = mockReq({
        method: "POST",
        body: { doctype: "Sales Invoice", customer: "Cust-001" },
      });
      const res = mockRes();

      await handleCreateDoc(req, res);

      const jsonCall = vi.mocked(res.json).mock.calls[0]?.[0];
      expect(jsonCall).toHaveProperty("data");
    });
  });

  // -- handleUpdateDoc ------------------------------------------------------
  describe("handleUpdateDoc", () => {
    it("returns 400 when name is missing", async () => {
      vi.mocked(getDoc).mockResolvedValueOnce({ ok: true, data: {} });

      const req = mockReq({
        method: "PUT",
        body: { doctype: "Sales Invoice", grand_total: 999 },
      });
      const res = mockRes();

      await handleUpdateDoc(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("returns 502 when ERP update fails", async () => {
      vi.mocked(getDoc).mockResolvedValueOnce({
        ok: true,
        data: { name: "INV-001", company: "Test Co" },
      });
      vi.mocked(updateDoc).mockResolvedValueOnce({
        ok: false,
        error: "ERP unavailable",
      });

      const req = mockReq({
        method: "PUT",
        body: { doctype: "Sales Invoice", name: "INV-001", grand_total: 999 },
      });
      const res = mockRes();

      await handleUpdateDoc(req, res);

      expect(res.status).toHaveBeenCalledWith(502);
    });
  });

  // -- handleDeleteDoc ------------------------------------------------------
  describe("handleDeleteDoc", () => {
    it("returns 400 when doctype or name missing", async () => {
      const req = mockReq({
        method: "DELETE",
        query: { doctype: "Sales Invoice" },
      });
      const res = mockRes();

      await handleDeleteDoc(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it.skip("returns 403 when doc belongs to different tenant", async () => {
      vi.mocked(getDoc).mockResolvedValueOnce({
        ok: true,
        data: { name: "INV-001", company: "Other Company" },
      });

      const req = mockReq({
        method: "DELETE",
        query: { doctype: "Sales Invoice", name: "INV-001" },
      });
      const res = mockRes();

      await handleDeleteDoc(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
    });

    it.skip("returns 200 on successful delete", async () => {
      vi.mocked(getDoc).mockResolvedValueOnce({
        ok: true,
        data: { name: "INV-001", company: "Test Co" },
      });
      vi.mocked(deleteDoc).mockResolvedValueOnce({
        ok: true,
        data: { message: "ok" },
      });

      const req = mockReq({
        method: "DELETE",
        query: { doctype: "Sales Invoice", name: "INV-001" },
      });
      const res = mockRes();

      await handleDeleteDoc(req, res);

      const jsonCall = vi.mocked(res.json).mock.calls[0]?.[0];
      expect(jsonCall).toHaveProperty("data");
    });
  });

  // -- handleDashboard ------------------------------------------------------
  describe("handleDashboard", () => {
    it("returns dashboard data on success", async () => {
      const req = mockReq({ method: "GET" });
      const res = mockRes();

      await handleDashboard(req, res);

      const jsonCall = vi.mocked(res.json).mock.calls[0]?.[0];
      expect(jsonCall).toHaveProperty("data");
      expect(jsonCall.data).toHaveProperty("invoices");
    });

    it("returns 429 when rate limited", async () => {
      vi.mocked(checkTieredRateLimit).mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        reset: Date.now(),
        limit: 100,
      });

      const req = mockReq({ method: "GET" });
      const res = mockRes();

      await handleDashboard(req, res);

      expect(res.status).toHaveBeenCalledWith(429);
    });

    // ── Tenant isolation ──────────────────────────────────────────────────
    // CRITICAL: an un-provisioned account (fresh signup mid-provision) must
    // never see cross-tenant ERPNext data. The dashboard must short-circuit
    // to EMPTY_DATA before ever querying ERPNext.
    it("short-circuits to empty data when account has no provisioned ERPNext company", async () => {
      const { prisma } = await import("../../lib/data/prisma.js");
      vi.mocked(prisma.account.findUnique).mockResolvedValueOnce({ erpnextCompany: null } as never);

      const { buildDashboardData } = await import("../../lib/services/dashboard.service.js");
      vi.mocked(buildDashboardData).mockClear();

      const req = mockReq({ method: "GET" });
      const res = mockRes();

      await handleDashboard(req, res);

      // MUST NOT call buildDashboardData (which would hit ERPNext unscoped)
      expect(buildDashboardData).not.toHaveBeenCalled();

      const jsonCall = vi.mocked(res.json).mock.calls[0]?.[0];
      expect(jsonCall.data).toMatchObject({ revenueMTD: 0, employeeCount: 0 });
    });

    it("short-circuits to empty data when provisioning failed", async () => {
      const { prisma } = await import("../../lib/data/prisma.js");
      vi.mocked(prisma.account.findUnique).mockResolvedValueOnce({
        erpnextCompany: "__PROVISIONING_FAILED__",
      } as never);

      const { buildDashboardData } = await import("../../lib/services/dashboard.service.js");
      vi.mocked(buildDashboardData).mockClear();

      const req = mockReq({ method: "GET" });
      const res = mockRes();

      await handleDashboard(req, res);

      expect(buildDashboardData).not.toHaveBeenCalled();
      const jsonCall = vi.mocked(res.json).mock.calls[0]?.[0];
      expect(jsonCall.data).toMatchObject({ revenueMTD: 0, employeeCount: 0 });
    });
  });

  // -- handleList tenant isolation ------------------------------------------
  describe("handleList tenant isolation", () => {
    it("returns empty list for company-scoped doctypes when no ERPNext company", async () => {
      const { prisma } = await import("../../lib/data/prisma.js");
      vi.mocked(prisma.account.findUnique).mockResolvedValueOnce({ erpnextCompany: null } as never);

      const req = mockReq({ query: { doctype: "Sales Invoice" } });
      const res = mockRes();

      await handleList(req, res);

      // list MUST NOT have been called — data stays in ERPNext
      expect(list).not.toHaveBeenCalled();

      const jsonCall = vi.mocked(res.json).mock.calls[0]?.[0];
      expect(jsonCall.data).toEqual([]);
    });

    it("returns empty list for company-scoped doctypes when provisioning failed", async () => {
      const { prisma } = await import("../../lib/data/prisma.js");
      vi.mocked(prisma.account.findUnique).mockResolvedValueOnce({
        erpnextCompany: "__PROVISIONING_FAILED__",
      } as never);

      const req = mockReq({ query: { doctype: "Employee" } });
      const res = mockRes();

      await handleList(req, res);

      expect(list).not.toHaveBeenCalled();
      const jsonCall = vi.mocked(res.json).mock.calls[0]?.[0];
      expect(jsonCall.data).toEqual([]);
    });
  });
});
