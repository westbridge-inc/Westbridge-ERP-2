/**
 * prisma-admin tests
 *
 * The admin client is the deliberate "bypass-RLS" escape hatch used by
 * pre-tenant-context auth flows, signature-verified webhooks, and
 * cleanup workers. This test exists to:
 *
 *   1. Document the contract: prismaAdmin must NOT install the
 *      tenant-pin extension that prisma.ts uses (verified indirectly via
 *      construction shape — there is no public API to introspect the
 *      installed extensions).
 *   2. Prove the module loads without crashing under the standard env
 *      shape (MIGRATION_DATABASE_URL set).
 *   3. Prove the module throws a clear, debuggable error when neither
 *      MIGRATION_DATABASE_URL nor DATABASE_URL is set, since silent
 *      misconfiguration here would cause the admin client to connect to
 *      the wrong role and quietly enforce RLS on system flows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Track every PrismaClient construction so we can assert what URL the
// admin client picked up. The mock client just records its options.
const constructionLog: Array<{ datasourceUrl?: string }> = [];

vi.mock("@prisma/client", () => {
  return {
    PrismaClient: vi.fn().mockImplementation((opts: { datasourceUrl?: string }) => {
      constructionLog.push(opts);
      // Return a minimal stub that supports `$extends({...})` returning
      // an object with the same shape — that's all `prisma-admin.ts`
      // calls before exporting.
      const stub: Record<string, unknown> = {
        $extends: vi.fn().mockReturnValue({
          // The shape returned by the soft-delete extension; tests below
          // only check that the export is callable / defined.
          account: { findUnique: vi.fn(), findMany: vi.fn() },
          user: { findUnique: vi.fn(), findMany: vi.fn() },
          $disconnect: vi.fn(),
        }),
      };
      return stub;
    }),
  };
});

describe("prisma-admin", () => {
  const originalMigrationUrl = process.env.MIGRATION_DATABASE_URL;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    constructionLog.length = 0;
    // Each test imports the module fresh so the singleton initializer re-runs.
    vi.resetModules();
    delete (globalThis as unknown as { prismaAdmin?: unknown }).prismaAdmin;
  });

  afterEach(() => {
    process.env.MIGRATION_DATABASE_URL = originalMigrationUrl;
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("prefers MIGRATION_DATABASE_URL over DATABASE_URL", async () => {
    process.env.MIGRATION_DATABASE_URL = "postgres://owner@host/db";
    process.env.DATABASE_URL = "postgres://app@host/db";

    const mod = await import("../prisma-admin.js");
    expect(mod.prismaAdmin).toBeDefined();
    expect(constructionLog).toHaveLength(1);
    // The admin client must connect via the schema-owner URL, not the
    // runtime app URL — that's the entire point of this client.
    expect(constructionLog[0]?.datasourceUrl).toContain("owner@host");
    expect(constructionLog[0]?.datasourceUrl).not.toContain("app@host");
  });

  it("falls back to DATABASE_URL when MIGRATION_DATABASE_URL is unset", async () => {
    delete process.env.MIGRATION_DATABASE_URL;
    process.env.DATABASE_URL = "postgres://only@host/db";

    const mod = await import("../prisma-admin.js");
    expect(mod.prismaAdmin).toBeDefined();
    expect(constructionLog[0]?.datasourceUrl).toContain("only@host");
  });

  it("throws a clear error when no URL is set", async () => {
    delete process.env.MIGRATION_DATABASE_URL;
    delete process.env.DATABASE_URL;

    await expect(import("../prisma-admin.js")).rejects.toThrow(/MIGRATION_DATABASE_URL/);
  });

  it("appends a connection_limit query param when missing", async () => {
    process.env.MIGRATION_DATABASE_URL = "postgres://owner@host/db";
    delete process.env.DATABASE_URL;

    await import("../prisma-admin.js");
    expect(constructionLog[0]?.datasourceUrl).toMatch(/connection_limit=\d+/);
  });

  it("preserves an existing connection_limit query param", async () => {
    process.env.MIGRATION_DATABASE_URL = "postgres://owner@host/db?connection_limit=42";
    delete process.env.DATABASE_URL;

    await import("../prisma-admin.js");
    expect(constructionLog[0]?.datasourceUrl).toBe("postgres://owner@host/db?connection_limit=42");
  });

  it("exports a usable client with model accessors", async () => {
    process.env.MIGRATION_DATABASE_URL = "postgres://owner@host/db";

    const { prismaAdmin } = await import("../prisma-admin.js");
    expect(prismaAdmin).toBeDefined();
    // Sanity-check the surface — the soft-delete-extended client must
    // expose the model accessors that the cross-tenant call sites use.
    expect((prismaAdmin as Record<string, unknown>).account).toBeDefined();
    expect((prismaAdmin as Record<string, unknown>).user).toBeDefined();
  });
});
