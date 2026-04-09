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
    account: { findUnique: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    // C1 fix: handleLogin now consults totpSecret.verified to decide whether
    // to gate the login behind a TOTP challenge.
    totpSecret: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

// C1 fix: handleLogin consults Redis to store the TOTP challenge.
vi.mock("../../lib/redis.js", () => ({
  getRedis: vi.fn().mockReturnValue({
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(0),
  }),
}));

// Encryption helpers used by handleLogin to AAD-bind the encrypted SID
// stored alongside the TOTP challenge. We mock to identity functions so
// tests do not require ENCRYPTION_KEY to be set.
vi.mock("../../lib/encryption.js", () => ({
  encrypt: vi.fn().mockImplementation((v: string) => `enc(${v})`),
  decrypt: vi.fn().mockImplementation((v: string) => v.replace(/^enc\(/, "").replace(/\)$/, "")),
  ENCRYPTION_CONTEXT: {
    sessionErpnextSid: (uid: string) => `session.erpnextsid:${uid}`,
    totpSecret: (uid: string) => `totp.secret:${uid}`,
  },
}));

// TOTP verification helpers — handleLoginTotp delegates here. We provide a
// minimal stub: any 6-digit code starting with "1" is "valid".
vi.mock("../../lib/totp.js", () => ({
  fromBase32: vi.fn().mockReturnValue(Buffer.from([1, 2, 3])),
  verifyTotp: vi.fn().mockImplementation((_secret: Buffer, code: string) => code.startsWith("1")),
  toBase32: vi.fn().mockReturnValue("AAAAA"),
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
  handleLoginTotp,
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
import { getRedis } from "../../lib/redis.js";

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

  // -------------------------------------------------------------------------
  // C1 regression: 2FA gate at login + handleLoginTotp completion
  //
  // BEFORE THE FIX (audit finding C1, 2026-04-09): handleLogin called
  // createSession() unconditionally on password verification, ignoring
  // totp_secrets.verified. Users who enabled 2FA in settings got ZERO
  // protection — the cookie was set on password alone.
  //
  // AFTER THE FIX: when totpSecret.verified=true, handleLogin returns
  // { step: "totp_required", challengeToken } instead of setting a cookie.
  // The client must POST the challenge + a 6-digit TOTP code or 8-hex
  // backup code to /api/auth/login/totp to actually log in.
  // -------------------------------------------------------------------------
  describe("C1 regression — TOTP enforcement at login", () => {
    function setupSuccessfulPasswordCheck() {
      vi.mocked(prisma.account.findUnique).mockResolvedValueOnce({
        id: "acc-1",
        email: "test@test.com",
        plan: "starter",
        companyName: "Test Co",
      } as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
        id: "user-1",
        accountId: "acc-1",
        email: "test@test.com",
        role: "owner",
        failedLoginAttempts: 0,
        lockedUntil: null,
      } as never);
      vi.mocked(erpLogin).mockResolvedValueOnce({ ok: true, data: "erp-sid-here" });
      vi.mocked(prisma.user.update).mockResolvedValueOnce({} as never);
    }

    it("issues a TOTP challenge instead of a session when user has verified TOTP", async () => {
      setupSuccessfulPasswordCheck();
      // Critical: this is the change. totpSecret.verified=true must
      // short-circuit handleLogin BEFORE createSession is reached.
      vi.mocked(prisma.totpSecret.findUnique).mockResolvedValueOnce({
        verified: true,
      } as never);

      const req = mockReq({ body: { email: "test@test.com", password: "pass123" } });
      const res = mockRes();

      await handleLogin(req, res);

      // No session cookie set — that's the whole point of the fix.
      expect(res.cookie).not.toHaveBeenCalled();
      // createSession must NOT be reached on the gated path.
      expect(createSession).not.toHaveBeenCalled();
      // Response is the totp_required step.
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            step: "totp_required",
            challengeToken: expect.any(String),
          }),
        }),
      );
    });

    it("creates a normal session when user has NO verified TOTP (no regression on the legacy path)", async () => {
      setupSuccessfulPasswordCheck();
      // No TOTP row at all — legacy single-factor login.
      vi.mocked(prisma.totpSecret.findUnique).mockResolvedValueOnce(null);
      vi.mocked(createSession).mockResolvedValueOnce({
        ok: true,
        data: { token: "session-tok", expiresAt: new Date(Date.now() + 60_000) },
      });

      const req = mockReq({ body: { email: "test@test.com", password: "pass123" } });
      const res = mockRes();

      await handleLogin(req, res);

      expect(createSession).toHaveBeenCalledOnce();
      expect(res.cookie).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it("creates a normal session when totpSecret exists but is NOT verified (setup-in-progress)", async () => {
      setupSuccessfulPasswordCheck();
      vi.mocked(prisma.totpSecret.findUnique).mockResolvedValueOnce({
        verified: false,
      } as never);
      vi.mocked(createSession).mockResolvedValueOnce({
        ok: true,
        data: { token: "session-tok", expiresAt: new Date(Date.now() + 60_000) },
      });

      const req = mockReq({ body: { email: "test@test.com", password: "pass123" } });
      const res = mockRes();

      await handleLogin(req, res);

      expect(createSession).toHaveBeenCalledOnce();
      expect(res.cookie).toHaveBeenCalled();
    });

    it("fails CLOSED with 503 when Redis is unavailable for the TOTP challenge", async () => {
      setupSuccessfulPasswordCheck();
      vi.mocked(prisma.totpSecret.findUnique).mockResolvedValueOnce({
        verified: true,
      } as never);
      // Simulate Redis being down — without it we cannot persist the
      // challenge, so the login MUST be refused rather than degraded
      // silently to single-factor.
      vi.mocked(getRedis).mockReturnValueOnce(null as never);

      const req = mockReq({ body: { email: "test@test.com", password: "pass123" } });
      const res = mockRes();

      await handleLogin(req, res);

      expect(createSession).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
    });
  });

  // -- handleLoginTotp -------------------------------------------------------
  describe("handleLoginTotp", () => {
    it("returns 400 on missing challengeToken or code", async () => {
      const req = mockReq({ body: {} });
      const res = mockRes();

      await handleLoginTotp(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("returns 401 when the challenge does not exist in Redis", async () => {
      const fakeRedis = {
        get: vi.fn().mockResolvedValue(null),
        del: vi.fn().mockResolvedValue(0),
        set: vi.fn(),
      };
      vi.mocked(getRedis).mockReturnValueOnce(fakeRedis as never);

      const req = mockReq({ body: { challengeToken: "nope", code: "123456" } });
      const res = mockRes();

      await handleLoginTotp(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("deletes the challenge BEFORE validating the code (single-use brute-force ceiling)", async () => {
      const fakeRedis = {
        get: vi.fn().mockResolvedValue(JSON.stringify({ userId: "user-1", encryptedErpnextSid: null })),
        del: vi.fn().mockResolvedValue(1),
        set: vi.fn(),
      };
      vi.mocked(getRedis).mockReturnValueOnce(fakeRedis as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
        id: "user-1",
        accountId: "acc-1",
        email: "test@test.com",
        role: "owner",
        account: { id: "acc-1" },
      } as never);
      vi.mocked(prisma.totpSecret.findUnique).mockResolvedValueOnce({
        verified: true,
        secret: "enc(SECRET)",
        backupCodes: [],
      } as never);

      // Submit a wrong code (doesn't start with "1" per our test stub).
      const req = mockReq({ body: { challengeToken: "ch-1", code: "999999" } });
      const res = mockRes();

      await handleLoginTotp(req, res);

      // The challenge was consumed regardless of code outcome — this is
      // the single-use guarantee that caps brute force.
      expect(fakeRedis.del).toHaveBeenCalledWith(expect.stringContaining("ch-1"));
      expect(res.status).toHaveBeenCalledWith(401);
      // No session cookie set on failure.
      expect(res.cookie).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
    });

    it("creates the session on a valid TOTP code", async () => {
      const fakeRedis = {
        get: vi.fn().mockResolvedValue(JSON.stringify({ userId: "user-1", encryptedErpnextSid: "enc(erp-sid)" })),
        del: vi.fn().mockResolvedValue(1),
        set: vi.fn(),
      };
      vi.mocked(getRedis).mockReturnValueOnce(fakeRedis as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
        id: "user-1",
        accountId: "acc-1",
        email: "test@test.com",
        role: "owner",
        account: { id: "acc-1" },
      } as never);
      vi.mocked(prisma.totpSecret.findUnique).mockResolvedValueOnce({
        verified: true,
        secret: "enc(SECRET)",
        backupCodes: [],
      } as never);
      vi.mocked(createSession).mockResolvedValueOnce({
        ok: true,
        data: { token: "session-tok", expiresAt: new Date(Date.now() + 60_000) },
      });

      // Code starting with "1" is "valid" per our verifyTotp stub.
      const req = mockReq({ body: { challengeToken: "ch-1", code: "100000" } });
      const res = mockRes();

      await handleLoginTotp(req, res);

      expect(createSession).toHaveBeenCalledOnce();
      expect(res.cookie).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ success: true, usedBackupCode: false }),
        }),
      );
    });

    it("rejects when 2FA was disabled between login and totp completion", async () => {
      const fakeRedis = {
        get: vi.fn().mockResolvedValue(JSON.stringify({ userId: "user-1", encryptedErpnextSid: null })),
        del: vi.fn().mockResolvedValue(1),
        set: vi.fn(),
      };
      vi.mocked(getRedis).mockReturnValueOnce(fakeRedis as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
        id: "user-1",
        accountId: "acc-1",
        email: "test@test.com",
        role: "owner",
        account: { id: "acc-1" },
      } as never);
      // 2FA was disabled in another tab/device since the challenge was issued.
      vi.mocked(prisma.totpSecret.findUnique).mockResolvedValueOnce({
        verified: false,
        secret: "x",
        backupCodes: [],
      } as never);

      const req = mockReq({ body: { challengeToken: "ch-1", code: "100000" } });
      const res = mockRes();

      await handleLoginTotp(req, res);

      expect(createSession).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });
});
