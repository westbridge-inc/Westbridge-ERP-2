/**
 * Optimistic concurrency control utility.
 * Prevents lost updates when two requests try to modify the same record simultaneously.
 *
 * Usage:
 *   const result = await optimisticUpdate("account", accountId, currentVersion, { plan: "Business" });
 *   if (!result.ok) return apiError("Record was modified by another request. Please retry.", 409);
 */
import { prisma } from "./prisma.js";
import { ok, err, type Result } from "../utils/result.js";

type ModelName = "account" | "user";

export async function optimisticUpdate(
  model: ModelName,
  id: string,
  expectedVersion: number,
  data: Record<string, unknown>,
): Promise<Result<{ version: number }, string>> {
  const updateData = { ...data, version: { increment: 1 } };
  const where = { id, version: expectedVersion };

  const result =
    model === "account"
      ? await prisma.account.updateMany({ where, data: updateData })
      : await prisma.user.updateMany({ where, data: updateData });

  if (result.count === 0) {
    return err("Concurrent modification detected. The record was updated by another request.");
  }

  return ok({ version: expectedVersion + 1 });
}
