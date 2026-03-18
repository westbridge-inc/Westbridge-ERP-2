import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing module under test
// ---------------------------------------------------------------------------

vi.mock("../../lib/services/session.service.js", () => ({
  validateSession: vi.fn(),
}));

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    account: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("../../lib/redis.js", () => ({
  getRedis: vi.fn().mockReturnValue(null),
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../lib/services/audit.service.js", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/csrf.js", () => ({
  validateCsrf: vi.fn().mockReturnValue(true),
  CSRF_COOKIE_NAME: "westbridge_csrf",
}));

vi.mock("../../lib/api/rate-limit-tiers.js", () => ({
  checkTieredRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  getClientIdentifier: vi.fn().mockReturnValue("test-client"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------
import {
  requireAuth,
  requireActiveSubscription,
  requirePermission,
  requireCsrf,
  toWebRequest,
  rateLimit,
} from "../auth.js";
import { validateSession } from "../../lib/services/session.service.js";
import { validateCsrf as mockValidateCsrf } from "../../lib/csrf.js";
import { getRedis } from "../../lib/redis.js";
import { prisma } from "../../lib/data/prisma.js";

const mockPrisma = prisma as unknown as {
  account: { findUnique: ReturnType<typeof vi.fn> };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    cookies: {},
    headers: {},
    path: "/api/test",
    method: "GET",
    protocol: "http",
    originalUrl: "/api/test",
    get: vi.fn().mockReturnValue("localhost"),
    ip: "127.0.0.1",
    session: undefined,
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    clearCookie: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("Auth Middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── requireAuth ─────────────────────────────────────────────────────────
  describe("requireAuth", () => {
    it("returns 401 when no session cookie is present", async () => {
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();

      await requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: "UNAUTHORIZED" }),
        }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it("returns 401 and clears cookie for malformed token", async () => {
      const req = mockReq({
        cookies: { westbridge_sid: "invalid!@#$%^&*()" },
      });
      const res = mockRes();
      const next = vi.fn();

      await requireAuth(req, res, next);

      expect(res.clearCookie).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it("returns 401 and clears cookie when session validation fails", async () => {
      (validateSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        error: "Session expired",
      });

      const req = mockReq({
        cookies: { westbridge_sid: "valid-token-format" },
      });
      const res = mockRes();
      const next = vi.fn();

      await requireAuth(req, res, next);

      expect(res.clearCookie).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: "SESSION_EXPIRED" }),
        }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it("attaches session data and calls next() on valid session", async () => {
      (validateSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        data: { userId: "usr_1", accountId: "acc_1", role: "owner" },
      });

      const req = mockReq({
        cookies: { westbridge_sid: "valid-token-format" },
      });
      const res = mockRes();
      const next = vi.fn();

      await requireAuth(req, res, next);

      expect(req.session).toEqual({
        userId: "usr_1",
        accountId: "acc_1",
        role: "owner",
      });
      expect(next).toHaveBeenCalled();
    });

    it("returns 500 when validateSession throws", async () => {
      (validateSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB connection failed"));

      const req = mockReq({
        cookies: { westbridge_sid: "valid-token-format" },
      });
      const res = mockRes();
      const next = vi.fn();

      await requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ── requireActiveSubscription ───────────────────────────────────────────
  describe("requireActiveSubscription", () => {
    it("calls next() for exempt billing paths", async () => {
      const req = mockReq({ path: "/api/billing/checkout" });
      const res = mockRes();
      const next = vi.fn();

      await requireActiveSubscription(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("calls next() for exempt auth paths", async () => {
      const req = mockReq({ path: "/api/auth/validate" });
      const res = mockRes();
      const next = vi.fn();

      await requireActiveSubscription(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("calls next() for exempt health paths", async () => {
      const req = mockReq({ path: "/api/health/live" });
      const res = mockRes();
      const next = vi.fn();

      await requireActiveSubscription(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("calls next() when no session is present", async () => {
      const req = mockReq({ session: undefined as unknown as undefined });
      const res = mockRes();
      const next = vi.fn();

      await requireActiveSubscription(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("calls next() when account status is active", async () => {
      mockPrisma.account.findUnique.mockResolvedValue({ status: "active" });

      const req = mockReq({
        path: "/api/erp/list",
        session: { userId: "usr_1", accountId: "acc_1", role: "owner" },
      } as Partial<Request>);
      const res = mockRes();
      const next = vi.fn();

      await requireActiveSubscription(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("returns 403 when account status is past_due", async () => {
      mockPrisma.account.findUnique.mockResolvedValue({ status: "past_due" });

      const req = mockReq({
        path: "/api/erp/list",
        session: { userId: "usr_1", accountId: "acc_1", role: "owner" },
      } as Partial<Request>);
      const res = mockRes();
      const next = vi.fn();

      await requireActiveSubscription(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: "SUBSCRIPTION_EXPIRED" }),
        }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it("returns 403 when account status is suspended", async () => {
      mockPrisma.account.findUnique.mockResolvedValue({ status: "suspended" });

      const req = mockReq({
        path: "/api/erp/list",
        session: { userId: "usr_1", accountId: "acc_1", role: "owner" },
      } as Partial<Request>);
      const res = mockRes();
      const next = vi.fn();

      await requireActiveSubscription(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it("returns 403 when account status is canceled", async () => {
      mockPrisma.account.findUnique.mockResolvedValue({ status: "canceled" });

      const req = mockReq({
        path: "/api/erp/list",
        session: { userId: "usr_1", accountId: "acc_1", role: "owner" },
      } as Partial<Request>);
      const res = mockRes();
      const next = vi.fn();

      await requireActiveSubscription(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it("returns 503 on DB errors (fail-closed)", async () => {
      mockPrisma.account.findUnique.mockRejectedValue(new Error("Connection refused"));

      const req = mockReq({
        path: "/api/erp/list",
        session: { userId: "usr_1", accountId: "acc_1", role: "owner" },
      } as Partial<Request>);
      const res = mockRes();
      const next = vi.fn();

      await requireActiveSubscription(req, res, next);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: "SERVICE_UNAVAILABLE" }),
        }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it("calls next() when account is not found (null status)", async () => {
      mockPrisma.account.findUnique.mockResolvedValue(null);

      const req = mockReq({
        path: "/api/erp/list",
        session: { userId: "usr_1", accountId: "acc_1", role: "owner" },
      } as Partial<Request>);
      const res = mockRes();
      const next = vi.fn();

      await requireActiveSubscription(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("uses Redis cache when available", async () => {
      const mockRedis = {
        get: vi.fn().mockResolvedValue("active"),
        set: vi.fn().mockResolvedValue("OK"),
      };
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);

      const req = mockReq({
        path: "/api/erp/list",
        session: { userId: "usr_1", accountId: "acc_1", role: "owner" },
      } as Partial<Request>);
      const res = mockRes();
      const next = vi.fn();

      await requireActiveSubscription(req, res, next);

      expect(mockRedis.get).toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
      // DB should NOT have been called since cache returned value
      expect(mockPrisma.account.findUnique).not.toHaveBeenCalled();
    });
  });

  // ── requirePermission ──────────────────────────────────────────────────
  describe("requirePermission", () => {
    it("returns 401 when no session exists", async () => {
      const middleware = requirePermission("billing:manage");
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it("returns 403 when role lacks permission", async () => {
      const middleware = requirePermission("billing:manage");
      const req = mockReq({
        path: "/api/billing/manage",
        method: "GET",
        session: { userId: "usr_1", accountId: "acc_1", role: "member" },
        headers: { "x-forwarded-for": "1.2.3.4" },
      } as Partial<Request>);
      const res = mockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it("calls next() when role has permission", async () => {
      const middleware = requirePermission("billing:manage");
      const req = mockReq({
        path: "/api/billing/manage",
        method: "GET",
        session: { userId: "usr_1", accountId: "acc_1", role: "owner" },
        headers: { "x-forwarded-for": "1.2.3.4" },
      } as Partial<Request>);
      const res = mockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  // ── toWebRequest ────────────────────────────────────────────────────────
  describe("toWebRequest", () => {
    it("converts Express request to Web API Request", () => {
      const req = mockReq({
        protocol: "https",
        originalUrl: "/api/health",
        method: "GET",
        headers: { "content-type": "application/json", "x-request-id": "req-123" },
        get: vi.fn().mockReturnValue("example.com"),
      });

      const webReq = toWebRequest(req);

      expect(webReq).toBeInstanceOf(globalThis.Request);
      expect(webReq.method).toBe("GET");
      expect(webReq.headers.get("content-type")).toBe("application/json");
      expect(webReq.headers.get("x-request-id")).toBe("req-123");
    });

    it("handles array headers", () => {
      const req = mockReq({
        headers: { accept: ["text/html", "application/json"] } as Record<string, string | string[]>,
      });

      const webReq = toWebRequest(req);
      expect(webReq.headers.get("accept")).toBe("text/html, application/json");
    });
  });

  // ── requireCsrf ─────────────────────────────────────────────────────────
  describe("requireCsrf", () => {
    it("returns 403 when CSRF token is invalid", () => {
      (mockValidateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const req = mockReq({
        headers: {},
        cookies: {},
      });
      const res = mockRes();
      const next = vi.fn();

      requireCsrf(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it("calls next() when CSRF token is valid", () => {
      (mockValidateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const req = mockReq({
        headers: { "x-csrf-token": "valid-token" },
        cookies: { westbridge_csrf: "valid-token" },
      });
      const res = mockRes();
      const next = vi.fn();

      requireCsrf(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  // ── rateLimit ─────────────────────────────────────────────────────────
  describe("rateLimit", () => {
    it("calls next() when rate limit is not exceeded", async () => {
      const { checkTieredRateLimit } = await import("../../lib/api/rate-limit-tiers.js");
      (checkTieredRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true });

      const middleware = rateLimit("authenticated", "/api/test");
      const req = mockReq({
        session: { userId: "usr_1", accountId: "acc_1", role: "owner" },
      } as Partial<Request>);
      const res = mockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("returns 429 when rate limit is exceeded", async () => {
      const { checkTieredRateLimit } = await import("../../lib/api/rate-limit-tiers.js");
      (checkTieredRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: false });

      const middleware = rateLimit("authenticated", "/api/test");
      const req = mockReq({
        session: { userId: "usr_1", accountId: "acc_1", role: "owner" },
      } as Partial<Request>);
      const res = mockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
