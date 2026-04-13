/**
 * Account cleanup service — GDPR right-to-erasure (compliance review)+ B2)
 *
 * The published Privacy Policy promises:
 *   "After the 30-day [post-cancellation] period, Customer Data is
 *    permanently deleted from our production systems."
 *
 * This module provides the two pieces required to honour that promise:
 *
 *   1. softDeleteAccount(accountId, ctx)
 *        Called from DELETE /api/account/delete. Anonymises PII on the
 *        users (the password hash + email + name are scrubbed immediately
 *        so the account is unrecoverable from PII alone), drops all access
 *        credentials (sessions, API keys, webhooks, SSO config, invite
 *        tokens), and stamps `account.deletedAt` so the daily worker can
 *        find it 30 days later.
 *
 *   2. hardDeleteAccount(accountId)
 *        Called from the daily cleanup worker . Anonymises the
 *        account's audit log rows in place — scrubbing PII columns and
 *        nulling user_id — then calls prismaAdmin.account.delete, which
 *        cascades through every child table (users, subscriptions, api
 *        keys, webhooks, billing invoices, sso config, all cortex tables,
 *        notification preferences, totp secrets) via the FK relations
 *        defined in schema.prismaAdmin. The audit log rows survive with
 *        account_id NULL via the migration's ON DELETE SET NULL FK so
 *        SOC 2 / GRA security history retention is preserved alongside
 *        the GDPR Art. 17 erasure of customer data.
 *
 * findAccountsDueForHardDelete is the worker's query — soft-deleted
 * accounts whose grace period has elapsed.
 */

import { prismaAdmin } from "../data/prisma-admin.js";
import { ok, err, type Result } from "../utils/result.js";
import { DATA_RETENTION } from "../data-retention.js";
import { logger } from "../logger.js";
import { logAudit } from "./audit.service.js";

export interface SoftDeleteContext {
  ipAddress?: string;
  userAgent?: string;
  initiatorUserId: string;
}

export interface HardDeleteResult {
  accountId: string;
  auditLogsAnonymized: number;
  cascadedRows: { table: string; deleted: number }[];
}

/**
 * Mark an account for deletion. Strips PII immediately and revokes all
 * credentials, but leaves the row in place so the user has a 30-day
 * window to recover (e.g. via Support if they fat-fingered the delete).
 */
