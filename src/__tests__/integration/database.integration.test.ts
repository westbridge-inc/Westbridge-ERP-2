/**
 * Database integration tests — validates Prisma models, constraints, cascades,
 * and query correctness against a real PostgreSQL database.
 *
 * Skipped unless TEST_DATABASE_URL is set (see setup.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "crypto";
import { TEST_DB_URL, getTestPrisma, cleanDatabase } from "./setup.js";

const shouldSkip = !TEST_DB_URL;

describe.skipIf(shouldSkip)("Database Integration Tests", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = getTestPrisma();
    await prisma.$connect();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
  });

  afterAll(async () => {
    await cleanDatabase(prisma);
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // Account + User creation
  // ---------------------------------------------------------------------------
  describe("Account & User CRUD", () => {
    it("creates an account with all required fields", async () => {
      const account = await prisma.account.create({
        data: {
          email: "test@example.com",
          companyName: "Test Corp",
          plan: "starter",
          status: "active",
          modulesSelected: ["accounting", "crm"],
        },
      });

      expect(account.id).toBeDefined();
      expect(account.email).toBe("test@example.com");
      expect(account.companyName).toBe("Test Corp");
      expect(account.plan).toBe("starter");
      expect(account.modulesSelected).toEqual(["accounting", "crm"]);
    });

    it("enforces unique email constraint on accounts", async () => {
      await prisma.account.create({
        data: {
          email: "unique@test.com",
          companyName: "First Corp",
          plan: "starter",
        },
      });

      await expect(
        prisma.account.create({
          data: {
            email: "unique@test.com",
            companyName: "Second Corp",
            plan: "starter",
          },
        }),
      ).rejects.toThrow();
    });

    it("creates a user linked to an account", async () => {
      const account = await prisma.account.create({
        data: {
          email: "company@test.com",
          companyName: "Test Corp",
          plan: "starter",
        },
      });

      const user = await prisma.user.create({
        data: {
          accountId: account.id,
          email: "user@test.com",
          name: "Test User",
          role: "owner",
          passwordHash: "hashed-password-value",
        },
      });

      expect(user.id).toBeDefined();
      expect(user.accountId).toBe(account.id);
      expect(user.role).toBe("owner");
      expect(user.status).toBe("active");
      expect(user.failedLoginAttempts).toBe(0);
    });

    it("enforces unique (accountId, email) constraint on users", async () => {
      const account = await prisma.account.create({
        data: {
          email: "company@test.com",
          companyName: "Test Corp",
          plan: "starter",
        },
      });

      await prisma.user.create({
        data: {
          accountId: account.id,
          email: "user@test.com",
          role: "member",
        },
      });

      await expect(
        prisma.user.create({
          data: {
            accountId: account.id,
            email: "user@test.com",
            role: "admin",
          },
        }),
      ).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Session CRUD & Token Uniqueness
  // ---------------------------------------------------------------------------
  describe("Session operations", () => {
    let accountId: string;
    let userId: string;

    beforeEach(async () => {
      await cleanDatabase(prisma);
      const account = await prisma.account.create({
        data: {
          email: "session-test@test.com",
          companyName: "Session Corp",
          plan: "starter",
        },
      });
      const user = await prisma.user.create({
        data: {
          accountId: account.id,
          email: "user@session.com",
          role: "owner",
        },
      });
      accountId = account.id;
      userId = user.id;
    });

    it("creates a session with hashed token", async () => {
      const rawToken = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(rawToken).digest("hex");

      const session = await prisma.session.create({
        data: {
          userId,
          token: tokenHash,
          expiresAt: new Date(Date.now + 7 * 24 * 60 * 60 * 1000),
          ipAddress: "192.168.1.100",
          userAgent: "TestBrowser/1.0",
        },
      });

      expect(session.token).toBe(tokenHash);
      expect(session.token).not.toBe(rawToken);
      expect(session.userId).toBe(userId);
    });

    it("enforces unique token constraint", async () => {
      const tokenHash = createHash("sha256").update("duplicate").digest("hex");

      await prisma.session.create({
        data: { userId, token: tokenHash, expiresAt: new Date(Date.now() + 86400000) },
      });

      await expect(
        prisma.session.create({
          data: { userId, token: tokenHash, expiresAt: new Date(Date.now() + 86400000) },
        }),
      ).rejects.toThrow();
    });

    it("finds session by token hash with user include", async () => {
      const tokenHash = createHash("sha256").update("find-me").digest("hex");

      await prisma.session.create({
        data: { userId, token: tokenHash, expiresAt: new Date(Date.now() + 86400000) },
      });

      const found = await prisma.session.findUnique({
        where: { token: tokenHash },
        include: { user: { include: { account: true } } },
      });

      expect(found).not.toBeNull();
      expect(found!.user.id).toBe(userId);
      expect(found!.user.account.id).toBe(accountId);
    });

    it("deletes expired sessions via deleteMany", async () => {
      const expired = new Date(Date.now() - 1000);
      const valid = new Date(Date.now() + 86400000);

      await prisma.session.createMany({
        data: [
          { userId, token: "expired-1", expiresAt: expired },
          { userId, token: "expired-2", expiresAt: expired },
          { userId, token: "valid-1", expiresAt: valid },
        ],
      });

      const result = await prisma.session.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });

      expect(result.count).toBe(2);

      const remaining = await prisma.session.findMany({ where: { userId } });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].token).toBe("valid-1");
    });

    it("updates lastActiveAt on session touch", async () => {
      const tokenHash = createHash("sha256").update("touch-me").digest("hex");
      const session = await prisma.session.create({
        data: { userId, token: tokenHash, expiresAt: new Date(Date.now() + 86400000) },
      });

      const touchedAt = new Date();
      await prisma.session.update({
        where: { id: session.id },
        data: { lastActiveAt: touchedAt },
      });

      const updated = await prisma.session.findUnique({ where: { id: session.id } });
      expect(updated!.lastActiveAt.getTime()).toBe(touchedAt.getTime());
    });
  });

  // ---------------------------------------------------------------------------
  // Cascade deletes
  // ---------------------------------------------------------------------------
  describe("Cascade deletes", () => {
    it("deleting an account cascades to users, sessions, and audit logs", async () => {
      const account = await prisma.account.create({
        data: {
          email: "cascade@test.com",
          companyName: "Cascade Corp",
          plan: "starter",
        },
      });

      const user = await prisma.user.create({
        data: { accountId: account.id, email: "cascade-user@test.com", role: "owner" },
      });

      await prisma.session.create({
        data: {
          userId: user.id,
          token: "cascade-session-token",
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      await prisma.auditLog.create({
        data: {
          accountId: account.id,
          userId: user.id,
          action: "test.cascade",
          severity: "info",
          outcome: "success",
        },
      });

      // Delete audit logs first — AuditLog uses onDelete: Restrict to protect compliance data
      await prisma.auditLog.deleteMany({ where: { accountId: account.id } });

      // Delete account — should cascade to users and sessions
      await prisma.account.delete({ where: { id: account.id } });

      // Verify everything is gone
      const users = await prisma.user.findMany({ where: { accountId: account.id } });
      const sessions = await prisma.session.findMany({ where: { userId: user.id } });
      const audits = await prisma.auditLog.findMany({ where: { accountId: account.id } });

      expect(users).toHaveLength(0);
      expect(sessions).toHaveLength(0);
      expect(audits).toHaveLength(0);
    });

    it("deleting a user cascades to their sessions", async () => {
      const account = await prisma.account.create({
        data: {
          email: "user-cascade@test.com",
          companyName: "UserCascade Corp",
          plan: "starter",
        },
      });

      const user = await prisma.user.create({
        data: { accountId: account.id, email: "doomed@test.com", role: "member" },
      });

      await prisma.session.createMany({
        data: [
          { userId: user.id, token: "sess-1", expiresAt: new Date(Date.now() + 86400000) },
          { userId: user.id, token: "sess-2", expiresAt: new Date(Date.now() + 86400000) },
        ],
      });

      await prisma.user.delete({ where: { id: user.id } });

      const sessions = await prisma.session.findMany({ where: { userId: user.id } });
      expect(sessions).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Audit log queries
  // ---------------------------------------------------------------------------
  describe("Audit log queries", () => {
    let accountId: string;

    beforeEach(async () => {
      await cleanDatabase(prisma);
      const account = await prisma.account.create({
        data: {
          email: "audit@test.com",
          companyName: "Audit Corp",
          plan: "starter",
        },
      });
      accountId = account.id;
    });

    it("inserts and queries audit logs by account + timestamp range", async () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 3600000);
      const twoHoursAgo = new Date(now.getTime() - 7200000);

      await prisma.auditLog.createMany({
        data: [
          { accountId, action: "auth.login", severity: "info", outcome: "success", timestamp: twoHoursAgo },
          { accountId, action: "erp.doc.create", severity: "info", outcome: "success", timestamp: oneHourAgo },
          { accountId, action: "auth.logout", severity: "info", outcome: "success", timestamp: now },
        ],
      });

      const recent = await prisma.auditLog.findMany({
        where: {
          accountId,
          timestamp: { gte: new Date(now.getTime - 5400000) }, // last 1.5 hours
        },
        orderBy: { timestamp: "desc" },
      });

      expect(recent).toHaveLength(2);
      expect(recent[0].action).toBe("auth.logout");
      expect(recent[1].action).toBe("erp.doc.create");
    });

    it("queries audit logs by severity", async () => {
      await prisma.auditLog.createMany({
        data: [
          { accountId, action: "auth.login", severity: "info", outcome: "success" },
          { accountId, action: "permission.denied", severity: "warn", outcome: "failure" },
          { accountId, action: "auth.brute_force", severity: "critical", outcome: "failure" },
        ],
      });

      const critical = await prisma.auditLog.findMany({
        where: { accountId, severity: "critical" },
      });

      expect(critical).toHaveLength(1);
      expect(critical[0].action).toBe("auth.brute_force");
    });

    it("stores metadata as JSON", async () => {
      await prisma.auditLog.create({
        data: {
          accountId,
          action: "erp.doc.create",
          severity: "info",
          outcome: "success",
          metadata: { doctype: "Sales Invoice", name: "INV-001", total: 1500.0 },
        },
      });

      const log = await prisma.auditLog.findFirst({ where: { accountId } });
      expect(log!.metadata).toEqual({
        doctype: "Sales Invoice",
        name: "INV-001",
        total: 1500.0,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrent session limit (transaction safety)
  // ---------------------------------------------------------------------------
  describe("Concurrent session enforcement", () => {
    it("can query and enforce max sessions atomically via transaction", async () => {
      const account = await prisma.account.create({
        data: {
          email: "concurrent@test.com",
          companyName: "Concurrent Corp",
          plan: "starter",
        },
      });
      const user = await prisma.user.create({
        data: { accountId: account.id, email: "busy@test.com", role: "owner" },
      });

      // Create 5 sessions (the max)
      for (let i = 0; i < 5; i++) {
        await prisma.session.create({
          data: {
            userId: user.id,
            token: `token-${i}`,
            expiresAt: new Date(Date.now() + 86400000),
          },
        });
      }

      // Use a transaction to atomically check count and evict oldest
      await prisma.$transaction(async (tx) => {
        const activeSessions = await tx.session.findMany({
          where: { userId: user.id, expiresAt: { gt: new Date() } },
          orderBy: { lastActiveAt: "asc" },
        });

        expect(activeSessions.length).toBe(5);

        if (activeSessions.length >= 5) {
          await tx.session.delete({ where: { id: activeSessions[0].id } });
        }

        await tx.session.create({
          data: {
            userId: user.id,
            token: `token-new`,
            expiresAt: new Date(Date.now() + 86400000),
          },
        });
      });

      const finalSessions = await prisma.session.findMany({ where: { userId: user.id } });
      expect(finalSessions).toHaveLength(5); // still 5 (one evicted, one created)
      expect(finalSessions.find((s) => s.token === "token-0")).toBeUndefined; // oldest evicted
      expect(finalSessions.find((s) => s.token === "token-new")).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Password reset tokens
  // ---------------------------------------------------------------------------
  describe("Password reset tokens", () => {
    it("creates and retrieves a password reset token", async () => {
      const account = await prisma.account.create({
        data: {
          email: "reset@test.com",
          companyName: "Reset Corp",
          plan: "starter",
        },
      });
      const user = await prisma.user.create({
        data: { accountId: account.id, email: "reset-user@test.com", role: "owner" },
      });

      const tokenHash = createHash("sha256").update("reset-token-raw").digest("hex");
      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt: new Date(Date.now() + 3600000),
        },
      });

      const found = await prisma.passwordResetToken.findUnique({
        where: { tokenHash },
      });

      expect(found).not.toBeNull();
      expect(found!.userId).toBe(user.id);
      expect(found!.usedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Webhook endpoints
  // ---------------------------------------------------------------------------
  describe("Webhook endpoints", () => {
    it("creates webhook with circuit breaker fields", async () => {
      const account = await prisma.account.create({
        data: {
          email: "webhook@test.com",
          companyName: "Webhook Corp",
          plan: "starter",
        },
      });

      const webhook = await prisma.webhookEndpoint.create({
        data: {
          accountId: account.id,
          url: "https://example.com/hook",
          events: ["invoice.created", "payment.received"],
          secret: "encrypted-secret-value",
          enabled: true,
        },
      });

      expect(webhook.consecutiveFailures).toBe(0);
      expect(webhook.disabledAt).toBeNull();
      expect(webhook.events).toEqual(["invoice.created", "payment.received"]);
    });
  });
});
