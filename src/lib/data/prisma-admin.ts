/**
 * Cross-tenant Prisma client (admin / bypass-RLS).
 *
 * This client connects via `MIGRATION_DATABASE_URL` (the schema-owner
 * role, e.g. `westbridge_api` in production) which is the OWNER of the
 * `public.*` tables and therefore bypasses Row-Level Security policies
 * by default — without needing the explicit `BYPASSRLS` role attribute.
 *
 * Compared to `prisma.ts` (the runtime, RLS-pinned client used by
 * authenticated route handlers), `prismaAdmin`:
 *
 *   1. Does NOT install the tenant-pin extension that wraps every
 *      operation in a `set_config('app.current_account_id', ...)`
 *      transaction. It just runs the query directly.
 *   2. Connects as the schema-owner role even AFTER Phase 3's
 *      DATABASE_URL switch flips the runtime role to `westbridge_app`.
 *
 * USE THIS CLIENT FOR — and ONLY FOR:
 *
 *   - Pre-tenant-context auth flows that need to discover which tenant
 *     a request belongs to:
 *       • `validateSession()` — looks up session by token hash, joins user
 *       • `requireActiveSubscription` middleware — looks up account status
 *       • `handleLogin` / `handleForgotPassword` — looks up account+user
 *         by email (no tenant context yet)
 *       • SSO `handleCallback` — looks up SSO config by accountId from
 *         a query string (no tenant context yet)
 *
 *   - INSERTs into multiple tenants from the same handler:
 *       • `createAccount()` — creates an account row + the first user row
 *
 *   - Verified-by-signature webhook handlers that mark accounts paid:
 *       • `markAccountPaid()` (Paddle webhook handler)
 *       • `cancelSubscription()`
 *
 *   - Cleanup workers that legitimately operate across all tenants:
 *       • daily session cleanup, audit log retention
 *       • soft-delete + 30-day hard-delete account purge
 *       • trial expiry / grace period checks
 *       • subscription state reconciliation
 *
 *   - System-level audit logging:
 *       • `audit.service.logAudit()` — writes to audit_logs from any
 *         layer of the stack, often before tenant context is set
 *
 * EVERYTHING ELSE — every authenticated route handler, every per-tenant
 * service call — MUST use `prisma.ts` so RLS enforces isolation.
 *
 * The split is enforced by code review and by the tenant-isolation
 * integration test in `src/__tests__/integration/`. There is no runtime
 * check; the discipline is "if you need a query to span tenants, you
 * need to import from `prisma-admin.ts` and explain why in a comment".
 */

import { PrismaClient } from "@prisma/client";

function createPrismaAdminClient() {
  // Prefer MIGRATION_DATABASE_URL (schema-owner role). Fall back to
  // DATABASE_URL only when MIGRATION_DATABASE_URL is unset, which is the
  // pre-Phase-3-cutover state where both URLs point at the same role.
  // Once the runtime role is switched to `westbridge_app`, this fallback
  // becomes incorrect — Phase 3's deploy MUST set MIGRATION_DATABASE_URL
  // to the schema-owner URL or this client will inherit RLS-enforced
  // visibility and break.
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "prismaAdmin: neither MIGRATION_DATABASE_URL nor DATABASE_URL is set. " +
        "After Phase 3, MIGRATION_DATABASE_URL must point at the schema-owner role.",
    );
  }

  // Smaller pool than the runtime client — admin queries are mostly
  // single-shot lookups (login, webhook handlers, audit writes). 5 is
  // plenty for the worker burst case. Override with PRISMA_ADMIN_POOL_SIZE
  // if you actually need more.
  const poolSize = parseInt(process.env.PRISMA_ADMIN_POOL_SIZE || "5");
  const finalUrl = url.includes("connection_limit")
    ? url
    : `${url}${url.includes("?") ? "&" : "?"}connection_limit=${poolSize}`;

  const base = new PrismaClient({
    datasourceUrl: finalUrl,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

  // We intentionally do NOT install the tenant-pin extension here.
  // We DO install the same soft-delete extensions as the runtime client
  // so behavior is identical for the model methods that callers use.
  const extended = base.$extends({
    query: {
      account: {
        async findFirst({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
        async findMany({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
        async findUnique({ args, query }) {
          const result = await query(args);
          if (
            result &&
            (result as { deletedAt?: Date | null }).deletedAt !== null &&
            (result as { deletedAt?: Date | null }).deletedAt !== undefined
          ) {
            return null;
          }
          return result;
        },
        async count({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
        async update({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null } as typeof args.where;
          return query(args);
        },
        async updateMany({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
      },
      user: {
        async findFirst({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
        async findMany({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
        async findUnique({ args, query }) {
          const result = await query(args);
          if (
            result &&
            (result as { deletedAt?: Date | null }).deletedAt !== null &&
            (result as { deletedAt?: Date | null }).deletedAt !== undefined
          ) {
            return null;
          }
          return result;
        },
        async count({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
        async update({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null } as typeof args.where;
          return query(args);
        },
        async updateMany({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
      },
    },
  });

  return extended;
}

type ExtendedAdminClient = ReturnType<typeof createPrismaAdminClient>;

const globalForAdmin = globalThis as unknown as { prismaAdmin: ExtendedAdminClient };

export const prismaAdmin: ExtendedAdminClient = globalForAdmin.prismaAdmin ?? createPrismaAdminClient();
globalForAdmin.prismaAdmin = prismaAdmin;