export async function softDeleteAccount(
  accountId: string,
  ctx: SoftDeleteContext,
): Promise<Result<{ usersAffected: number }, string>> {
  try {
    const usersToDelete = await prismaAdmin.user.findMany({
      where: { accountId },
      select: { id: true },
    });
    const userIds = usersToDelete.map((u) => u.id);
    const now = new Date();

    await prismaAdmin.$transaction(async (tx) => {
      // Anonymize PII on every user in the account. Email is scrubbed to a
      // unique placeholder so the @@unique([accountId, email]) constraint
      // is preserved and a future signup can reuse the original address.
      for (const u of usersToDelete) {
        await tx.user.update({
          where: { id: u.id },
          data: {
            name: "Deleted User",
            email: `deleted-${u.id}@deleted.invalid`,
            passwordHash: null,
            status: "deleted",
            deletedAt: now,
          },
        });
      }

      // Immediate credential revocation. These tables grant access to the
      // tenant — we cannot wait 30 days to invalidate them.
      await tx.session.deleteMany({ where: { userId: { in: userIds } } });
      await tx.apiKey.deleteMany({ where: { accountId } });
      await tx.webhookEndpoint.deleteMany({ where: { accountId } });
      await tx.ssoConfig.deleteMany({ where: { accountId } });
      await tx.inviteToken.deleteMany({ where: { accountId } });
      await tx.passwordResetToken.deleteMany({ where: { userId: { in: userIds } } });

      // Stamp the soft-delete marker. The daily cleanup worker reads
      // `deletedAt < NOW - SOFT_DELETED_DAYS` to find rows to purge.
      await tx.account.update({
        where: { id: accountId },
        data: {
          status: "deleted",
          deletedAt: now,
        },
      });
    });

    // Audit log the soft delete with the request context. The route
    // also writes a higher-level "account.deleted" entry; this row is
    // the service-level record of what was actually purged.
    await logAudit({
      accountId,
      userId: ctx.initiatorUserId,
      action: "account.soft_deleted",
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { usersAffected: userIds.length },
      severity: "info",
      outcome: "success",
    });

    return ok({ usersAffected: userIds.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    logger.error("softDeleteAccount failed", { accountId, error: msg });
    return err(msg);
  }
}

/**
 * Find accounts whose 30-day grace period has elapsed and that should
 * now be hard-deleted. Used by the daily cleanup worker.
 */
export async function findAccountsDueForHardDelete(now: Date = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime - DATA_RETENTION.SOFT_DELETED_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prismaAdmin.account.findMany({
    where: {
      deletedAt: { lt: cutoff },
      status: "deleted",
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Permanently delete an account and every child row that references it.
 *
 * Step 1: anonymize audit logs in place. Audit logs survive the delete
 *         (the FK is ON DELETE SET NULL) so SOC 2 / GRA security history
 *         retention is honoured. We strip PII columns and the user_id
 *         link so the surviving rows cannot be tied back to any natural
 *         person.
 *
 * Step 2: best-effort delete the ERPNext company (it lives in a separate
 *         system). Failures are logged but do NOT block the SQL purge —
 *         we'd rather erase the database and leave a stray ERPNext
 *         company than fail to honor the GDPR right.
 *
 * Step 3: prismaAdmin.account.delete — cascades through every child table.
 */
export async function hardDeleteAccount(accountId: string): Promise<Result<HardDeleteResult, string>> {
  try {
    // Step 1: anonymize audit logs in place. accountId stays bound for
    // now; the SET NULL FK constraint will null it when the parent row
    // is deleted in Step 3.
    const anonymized = await prismaAdmin.auditLog.updateMany({
      where: { accountId },
      data: {
        userId: null,
        ipAddress: null,
        userAgent: null,
        metadata: { value: "[purged: account hard-deleted]" },
      },
    });

    // Step 2: best-effort ERPNext deprovision. Don't fail the purge on
    // an external API hiccup — leaving the SQL row alive is worse than
    // leaving a stray ERPNext company.
    const account = await prismaAdmin.account.findUnique({
      where: { id: accountId },
      select: { erpnextCompany: true },
    });
    if (account?.erpnextCompany) {
      try {
        await deleteErpnextCompany(account.erpnextCompany);
      } catch (e) {
        logger.warn("ERPNext deprovision failed during hard delete (continuing)", {
          accountId,
          erpnextCompany: account.erpnextCompany,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Step 3: cascade delete via Prisma. Every child relation in the
    // schema is ON DELETE CASCADE so a single statement clears the
    // entire tenant. The auditLog FK is ON DELETE SET NULL so the
    // anonymized rows from Step 1 stay behind.
    await prismaAdmin.account.delete({ where: { id: accountId } });

    // Log the purge to a system-scoped audit row so we have a permanent
    // record that the GDPR right-to-erasure was honored. We use the
    // SYSTEM_ACCOUNT_ID env if present; otherwise log without an account
    // (the row's account_id will be NULL via the schema change).
    const systemAccountId = process.env.SYSTEM_ACCOUNT_ID;
    if (systemAccountId) {
      await logAudit({
        accountId: systemAccountId,
        action: "account.purged",
        metadata: {
          purgedAccountId: accountId,
          auditLogsAnonymized: anonymized.count,
          purgedAt: new Date().toISOString(),
        },
        severity: "info",
        outcome: "success",
      });
    } else {
      logger.info("Account hard-deleted (no SYSTEM_ACCOUNT_ID for audit row)", {
        accountId,
        auditLogsAnonymized: anonymized.count,
      });
    }

    return ok({
      accountId,
      auditLogsAnonymized: anonymized.count,
      // Cascade row counts aren't returned by Prisma's delete; the
      // structure is here for tests to reason about completeness.
      cascadedRows: [],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    logger.error("hardDeleteAccount failed", { accountId, error: msg });
    return err(msg);
  }
}

/**
 * Best-effort ERPNext company delete. Tries DELETE /api/resource/Company/{name}.
 * Returns nothing — caller catches errors and continues.
 *
 * Kept inline rather than promoted to provisioning.service because the
 * deprovision call is GDPR-mandated rather than tenant-managed, and we
 * don't want any future "feature flag" gating in provisioning.service to
 * accidentally suppress the erasure.
 */
async function deleteErpnextCompany(companyName: string): Promise<void> {
  const ERPNEXT_URL = process.env.ERPNEXT_URL ?? "http://localhost:8080";
  const ERPNEXT_API_KEY = process.env.ERPNEXT_API_KEY ?? "";
  const ERPNEXT_API_SECRET = process.env.ERPNEXT_API_SECRET ?? "";

  if (!ERPNEXT_API_KEY || !ERPNEXT_API_SECRET) {
    // No credentials configured — skip silently. Provisioning would also
    // be a no-op in this state, so a missing company in ERPNext is the
    // expected outcome.
    return;
  }

  const url = `${ERPNEXT_URL}/api/resource/Company/${encodeURIComponent(companyName)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `token ${ERPNEXT_API_KEY}:${ERPNEXT_API_SECRET}`,
    },
  });

  if (!res.ok && res.status !== 404) {
    throw new Error(`ERPNext DELETE returned ${res.status}`);
  }
}
