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

function createPrismaClient() {
  const base = new PrismaClient();

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
          return query(args);
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
          return query(args);
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

type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as unknown as { prisma: ExtendedPrismaClient };

export const prisma = globalForPrisma.prisma ?? createPrismaClient();
globalForPrisma.prisma = prisma;
