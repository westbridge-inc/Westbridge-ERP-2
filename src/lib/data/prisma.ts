/**
 * Data layer: Prisma client singleton with soft-delete extensions.
 * Pure I/O; no business logic.
 *
 * Soft-delete strategy for Account and User models:
 * - All find/count operations auto-filter `deletedAt IS NULL` by default
 * - `delete` operations set `deletedAt = now()` instead of hard-deleting
 * - To include deleted records, pass `{ where: { deletedAt: { not: null } } }`
 *   — the extension only injects the filter when `deletedAt` is absent.
 *
 * Uses Prisma Client Extensions ($extends) — the supported API in Prisma 5+/6+.
 */

import { PrismaClient } from "@prisma/client";

/**
 * Production connection pool recommendations:
 *   DATABASE_POOL_SIZE=20        (default: 10, max depends on your Postgres plan)
 *   DATABASE_URL should include:  ?connection_limit=20&pool_timeout=10
 *
 * For Railway/Fly.io with pgbouncer, use transaction mode and set:
 *   ?pgbouncer=true&connection_limit=20
 */
function createPrismaClient() {
  const poolSize = parseInt(process.env.DATABASE_POOL_SIZE || "10");
  const base = new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    // Connection pool size is configured via DATABASE_URL query params
    // e.g. ?connection_limit=20&pool_timeout=10
    // or via DATABASE_POOL_SIZE env var for programmatic override
    ...(poolSize !== 10
      ? {
          datasources: {
            db: {
              url: appendPoolSize(process.env.DATABASE_URL ?? "", poolSize),
            },
          },
        }
      : {}),
  });

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
          // Prisma's findUnique where clause is a union of unique key shapes.
          // We downgrade to findFirst so we can inject the soft-delete filter,
          // then return null (matching findUnique semantics) if the record is soft-deleted.
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
        async delete({ args, query: _query }) {
          return base.account.update({
            where: args.where,
            data: { deletedAt: new Date() },
          });
        },
        async deleteMany({ args, query: _query }) {
          return base.account.updateMany({
            where: { ...args.where, deletedAt: args.where?.deletedAt ?? null },
            data: { deletedAt: new Date() },
          });
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
        async delete({ args, query: _query }) {
          return base.user.update({
            where: args.where,
            data: { deletedAt: new Date() },
          });
        },
        async deleteMany({ args, query: _query }) {
          return base.user.updateMany({
            where: { ...args.where, deletedAt: args.where?.deletedAt ?? null },
            data: { deletedAt: new Date() },
          });
        },
      },
    },
  });

  return extended;
}

/** Append connection_limit to DATABASE_URL if not already present. */
function appendPoolSize(url: string, poolSize: number): string {
  if (!url || url.includes("connection_limit")) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}connection_limit=${poolSize}`;
}

type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as unknown as { prisma: ExtendedPrismaClient };

export const prisma = globalForPrisma.prisma ?? createPrismaClient();
globalForPrisma.prisma = prisma;
