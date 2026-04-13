/**
 * Comprehensive tests for session.service.ts — the most security-critical service.
 * Covers: createSession, validateSession, revokeSession, edge cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE any imports that use the mocked modules.
// ---------------------------------------------------------------------------

vi.mock("../../data/prisma-admin.js", () => ({
  prismaAdmin: {
    session: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    $executeRaw: vi.fn().mockResolvedValue(0),
    $transaction: vi.fn, // tests set their own implementation per case
  },
}));

const mockRedisPipeline = {
  sadd: vi.fn().mockReturnThis(),
  expire: vi.fn().mockReturnThis(),
  del: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue([]),
};

const mockRedis = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue("OK"),
  del: vi.fn().mockResolvedValue(1),
  pipeline: vi.fn().mockReturnValue(mockRedisPipeline),
  smembers: vi.fn().mockResolvedValue([]),
};

vi.mock("../../redis.js", () => ({
  getRedis: vi.fn().mockReturnValue(null),
}));

vi.mock("../audit.service.js", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  auditContext: vi.fn().mockReturnValue({ ipAddress: "127.0.0.1", userAgent: "test-agent" }),
}));

vi.mock("../../security-monitor.js", () => ({
  reportSecurityEvent: vi.fn(),
}));

vi.mock("../../encryption.js", () => ({
  encrypt: vi.fn().mockImplementation((v: string) => `encrypted:${v}`),
  decrypt: vi.fn().mockImplementation((v: string) => v.replace("encrypted:", "")),
  ENCRYPTION_CONTEXT: {
    totpSecret: (userId: string) => `totp.secret:${userId}`,
    ssoClientSecret: (accountId: string) => `sso.clientSecret:${accountId}`,
    sessionErpnextSid: (userId: string) => `session.erpnextSid:${userId}`,
    webhookSecret: (endpointId: string) => `webhook.secret:${endpointId}`,
  },
}));

vi.mock("../../logger.js", () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------
import {
  createSession,
  validateSession,
  revokeSession,
  revokeAllUserSessions,
  deleteExpiredSessions,
} from "../session.service.js";
import { prismaAdmin } from "../../data/prisma-admin.js";
import { getRedis } from "../../redis.js";
import { reportSecurityEvent } from "../../security-monitor.js";
import { logAudit } from "../audit.service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hash a raw token using SHA-256 — mirrors the internal hashToken function. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Create a minimal mock Request object with optional headers. */
function mockRequest(
  opts: {
    ip?: string;
    userAgent?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (opts.ip) headers.set("x-forwarded-for", opts.ip);
  if (opts.userAgent) headers.set("user-agent", opts.userAgent);
  return { headers } as unknown as Request;
}

const DEFAULT_USER = {
  id: "usr_1",
  accountId: "acc_1",
  email: "user@test.com",
  role: "owner",
  name: "Test User",
  account: { id: "acc_1", companyName: "Test Corp", plan: "starter" },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Session Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00.000Z"));
    // Default: Redis not available
    (getRedis as ReturnType<typeof vi.fn>).mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // createSession
  // =========================================================================
  describe("createSession()", () => {
    it("creates a session token that is base64url encoded and at least 32 bytes", async () => {
      // Setup: transaction passthrough
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (fn: (tx: typeof prismaAdmin) => Promise<void>) => fn(prismaAdmin),
      );
      (prismaAdmin.session.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prismaAdmin.session.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prismaAdmin.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_USER);

      const req = mockRequest({ ip: "192.168.1.100", userAgent: "TestBrowser/1.0" });
      const result = await createSession("usr_1", req);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");

      const raw = result.data.token;
      // base64url characters only
      expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
      // 32 bytes = ~43 base64url characters
      const decoded = Buffer.from(raw, "base64url");
      expect(decoded.length).toBeGreaterThanOrEqual(32);
    });

    it("stores only the SHA-256 hash in DB, never the raw token", async () => {
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (fn: (tx: typeof prismaAdmin) => Promise<void>) => fn(prismaAdmin),
      );
      (prismaAdmin.session.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prismaAdmin.session.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prismaAdmin.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_USER);

      const req = mockRequest({ ip: "10.0.0.1", userAgent: "TestBrowser/1.0" });
      const result = await createSession("usr_1", req);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");

      const rawToken = result.data.token;
      const expectedHash = hashToken(rawToken);

      // Verify the token stored in DB is the hash, not the raw token
      const createCall = (prismaAdmin.session.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.data.token).toBe(expectedHash);
      expect(createCall.data.token).not.toBe(rawToken);
    });

    it("enforces max concurrent sessions (5) by deleting the oldest when exceeded", async () => {
      const existingSessions = Array.from({ length: 5 }, (_, i) => ({
        id: `sess_${i}`,
        userId: "usr_1",
        token: `hash_${i}`,
        expiresAt: new Date(Date.now() + 86400000),
        lastActiveAt: new Date(Date.now - (5 - i) * 60000), // oldest first
      }));

      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (fn: (tx: typeof prismaAdmin) => Promise<void>) => fn(prismaAdmin),
      );
      (prismaAdmin.session.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(existingSessions);
      (prismaAdmin.session.delete as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prismaAdmin.session.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prismaAdmin.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_USER);

      const req = mockRequest({ ip: "10.0.0.1", userAgent: "TestBrowser/1.0" });
      const result = await createSession("usr_1", req);

      expect(result.ok).toBe(true);
      // The oldest session (sess_0) should have been deleted
      expect(prismaAdmin.session.delete).toHaveBeenCalledWith({ where: { id: "sess_0" } });
      // A new session should have been created
      expect(prismaAdmin.session.create).toHaveBeenCalled();
    });

    it("does NOT delete sessions when below the max limit", async () => {
      const existingSessions = Array.from({ length: 3 }, (_, i) => ({
        id: `sess_${i}`,
        userId: "usr_1",
        token: `hash_${i}`,
        expiresAt: new Date(Date.now() + 86400000),
        lastActiveAt: new Date(Date.now - i * 60000),
      }));

      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (fn: (tx: typeof prismaAdmin) => Promise<void>) => fn(prismaAdmin),
      );
      (prismaAdmin.session.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(existingSessions);
      (prismaAdmin.session.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prismaAdmin.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_USER);

      const req = mockRequest({ ip: "10.0.0.1", userAgent: "TestBrowser/1.0" });
      const result = await createSession("usr_1", req);

      expect(result.ok).toBe(true);
      expect(prismaAdmin.session.delete).not.toHaveBeenCalled();
    });

    it("returns a Result with the raw token and expiresAt date", async () => {
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (fn: (tx: typeof prismaAdmin) => Promise<void>) => fn(prismaAdmin),
      );
      (prismaAdmin.session.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prismaAdmin.session.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prismaAdmin.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_USER);

      const req = mockRequest({ ip: "10.0.0.1", userAgent: "TestBrowser/1.0" });
      const result = await createSession("usr_1", req);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");
      expect(typeof result.data.token).toBe("string");
      expect(result.data.token.length).toBeGreaterThan(0);
      expect(result.data.expiresAt).toBeInstanceOf(Date);
      // Expires 7 days from now
      const expectedExpiry = new Date(Date.now + 7 * 24 * 60 * 60 * 1000);
      expect(result.data.expiresAt.getTime()).toBe(expectedExpiry.getTime());
    });

    it("handles DB errors gracefully and returns err Result", async () => {
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB connection failed"));

      const req = mockRequest({ ip: "10.0.0.1", userAgent: "TestBrowser/1.0" });
      const result = await createSession("usr_1", req);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected error");
      expect(result.error).toBe("Unable to create your session. Please try again.");
    });

    it("registers session in Redis user index when Redis is available", async () => {
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (fn: (tx: typeof prismaAdmin) => Promise<void>) => fn(prismaAdmin),
      );
      (prismaAdmin.session.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prismaAdmin.session.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prismaAdmin.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_USER);

      const req = mockRequest({ ip: "10.0.0.1", userAgent: "TestBrowser/1.0" });
      const result = await createSession("usr_1", req);

      expect(result.ok).toBe(true);
      expect(mockRedis.pipeline).toHaveBeenCalled();
      expect(mockRedisPipeline.sadd).toHaveBeenCalled();
      expect(mockRedisPipeline.expire).toHaveBeenCalled();
      expect(mockRedisPipeline.exec).toHaveBeenCalled();
    });

    it("sets the session expiresAt to 7 days from creation", async () => {
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (fn: (tx: typeof prismaAdmin) => Promise<void>) => fn(prismaAdmin),
      );
      (prismaAdmin.session.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prismaAdmin.session.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prismaAdmin.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_USER);

      const req = mockRequest({ ip: "10.0.0.1", userAgent: "TestBrowser/1.0" });
      await createSession("usr_1", req);

      const createCall = (prismaAdmin.session.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(createCall.data.expiresAt.getTime()).toBe(Date.now() + sevenDaysMs);
    });

    it("encrypts erpnextSid before storing in DB", async () => {
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (fn: (tx: typeof prismaAdmin) => Promise<void>) => fn(prismaAdmin),
      );
      (prismaAdmin.session.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prismaAdmin.session.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prismaAdmin.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_USER);

      const req = mockRequest({ ip: "10.0.0.1", userAgent: "TestBrowser/1.0" });
      await createSession("usr_1", req, "erp-session-123");

      const createCall = (prismaAdmin.session.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.data.erpnextSid).toBe("encrypted:erp-session-123");
    });

    it("emits an audit log on successful session creation", async () => {
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (fn: (tx: typeof prismaAdmin) => Promise<void>) => fn(prismaAdmin),
      );
      (prismaAdmin.session.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prismaAdmin.session.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prismaAdmin.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_USER);

      const req = mockRequest({ ip: "10.0.0.1", userAgent: "TestBrowser/1.0" });
      await createSession("usr_1", req);

      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "acc_1",
          userId: "usr_1",
          action: "auth.session.created",
          severity: "info",
          outcome: "success",
        }),
      );
    });
  });

  // =========================================================================
  // validateSession
  // =========================================================================
  describe("validateSession()", () => {
    const now = new Date("2026-03-11T12:00:00.000Z");

    function makeDbSession(overrides: Record<string, unknown> = {}) {
      return {
        id: "sess_1",
        userId: "usr_1",
        token: "some-hash",
        erpnextSid: null,
        ipAddress: "10.0.0.1",
        userAgent: "TestBrowser/1.0",
        fingerprint: null,
        expiresAt: new Date(now.getTime + 7 * 24 * 60 * 60 * 1000), // 7 days ahead
        lastActiveAt: new Date(now.getTime - 60000), // 1 minute ago
        createdAt: new Date(now.getTime - 3600000), // 1 hour ago
        user: {
          id: "usr_1",
          accountId: "acc_1",
          role: "owner",
          account: { id: "acc_1" },
        },
        ...overrides,
      };
    }

    it("returns ok=true with session data for a valid token", async () => {
      const session = makeDbSession();
      (prismaAdmin.session.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(session);
      (prismaAdmin.session.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await validateSession("valid-raw-token");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");
      expect(result.data.userId).toBe("usr_1");
      expect(result.data.accountId).toBe("acc_1");
      expect(result.data.role).toBe("owner");
    });

    it("hashes the token before looking up in DB", async () => {
      const rawToken = "my-raw-token-123";
      const expectedHash = hashToken(rawToken);
      (prismaAdmin.session.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await validateSession(rawToken);

      expect(prismaAdmin.session.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { token: expectedHash },
        }),
      );
    });

    it("returns ok=false for expired sessions (>7 days)", async () => {
      const session = makeDbSession({
        expiresAt: new Date(now.getTime - 1000), // expired 1 second ago
      });
      (prismaAdmin.session.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(session);
      (prismaAdmin.session.delete as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await validateSession("expired-token");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected error");
      expect(result.error).toBe("Session expired");
    });

    it("returns ok=false for idle sessions (>30 min since last activity)", async () => {
      const thirtyOneMinutesAgo = new Date(now.getTime - 31 * 60 * 1000);
      const session = makeDbSession({
        lastActiveAt: thirtyOneMinutesAgo,
        createdAt: new Date(now.getTime - 2 * 60 * 60 * 1000), // 2 hours ago
      });
      (prismaAdmin.session.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(session);
      (prismaAdmin.session.delete as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await validateSession("idle-token");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected error");
      expect(result.error).toBe("Session expired");
    });

    it("allows sessions active within the 30 min window", async () => {
      const twentyMinutesAgo = new Date(now.getTime - 20 * 60 * 1000);
      const session = makeDbSession({
        lastActiveAt: twentyMinutesAgo,
      });
      (prismaAdmin.session.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(session);
      (prismaAdmin.session.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await validateSession("active-token");

      expect(result.ok).toBe(true);
    });

    it("updates lastActiveAt on successful validation when stale", async () => {
      // lastActiveAt is more than 60s ago, so should trigger update
      const twoMinutesAgo = new Date(now.getTime - 2 * 60 * 1000);
      const session = makeDbSession({
        lastActiveAt: twoMinutesAgo,
      });
      (prismaAdmin.session.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(session);
      (prismaAdmin.session.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await validateSession("valid-token");

      expect(prismaAdmin.session.update).toHaveBeenCalledWith({
        where: { id: "sess_1" },
        data: { lastActiveAt: now },
      });
    });

    it("does NOT update lastActiveAt when recently updated (<60s)", async () => {
      // lastActiveAt is only 30 seconds ago — within the 60s debounce interval
      const thirtySecondsAgo = new Date(now.getTime - 30 * 1000);
      const session = makeDbSession({
        lastActiveAt: thirtySecondsAgo,
      });
      (prismaAdmin.session.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(session);

      await validateSession("valid-token");

      expect(prismaAdmin.session.update).not.toHaveBeenCalled();
    });

    it("returns ok=false for invalid/non-existent tokens", async () => {
      (prismaAdmin.session.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await validateSession("non-existent-token");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected error");
      expect(result.error).toBe("Invalid session");
    });

    it("returns ok=false for empty token", async () => {
      const result = await validateSession("");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected error");
      expect(result.error).toBe("Missing token");
    });

    it("returns ok=false for whitespace-only token", async () => {
      const result = await validateSession("   ");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected error");
      expect(result.error).toBe("Missing token");
    });

    it("handles fingerprint mismatch and reports security event (DB path)", async () => {
      const fingerprint = createHash("sha256").update("TestBrowser/1.0|10.0.0", "utf8").digest("hex");
      const session = makeDbSession({
        fingerprint,
      });
      (prismaAdmin.session.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(session);

      // Request with a different user-agent => different fingerprint
      const req = mockRequest({ ip: "10.0.0.1", userAgent: "DifferentBrowser/2.0" });
      const result = await validateSession("hijacked-token", req);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected error");
      expect(result.error).toBe("Invalid session");
      expect(reportSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "session_hijack",
          userId: "usr_1",
          details: expect.stringContaining("fingerprint mismatch"),
        }),
      );
    });

    it("allows request with matching fingerprint (DB path)", async () => {
      const ua = "TestBrowser/1.0";
      const ipPrefix = "10.0.0";
      const fingerprint = createHash("sha256").update(`${ua}|${ipPrefix}`, "utf8").digest("hex");
      const session = makeDbSession({
        fingerprint,
        lastActiveAt: new Date(now.getTime - 2 * 60 * 1000),
      });
      (prismaAdmin.session.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(session);
      (prismaAdmin.session.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const req = mockRequest({ ip: "10.0.0.50", userAgent: ua });
      const result = await validateSession("valid-token", req);

      expect(result.ok).toBe(true);
      expect(reportSecurityEvent).not.toHaveBeenCalled();
    });

    it("caches session in Redis after successful DB validation", async () => {
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);
      mockRedis.get.mockResolvedValue(null); // cache miss

      const session = makeDbSession({
        lastActiveAt: new Date(now.getTime - 2 * 60 * 1000),
      });
      (prismaAdmin.session.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(session);
      (prismaAdmin.session.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await validateSession("cacheable-token");

      expect(result.ok).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith(expect.stringContaining("session:v1:"), expect.any(String), "EX", 30);

      // Verify the cached data includes security fields
      const cachedJson = mockRedis.set.mock.calls[0][1];
      const cached = JSON.parse(cachedJson);
      expect(cached).toHaveProperty("userId", "usr_1");
      expect(cached).toHaveProperty("accountId", "acc_1");
      expect(cached).toHaveProperty("expiresAt");
      expect(cached).toHaveProperty("lastActiveAt");
      expect(cached).toHaveProperty("fingerprint");
    });

    it("returns cached session from Redis on subsequent calls", async () => {
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);

      const cachedData = {
        userId: "usr_1",
        accountId: "acc_1",
        role: "owner",
        erpnextSid: null,
        expiresAt: now.getTime + 7 * 24 * 60 * 60 * 1000,
        lastActiveAt: now.getTime - 60000, // 1 min ago (within idle timeout)
        fingerprint: null,
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedData));

      const result = await validateSession("cached-token");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");
      expect(result.data.userId).toBe("usr_1");
      expect(result.data.accountId).toBe("acc_1");
      expect(result.data.role).toBe("owner");
      // Should NOT have queried the DB
      expect(prismaAdmin.session.findUnique).not.toHaveBeenCalled();
    });

    it("validates expiry even on cached session (does not bypass)", async () => {
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);

      const cachedData = {
        userId: "usr_1",
        accountId: "acc_1",
        role: "owner",
        expiresAt: now.getTime - 1000, // expired
        lastActiveAt: now.getTime() - 60000,
        fingerprint: null,
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedData));

      const result = await validateSession("expired-cached-token");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected error");
      expect(result.error).toBe("Session expired");
    });

    it("validates idle timeout even on cached session", async () => {
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);

      const cachedData = {
        userId: "usr_1",
        accountId: "acc_1",
        role: "owner",
        expiresAt: now.getTime + 7 * 24 * 60 * 60 * 1000,
        lastActiveAt: now.getTime - 31 * 60 * 1000, // 31 min ago => idle
        fingerprint: null,
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedData));

      const result = await validateSession("idle-cached-token");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected error");
      expect(result.error).toBe("Session expired");
    });

    it("validates fingerprint on cached session and reports security event on mismatch", async () => {
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);

      const storedFingerprint = createHash("sha256").update("Original/1.0|10.0.0", "utf8").digest("hex");
      const cachedData = {
        userId: "usr_1",
        accountId: "acc_1",
        role: "owner",
        expiresAt: now.getTime + 7 * 24 * 60 * 60 * 1000,
        lastActiveAt: now.getTime() - 60000,
        fingerprint: storedFingerprint,
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedData));

      const req = mockRequest({ ip: "10.0.0.1", userAgent: "Hijacker/1.0" });
      const result = await validateSession("hijacked-cached-token", req);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected error");
      expect(result.error).toBe("Invalid session");
      expect(reportSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "session_hijack",
          details: expect.stringContaining("cache hit path"),
        }),
      );
    });

    it("decrypts erpnextSid from DB on validation", async () => {
      const session = makeDbSession({
        erpnextSid: "encrypted:erp-session-xyz",
        lastActiveAt: new Date(now.getTime - 2 * 60 * 1000),
      });
      (prismaAdmin.session.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(session);
      (prismaAdmin.session.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await validateSession("token-with-erp-sid");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");
      expect(result.data.erpnextSid).toBe("erp-session-xyz");
    });

    it("defaults to 'member' role for unknown roles", async () => {
      const session = makeDbSession();
      session.user.role = "superadmin"; // Not in the allowed list
      (prismaAdmin.session.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(session);
      (prismaAdmin.session.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await validateSession("unknown-role-token");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");
      expect(result.data.role).toBe("member");
    });

    it("handles DB errors gracefully", async () => {
      (prismaAdmin.session.findUnique as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB timeout"));

      const result = await validateSession("error-token");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected error");
      expect(result.error).toBe("Your session could not be verified. Please log in again.");
    });

    it("deletes expired session from DB on validation (cleanup)", async () => {
      const session = makeDbSession({
        expiresAt: new Date(now.getTime() - 5000),
      });
      (prismaAdmin.session.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(session);
      (prismaAdmin.session.delete as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const req = mockRequest({ ip: "10.0.0.1", userAgent: "Test/1.0" });
      await validateSession("expired-cleanup-token", req);

      expect(prismaAdmin.session.delete).toHaveBeenCalledWith({
        where: { id: "sess_1" },
      });
    });
  });

  // =========================================================================
  // revokeSession
  // =========================================================================
  describe("revokeSession()", () => {
    it("deletes session from DB by token hash", async () => {
      (prismaAdmin.session.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const rawToken = "token-to-revoke";
      const expectedHash = hashToken(rawToken);
      const result = await revokeSession(rawToken);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");
      expect(result.data.revoked).toBe(true);
      expect(prismaAdmin.session.deleteMany).toHaveBeenCalledWith({
        where: { token: expectedHash },
      });
    });

    it("clears Redis cache on revocation", async () => {
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);
      (prismaAdmin.session.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const rawToken = "token-to-revoke-with-cache";
      const expectedHash = hashToken(rawToken);
      await revokeSession(rawToken);

      expect(mockRedis.del).toHaveBeenCalledWith(`session:v1:${expectedHash}`);
    });

    it("returns ok=true with revoked=true on success", async () => {
      (prismaAdmin.session.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const result = await revokeSession("existing-token");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");
      expect(result.data.revoked).toBe(true);
    });

    it("returns ok=true with revoked=false if session doesn't exist", async () => {
      (prismaAdmin.session.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

      const result = await revokeSession("non-existent-token");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");
      expect(result.data.revoked).toBe(false);
    });

    it("returns ok=true with revoked=false for empty token", async () => {
      const result = await revokeSession("");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");
      expect(result.data.revoked).toBe(false);
      expect(prismaAdmin.session.deleteMany).not.toHaveBeenCalled();
    });

    it("returns ok=true with revoked=false on DB error (graceful)", async () => {
      (prismaAdmin.session.deleteMany as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB failure"));

      const result = await revokeSession("error-token");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");
      expect(result.data.revoked).toBe(false);
    });

    it("emits audit log when audit context is provided and session existed", async () => {
      (prismaAdmin.session.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const req = mockRequest({ ip: "10.0.0.1", userAgent: "TestBrowser/1.0" });
      await revokeSession("revoke-with-audit", {
        userId: "usr_1",
        accountId: "acc_1",
        reason: "user_logout",
        request: req,
      });

      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "acc_1",
          userId: "usr_1",
          action: "auth.session.revoked",
          severity: "info",
          outcome: "success",
        }),
      );
    });

    it("does NOT emit audit log when session did not exist (count=0)", async () => {
      (prismaAdmin.session.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

      await revokeSession("no-such-token", {
        userId: "usr_1",
        accountId: "acc_1",
      });

      expect(logAudit).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  describe("Edge cases", () => {
    it("Redis unavailable falls back to DB for validateSession", async () => {
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const session = {
        id: "sess_1",
        userId: "usr_1",
        token: "hash",
        erpnextSid: null,
        fingerprint: null,
        expiresAt: new Date(Date.now + 7 * 24 * 60 * 60 * 1000),
        lastActiveAt: new Date(Date.now - 2 * 60 * 1000),
        createdAt: new Date(Date.now() - 3600000),
        user: { id: "usr_1", accountId: "acc_1", role: "owner", account: { id: "acc_1" } },
      };
      (prismaAdmin.session.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(session);
      (prismaAdmin.session.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await validateSession("no-redis-token");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");
      expect(result.data.userId).toBe("usr_1");
      // DB was queried directly
      expect(prismaAdmin.session.findUnique).toHaveBeenCalled();
    });

    it("Redis cache read error falls back to DB", async () => {
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);
      mockRedis.get.mockRejectedValue(new Error("Redis connection refused"));

      const session = {
        id: "sess_1",
        userId: "usr_1",
        token: "hash",
        erpnextSid: null,
        fingerprint: null,
        expiresAt: new Date(Date.now + 7 * 24 * 60 * 60 * 1000),
        lastActiveAt: new Date(Date.now - 2 * 60 * 1000),
        createdAt: new Date(Date.now() - 3600000),
        user: { id: "usr_1", accountId: "acc_1", role: "owner", account: { id: "acc_1" } },
      };
      (prismaAdmin.session.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(session);
      (prismaAdmin.session.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await validateSession("redis-error-token");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");
      expect(result.data.userId).toBe("usr_1");
      expect(prismaAdmin.session.findUnique).toHaveBeenCalled();
    });

    it("concurrent session limit uses transaction for race condition protection", async () => {
      let transactionCalled = false;
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (fn: (tx: typeof prismaAdmin) => Promise<void>) => {
          transactionCalled = true;
          return fn(prismaAdmin);
        },
      );
      (prismaAdmin.session.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prismaAdmin.session.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prismaAdmin.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_USER);

      const req = mockRequest({ ip: "10.0.0.1", userAgent: "TestBrowser/1.0" });
      await createSession("usr_1", req);

      expect(transactionCalled).toBe(true);
    });

    it("token hashing is deterministic (same input = same hash)", () => {
      const token = "deterministic-token-value";
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);
      expect(hash1).toBe(hash2);
      // And it is a valid SHA-256 hex string (64 chars)
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it("different tokens produce different hashes", () => {
      const hash1 = hashToken("token-a");
      const hash2 = hashToken("token-b");
      expect(hash1).not.toBe(hash2);
    });

    it("revokeSession gracefully handles Redis being unavailable", async () => {
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (prismaAdmin.session.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const result = await revokeSession("token-no-redis");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");
      expect(result.data.revoked).toBe(true);
    });

    it("createSession includes fingerprint from request in stored session", async () => {
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (fn: (tx: typeof prismaAdmin) => Promise<void>) => fn(prismaAdmin),
      );
      (prismaAdmin.session.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prismaAdmin.session.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prismaAdmin.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_USER);

      const ua = "TestBrowser/1.0";
      const ip = "192.168.1.100";
      const expectedPrefix = ip.split(".").slice(0, 3).join(".");
      const expectedFingerprint = createHash("sha256").update(`${ua}|${expectedPrefix}`, "utf8").digest("hex");

      const req = mockRequest({ ip, userAgent: ua });
      await createSession("usr_1", req);

      const createCall = (prismaAdmin.session.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.data.fingerprint).toBe(expectedFingerprint);
    });

    it("createSession stores ipAddress and userAgent from request", async () => {
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (fn: (tx: typeof prismaAdmin) => Promise<void>) => fn(prismaAdmin),
      );
      (prismaAdmin.session.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prismaAdmin.session.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prismaAdmin.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_USER);

      const req = mockRequest({ ip: "203.0.113.42", userAgent: "MyApp/3.0" });
      await createSession("usr_1", req);

      const createCall = (prismaAdmin.session.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.data.ipAddress).toBe("203.0.113.42");
      expect(createCall.data.userAgent).toBe("MyApp/3.0");
    });

    it("validateSession cleans up expired cached session from Redis", async () => {
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);

      const cachedData = {
        userId: "usr_1",
        accountId: "acc_1",
        role: "owner",
        expiresAt: Date.now - 1000, // expired
        lastActiveAt: Date.now() - 60000,
        fingerprint: null,
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedData));

      await validateSession("expired-cached");

      expect(mockRedis.del).toHaveBeenCalled();
    });

    it("validateSession cleans up idle cached session from Redis", async () => {
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);

      const cachedData = {
        userId: "usr_1",
        accountId: "acc_1",
        role: "owner",
        expiresAt: Date.now + 7 * 24 * 60 * 60 * 1000,
        lastActiveAt: Date.now - 31 * 60 * 1000, // 31 min ago
        fingerprint: null,
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedData));

      await validateSession("idle-cached");

      expect(mockRedis.del).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // revokeAllUserSessions
  // =========================================================================
  describe("revokeAllUserSessions()", () => {
    it("deletes all sessions for a user from DB", async () => {
      (prismaAdmin.session.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 3 });

      const result = await revokeAllUserSessions("usr_1");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");
      expect(result.data.count).toBe(3);
      expect(prismaAdmin.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "usr_1" } });
    });

    it("returns ok with count 0 when user has no sessions", async () => {
      (prismaAdmin.session.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

      const result = await revokeAllUserSessions("usr_no_sessions");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");
      expect(result.data.count).toBe(0);
    });

    it("flushes all Redis cache entries for the user when Redis is available", async () => {
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);
      (prismaAdmin.session.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });
      mockRedis.smembers.mockResolvedValue(["session:v1:hash1", "session:v1:hash2"]);

      await revokeAllUserSessions("usr_1");

      expect(mockRedis.smembers).toHaveBeenCalledWith("session:user:usr_1");
      expect(mockRedis.pipeline).toHaveBeenCalled();
      expect(mockRedisPipeline.del).toHaveBeenCalled();
      expect(mockRedisPipeline.exec).toHaveBeenCalled();
    });

    it("deletes Redis index key when no cache keys exist", async () => {
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);
      (prismaAdmin.session.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      mockRedis.smembers.mockResolvedValue([]);

      await revokeAllUserSessions("usr_1");

      expect(mockRedis.del).toHaveBeenCalledWith("session:user:usr_1");
    });

    it("handles Redis unavailability gracefully", async () => {
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (prismaAdmin.session.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });

      const result = await revokeAllUserSessions("usr_1");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");
      expect(result.data.count).toBe(2);
    });

    it("handles Redis smembers error gracefully", async () => {
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);
      (prismaAdmin.session.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      mockRedis.smembers.mockRejectedValue(new Error("Redis connection refused"));

      const result = await revokeAllUserSessions("usr_1");

      // DB sessions are still deleted; Redis failure is non-fatal
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");
      expect(result.data.count).toBe(1);
    });

    it("returns error on DB failure", async () => {
      (prismaAdmin.session.deleteMany as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB connection lost"));

      const result = await revokeAllUserSessions("usr_1");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected error");
      expect(result.error).toBe("Unable to revoke sessions right now. Please try again.");
    });
  });

  // =========================================================================
  // deleteExpiredSessions
  // =========================================================================
  describe("deleteExpiredSessions()", () => {
    it("deletes sessions where expiresAt is in the past", async () => {
      (prismaAdmin.session.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 5 });

      await deleteExpiredSessions();

      expect(prismaAdmin.session.deleteMany).toHaveBeenCalledWith({
        where: { expiresAt: { lt: expect.any(Date) } },
      });
    });

    it("does not throw on DB error (logs instead)", async () => {
      (prismaAdmin.session.deleteMany as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB error"));

      // Should not throw
      await expect(deleteExpiredSessions()).resolves.not.toThrow();
    });

    it("handles zero expired sessions gracefully", async () => {
      (prismaAdmin.session.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

      await expect(deleteExpiredSessions()).resolves.not.toThrow();
    });
  });
});
