/**
 * Auth controller tests (B3)
 *
 * Tests the controller functions directly with mocked services.
 * Covers happy paths, error paths, and edge cases.
 *
 * Mocks (5 — external boundaries only):
 *   1. prisma              — database
 *   2. auth.service         — ERPNext external login
 *   3. session.service      — Redis session store
 *   4. rate-limit-tiers     — Redis rate limiter
 *   5. password-reset.service — sends email (Resend)
 *
 * Running for real:
 *   - @sentry/node (mocked — external error reporting)
 *   - password-policy (pure validation)
 *   - security-monitor (uses logger + Sentry)
 *   - posthog (no-op without API key)
 *   - audit.service (runs against mocked prisma)
 *   - logger (pino, outputs JSON in test env)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// ---------------------------------------------------------------------------
// Mocks — external boundaries only (5 + Sentry)
// ---------------------------------------------------------------------------

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    $executeRaw: vi.fn().mockResolvedValue(0),
    account: { findUnique: vi.fn() },
    user: { findUnique: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../../lib/services/auth.service.js", () => ({
  login: vi.fn(),
  changePassword: vi.fn(),
}));

vi.mock("../../lib/services/session.service.js", () => ({
  createSession: vi.fn(),
  validateSession: vi.fn(),
  revokeSession: vi.fn(),
}));

vi.mock("../../lib/api/rate-limit-tiers.js", () => ({
  checkTieredRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkEmailRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  getClientIdentifier: vi.fn().mockReturnValue("test-ip"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

vi.mock("../../lib/services/password-reset.service.js", () => ({
  requestPasswordReset: vi.fn().mockResolvedValue({ ok: true }),
  applyPasswordReset: vi.fn(),
}));

// Sentry — external error reporting, no-op in test
vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  handleLogin,
  handleLogout,
  handleValidate,
  handleForgotPassword,
  handleResetPassword,
  handleChangePassword,
} from "../auth.controller.js";
import { prisma } from "../../lib/data/prisma.js";
import { login as erpLogin } from "../../lib/services/auth.service.js";
import { createSession, validateSession, revokeSession } from "../../lib/services/session.service.js";
import { checkTieredRateLimit, checkEmailRateLimit } from "../../lib/api/rate-limit-tiers.js";
import { applyPasswordReset } from "../../lib/services/password-reset.service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: "POST",
    headers: { "content-length": "100" },
    cookies: {},
    body: {},
    protocol: "http",
    get: vi.fn().mockReturnValue("localhost"),
    originalUrl: "/api/auth/login",
    path: "/api/auth/login",
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  const res: Partial<Response> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    cookie: vi.fn().mockReturnThis(),
    clearCookie: vi.fn().mockReturnThis(),
  };
  return res as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auth.controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -- handleLogin ----------------------------------------------------------
  describe("handleLogin", () => {
    it("returns 400 on invalid email", async () => {
      const req = mockReq({ body: { email: "not-email", password: "pass123" } });
      const res = mockRes();

      await handleLogin(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: "VALIDATION_ERROR" }),
        }),
      );
    });

    it("returns 400 on missing password", async () => {
      const req = mockReq({ body: { email: "test@test.com", password: "" } });
      const res = mockRes();

      await handleLogin(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("returns 429 when IP rate limited", async () => {
      vi.mocked(checkTieredRateLimit).mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        reset: Date.now() + 60000,
        limit: 10,
      });

      const req = mockReq({ body: { email: "test@test.com", password: "pass" } });
      const res = mockRes();

      await handleLogin(req, res);

      expect(res.status).toHaveBeenCalledWith(429);
    });

    it("returns 429 when email rate limited", async () => {
      vi.mocked(checkEmailRateLimit).mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        reset: Date.now() + 60000,
        limit: 5,
      });

      const req = mockReq({ body: { email: "test@test.com", password: "pass123" } });
      const res = mockRes();

      await handleLogin(req, res);

      expect(res.status).toHaveBeenCalledWith(429);
    });

    it("returns 401 when account not found", async () => {
      vi.mocked(prisma.account.findUnique).mockResolvedValueOnce(null);

      const req = mockReq({ body: { email: "test@test.com", password: "pass123" } });
      const res = mockRes();

      await handleLogin(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: "AUTH_FAILED" }),
        }),
      );
    });

    it("returns 401 when ERP login fails", async () => {
      vi.mocked(prisma.account.findUnique).mockResolvedValueOnce({
        id: "acc-1",
        email: "test@test.com",
        plan: "starter",
      } as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
        id: "user-1",
        accountId: "acc-1",
        email: "test@test.com",
        role: "owner",
        failedLoginAttempts: 0,
        lockedUntil: null,
      } as never);
      vi.mocked(erpLogin).mockResolvedValueOnce({ ok: false, error: "Invalid credentials" });
      vi.mocked(prisma.user.update).mockResolvedValueOnce({} as never);

      const req = mockReq({ body: { email: "test@test.com", password: "wrongpass" } });
      const res = mockRes();

      await handleLogin(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("returns 423 when account is locked", async () => {
      vi.mocked(prisma.account.findUnique).mockResolvedValueOnce({
        id: "acc-1",
        email: "test@test.com",
      } as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
        id: "user-1",
        accountId: "acc-1",
        email: "test@test.com",
        role: "owner",
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() + 600_000),
      } as never);

      const req = mockReq({ body: { email: "test@test.com", password: "pass123" } });
      const res = mockRes();

      await handleLogin(req, res);

      expect(res.status).toHaveBeenCalledWith(423);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: "ACCOUNT_LOCKED" }),
        }),
      );
    });

    it("returns 200 and sets cookie on successful login", async () => {
      vi.mocked(prisma.account.findUnique).mockResolvedValueOnce({
        id: "acc-1",
        email: "test@test.com",
        plan: "starter",
        companyName: "Co",
      } as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
        id: "user-1",
        accountId: "acc-1",
        email: "test@test.com",
        role: "owner",
        failedLoginAttempts: 0,
        lockedUntil: null,
      } as never);
      vi.mocked(erpLogin).mockResolvedValueOnce({ ok: true, data: "erp-sid" });
      vi.mocked(prisma.user.update).mockResolvedValueOnce({} as never);
      vi.mocked(createSession).mockResolvedValueOnce({
        ok: true,
        data: { token: "session-tok", expiresAt: new Date(Date.now() + 86400000) },
      });

      const req = mockReq({ body: { email: "test@test.com", password: "pass123" } });
      const res = mockRes();

      await handleLogin(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.cookie).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { success: true },
        }),
      );
    });

    it("returns 413 when body too large", async () => {
      const req = mockReq({
        body: { email: "test@test.com", password: "pass" },
        headers: { "content-length": "2000000" },
      });
      const res = mockRes();

      await handleLogin(req, res);

      expect(res.status).toHaveBeenCalledWith(413);
    });

    it("returns 500 on session creation failure", async () => {
      vi.mocked(prisma.account.findUnique).mockResolvedValueOnce({
        id: "acc-1",
        email: "test@test.com",
        plan: "starter",
        companyName: "Co",
      } as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
        id: "user-1",
        accountId: "acc-1",
        email: "test@test.com",
        role: "owner",
        failedLoginAttempts: 0,
        lockedUntil: null,
      } as never);
      vi.mocked(erpLogin).mockResolvedValueOnce({ ok: true, data: "erp-sid" });
      vi.mocked(prisma.user.update).mockResolvedValueOnce({} as never);
      vi.mocked(createSession).mockResolvedValueOnce({
        ok: false,
        error: "Redis unavailable",
      });

      const req = mockReq({ body: { email: "test@test.com", password: "pass123" } });
      const res = mockRes();

      await handleLogin(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // -- handleLogout ---------------------------------------------------------
  describe("handleLogout", () => {
    it("clears cookies and returns success", async () => {
      vi.mocked(validateSession).mockResolvedValueOnce({
        ok: true,
        data: { userId: "user-1", accountId: "acc-1", role: "owner" },
      });

      const req = mockReq({ cookies: { westbridge_sid: "valid-token" } });
      const res = mockRes();

      await handleLogout(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.clearCookie).toHaveBeenCalled();
      expect(revokeSession).toHaveBeenCalledWith("valid-token");
    });

    it("returns success even without session cookie", async () => {
      const req = mockReq({ cookies: {} });
      const res = mockRes();

      await handleLogout(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // -- handleValidate -------------------------------------------------------
  describe("handleValidate", () => {
    it("returns 401 without session cookie", async () => {
      const req = mockReq({ method: "GET", cookies: {} });
      const res = mockRes();

      await handleValidate(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("returns 401 when session is invalid", async () => {
      vi.mocked(validateSession).mockResolvedValueOnce({
        ok: false,
        error: "Session expired",
      });

      const req = mockReq({ method: "GET", cookies: { westbridge_sid: "expired-token" } });
      const res = mockRes();

      await handleValidate(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("returns 200 with user data when valid", async () => {
      vi.mocked(validateSession).mockResolvedValueOnce({
        ok: true,
        data: { userId: "user-1", accountId: "acc-1", role: "owner" },
      });
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
        name: "Test User",
        email: "test@test.com",
      } as never);

      const req = mockReq({ method: "GET", cookies: { westbridge_sid: "valid-token" } });
      const res = mockRes();

      await handleValidate(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "user-1",
            accountId: "acc-1",
            role: "owner",
          }),
        }),
      );
    });
  });

  // -- handleForgotPassword -------------------------------------------------
  describe("handleForgotPassword", () => {
    it("returns 200 even with invalid email (no enumeration)", async () => {
      const req = mockReq({ body: { email: "notreal@test.com" } });
      const res = mockRes();

      await handleForgotPassword(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it("returns 400 on missing email", async () => {
      const req = mockReq({ body: {} });
      const res = mockRes();

      await handleForgotPassword(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("returns 200 when rate limited (no timing leak)", async () => {
      vi.mocked(checkTieredRateLimit).mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        reset: Date.now(),
        limit: 10,
      });

      const req = mockReq({ body: { email: "test@test.com" } });
      const res = mockRes();

      await handleForgotPassword(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // -- handleResetPassword --------------------------------------------------
  describe("handleResetPassword", () => {
    it("returns 400 on missing token", async () => {
      const req = mockReq({ body: { password: "newpass123" } });
      const res = mockRes();

      await handleResetPassword(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("returns 200 on successful reset", async () => {
      vi.mocked(applyPasswordReset).mockResolvedValueOnce({ ok: true, data: { success: true } });

      const req = mockReq({ body: { token: "valid-tok", password: "StrongP@ss123" } });
      const res = mockRes();

      await handleResetPassword(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it("returns 400 on failed reset (expired token)", async () => {
      vi.mocked(applyPasswordReset).mockResolvedValueOnce({
        ok: false,
        error: "Token expired",
      });

      const req = mockReq({ body: { token: "expired-tok", password: "StrongP@ss123" } });
      const res = mockRes();

      await handleResetPassword(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  // -- handleChangePassword -------------------------------------------------
  describe("handleChangePassword", () => {
    it("returns 401 without session", async () => {
      const req = mockReq({ cookies: {} });
      const res = mockRes();

      await handleChangePassword(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("returns 400 on missing fields", async () => {
      vi.mocked(validateSession).mockResolvedValueOnce({
        ok: true,
        data: { userId: "user-1", accountId: "acc-1", role: "owner" },
      });

      const req = mockReq({
        cookies: { westbridge_sid: "valid-tok" },
        body: { currentPassword: "", newPassword: "" },
      });
      const res = mockRes();

      await handleChangePassword(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });
});
