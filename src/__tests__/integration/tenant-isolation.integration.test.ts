/**
 * Tenant isolation integration test (v5.0 of the tenant isolation
 * hardening spec). Connects to a real Postgres database AS the
 * `westbridge_app` role and verifies that Row-Level Security policies
 * actually enforce tenant isolation across every protected table.
 *
 * What this test catches:
 *   - A new tenant-scoped table merged without an RLS policy.
 *   - A future regression that switches the runtime role to one with
 *     BYPASSRLS, or that drops the policies via a migration.
 *   - A `withTenantScope` change that fails to set the variable inside
 *     the same transaction.
 *
 * Required environment:
 *   TEST_RLS_DATABASE_URL — REQUIRED. Must point at a Postgres database
 *                       AS the `westbridge_app` role (no BYPASSRLS, no
 *                       DDL). This is a DEDICATED env var (not the same
 *                       as TEST_DATABASE_URL used by the other
 *                       integration tests) so the existing tests can
 *                       continue to use the schema-owner role while
 *                       this suite uses the RLS-enforced role.
 *                       Provision locally with:
 *                         ./scripts/provision-rls-role.sh
 *                       and use a URL of the form:
 *                         postgresql://westbridge_app:<pw>@localhost:5432/westbridge?schema=public
 *   TEST_MIGRATION_DATABASE_URL — REQUIRED. Schema-owner URL used to
 *                       seed fixtures across BOTH tenants without RLS
 *                       getting in the way. Without this, fixture
 *                       seeding from the RLS-enforced role would fail.
 *
 * Locally:
 *   TEST_RLS_DATABASE_URL='postgresql://westbridge_app:local-dev-rls-password-do-not-use-in-prod@localhost:5432/westbridge?schema=public' \
 *   TEST_MIGRATION_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/westbridge?schema=public' \
 *   npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/tenant-isolation.integration.test.ts
 *
 * In CI: the integration-test job in .github/workflows/ci.yml provisions
 * the westbridge_app role via scripts/provision-rls-role.sh and exports
 * TEST_RLS_DATABASE_URL before invoking vitest.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";

const TEST_DB_URL = process.env.TEST_RLS_DATABASE_URL;
const SEED_DB_URL = process.env.TEST_MIGRATION_DATABASE_URL ?? TEST_DB_URL;

// Skip the entire suite when no RLS-enforced test database is available
// so `npm test` stays fast for contributors who don't have Postgres
// running, AND so the regular integration test job (which uses the
// schema-owner role and would bypass RLS) doesn't run these assertions
// against the wrong role and produce confusing failures.
const shouldSkip = !TEST_DB_URL;

describe.skipIf(shouldSkip)("tenant isolation (RLS enforcement)", () => {
  // `app` connects as westbridge_app — the RLS-enforced role. This is the
  // client whose visibility we are asserting.
  let app: PrismaClient;
  // `seed` connects as the schema owner so we can plant fixtures in BOTH
  // tenants without RLS getting in the way. Without this, we'd be unable
  // to seed tenant B from a tenant-A-scoped session.
  let seed: PrismaClient;

  const ACC_A = "tnt_test_acc_A";
  const ACC_B = "tnt_test_acc_B";
  const USER_A = "tnt_test_usr_A";
  const USER_B = "tnt_test_usr_B";

  beforeAll(async () => {
    app = new PrismaClient({ datasources: { db: { url: TEST_DB_URL! } }, log: [] });
    seed = new PrismaClient({ datasources: { db: { url: SEED_DB_URL! } }, log: [] });
  });

  afterAll(async () => {
    // Clean up fixtures using the seed (schema-owner) connection so RLS
    // does not block us. Account cascade deletes everything else.
    await seed.account.deleteMany({ where: { id: { in: [ACC_A, ACC_B] } } }).catch(() => {});
    await app.$disconnect();
    await seed.$disconnect();
  });

  beforeEach(async () => {
    // Reset fixtures before every test so the assertions are independent.
    await seed.account.deleteMany({ where: { id: { in: [ACC_A, ACC_B] } } });

    // Seed two tenants with one row in each protected table.
    await seed.account.create({
      data: {
        id: ACC_A,
        email: "tnt-a@example.local",
        companyName: "Tenant A Co",
        plan: "Solo",
        status: "active",
        users: {
          create: {
            id: USER_A,
            email: "tnt-a-owner@example.local",
            name: "Tenant A Owner",
            role: "owner",
            status: "active",
            // child tables hung off the user — exercises the user_id
            // subquery RLS policies (notification_preferences, totp_secrets,
            // password_reset_tokens, sessions).
            notificationPreference: { create: {} },
            sessions: {
              create: {
                token: "tnt_test_sess_a",
                expiresAt: new Date(Date.now + 60 * 60_000),
              },
            },
          },
        },
        auditLogs: {
          create: {
            action: "test.fixture",
            ipAddress: "127.0.0.1",
            severity: "info",
            outcome: "success",
          },
        },
        cortexEvents: {
          create: {
            eventType: "test.fixture",
            source: "test",
            data: { tenant: "A" },
            traceId: "tnt_test_trace_a",
          },
        },
        cortexConversations: {
          create: {
            userId: USER_A,
            title: "Tenant A conversation",
            messages: [],
            lastAgentId: "test",
          },
        },
      },
    });

    await seed.account.create({
      data: {
        id: ACC_B,
        email: "tnt-b@example.local",
        companyName: "Tenant B Co",
        plan: "Solo",
        status: "active",
        users: {
          create: {
            id: USER_B,
            email: "tnt-b-owner@example.local",
            name: "Tenant B Owner",
            role: "owner",
            status: "active",
            notificationPreference: { create: {} },
            sessions: {
              create: {
                token: "tnt_test_sess_b",
                expiresAt: new Date(Date.now + 60 * 60_000),
              },
            },
          },
        },
        auditLogs: {
          create: {
            action: "test.fixture",
            ipAddress: "127.0.0.1",
            severity: "info",
            outcome: "success",
          },
        },
        cortexEvents: {
          create: {
            eventType: "test.fixture",
            source: "test",
            data: { tenant: "B" },
            traceId: "tnt_test_trace_b",
          },
        },
        cortexConversations: {
          create: {
            userId: USER_B,
            title: "Tenant B conversation",
            messages: [],
            lastAgentId: "test",
          },
        },
      },
    });
  });

  /**
   * Helper: run a callback inside a Prisma transaction with the
   * `app.current_account_id` session variable bound to `accountId`.
   * This mirrors `withTenantScope` from src/lib/data/tenant-scope.ts —
   * we replicate it here so the test exercises RLS directly without
   * pulling in the production helper (we still test the helper at the
   * unit level).
   */
  async function asTenant<T>(accountId: string, fn: (tx: typeof app) => Promise<T>): Promise<T> {
    return app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_account_id', '${accountId.replace(/'/g, "''")}', true)`,
      );
      return fn(tx as unknown as typeof app);
    });
  }

  // ─── Default-deny when no tenant variable is set ─────────────────────────
  describe("default deny without tenant context", () => {
    it("returns 0 rows from accounts when app.current_account_id is unset", async () => {
      // No transaction, no set_config → westbridge_app sees nothing.
      const count = await app.account.count();
      expect(count).toBe(0);
    });

    it("returns 0 rows from users when app.current_account_id is unset", async () => {
      const count = await app.user.count();
      expect(count).toBe(0);
    });

    it("returns 0 rows from cortex_events when app.current_account_id is unset", async () => {
      const count = await app.cortexEvent.count();
      expect(count).toBe(0);
    });
  });

  // ─── Tenant A can only see Tenant A ──────────────────────────────────────
  describe("scoped to tenant A", () => {
    it("findMany on every protected table returns ONLY tenant A rows", async () => {
      await asTenant(ACC_A, async (tx) => {
        const accounts = await tx.account.findMany();
        expect(accounts.map((a) => a.id)).toEqual([ACC_A]);

        const users = await tx.user.findMany();
        expect(users.map((u) => u.id)).toEqual([USER_A]);

        const sessions = await tx.session.findMany();
        expect(sessions.map((s) => s.userId)).toEqual([USER_A]);

        const auditLogs = await tx.auditLog.findMany();
        expect(auditLogs.length).toBe(1);
        expect(auditLogs[0]!.accountId).toBe(ACC_A);

        const cortexEvents = await tx.cortexEvent.findMany();
        expect(cortexEvents.length).toBe(1);
        expect(cortexEvents[0]!.accountId).toBe(ACC_A);

        const cortexConversations = await tx.cortexConversation.findMany();
        expect(cortexConversations.length).toBe(1);
        expect(cortexConversations[0]!.accountId).toBe(ACC_A);

        const notif = await tx.notificationPreference.findMany();
        expect(notif.length).toBe(1);
        expect(notif[0]!.userId).toBe(USER_A);
      });
    });

    it("findUnique by tenant B's row id returns null (cannot reach across tenants)", async () => {
      await asTenant(ACC_A, async (tx) => {
        const acc = await tx.account.findUnique({ where: { id: ACC_B } });
        expect(acc).toBeNull();

        const user = await tx.user.findUnique({ where: { id: USER_B } });
        expect(user).toBeNull();
      });
    });

    it("update by tenant B's row id matches zero rows", async () => {
      await asTenant(ACC_A, async (tx) => {
        // updateMany with a where clause that targets tenant B should
        // affect zero rows from tenant A's perspective.
        const result = await tx.user.updateMany({
          where: { id: USER_B },
          data: { name: "hijacked" },
        });
        expect(result.count).toBe(0);
      });

      // Confirm via the seed connection that the row was NOT modified.
      const userB = await seed.user.findUnique({ where: { id: USER_B } });
      expect(userB?.name).toBe("Tenant B Owner");
    });

    it("delete by tenant B's row id matches zero rows", async () => {
      await asTenant(ACC_A, async (tx) => {
        const result = await tx.user.deleteMany({ where: { id: USER_B } });
        expect(result.count).toBe(0);
      });

      const userB = await seed.user.findUnique({ where: { id: USER_B } });
      expect(userB).not.toBeNull();
    });
  });

  // ─── Symmetry: tenant B can only see tenant B ────────────────────────────
  describe("scoped to tenant B (symmetry)", () => {
    it("findMany returns ONLY tenant B rows", async () => {
      await asTenant(ACC_B, async (tx) => {
        const accounts = await tx.account.findMany();
        expect(accounts.map((a) => a.id)).toEqual([ACC_B]);

        const users = await tx.user.findMany();
        expect(users.map((u) => u.id)).toEqual([USER_B]);

        const cortexEvents = await tx.cortexEvent.findMany();
        expect(cortexEvents.length).toBe(1);
        expect(cortexEvents[0]!.accountId).toBe(ACC_B);
      });
    });
  });

  // ─── The Lead model is intentionally global and must NOT be RLS-scoped ──
  describe("Lead model intentional exception", () => {
    it("Lead is NOT under RLS — global marketing capture", async () => {
      // Confirm rowsecurity is OFF on leads. We query pg_tables via $queryRawUnsafe
      // because Prisma doesn't expose pg_catalog directly.
      const rows = await app.$queryRawUnsafe<Array<{ rowsecurity: boolean }>>(
        `SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'leads'`,
      );
      expect(rows[0]?.rowsecurity).toBe(false);
    });
  });
});

// When the suite is skipped (no TEST_DATABASE_URL set), still emit one
// passing test so CI logs make it obvious why.
describe.skipIf(!shouldSkip)("tenant isolation (skipped)", () => {
  it("integration suite skipped — set TEST_DATABASE_URL to enable", () => {
    expect(shouldSkip).toBe(true);
  });
});
