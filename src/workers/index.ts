/**
 * BullMQ workers for all job queues.
 * Started from server.ts after the HTTP server is listening.
 */

import { Worker, type Job } from "bullmq";
import { createHmac } from "crypto";
import dns from "dns/promises";
import { isIP } from "net";
import { sendEmail } from "../lib/email/index.js";
import { prisma } from "../lib/data/prisma.js";
import { prismaAdmin } from "../lib/data/prisma-admin.js";
import { withTenantScope } from "../lib/data/tenant-scope.js";

// Phase 3:
//   - Cross-tenant cleanup tasks (session purge, audit log retention,
//     webhook endpoint state) use prismaAdmin so they're not gated by
//     RLS — the cleanup worker is intentionally global per spec §5.
//   - The reports worker uses withTenantScope(accountId, ...) for the
//     per-account report generation, which sets the tenant pin and
//     keeps the regular `prisma` import (the type extraction below
//     also references it).
import { logger } from "../lib/logger.js";
import { DATA_RETENTION } from "../lib/data-retention.js";
import { erpGet } from "../lib/data/erpnext.client.js";
import { decrypt, isEncrypted, ENCRYPTION_CONTEXT } from "../lib/encryption.js";
import { publish } from "../lib/realtime.js";
import { getRedisConfig } from "../lib/redis.js";
import { SECURITY } from "../lib/constants.js";

// ─── SSRF Protection ──────────────────────────────────────────────────────────

/**
 * Check if an IP address belongs to a private/reserved range.
 * Blocks: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 *         169.254.0.0/16, 0.0.0.0/8, ::1, fc00::/7, fe80::/10
 */
function isPrivateIp(ip: string): boolean {
  // IPv6 loopback and private ranges
  if (ip === "::1" || ip === "::") return true;
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // fc00::/7
  if (ip.startsWith("fe80")) return true; // fe80::/10

  // IPv4 — handle IPv4-mapped IPv6 (::ffff:x.x.x.x)
  let v4 = ip;
  if (ip.startsWith("::ffff:")) {
    v4 = ip.slice(7);
  }

  const parts = v4.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;

  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

/**
 * Resolve the hostname of a URL and verify it does not point to a private IP.
 * Throws if the URL targets a private/reserved address (SSRF protection).
 */
async function assertNotPrivateUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  const hostname = parsed.hostname;

  // If hostname is already an IP literal, check directly
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`SSRF blocked: ${hostname} resolves to a private IP`);
    }
    return;
  }

  // Resolve DNS and check all returned addresses
  const { resolve4, resolve6 } = dns;
  const addresses: string[] = [];
  try {
    addresses.push(...(await resolve4(hostname)));
  } catch {
    /* no A records */
  }
  try {
    addresses.push(...(await resolve6(hostname)));
  } catch {
    /* no AAAA records */
  }

  if (addresses.length === 0) {
    throw new Error(`SSRF blocked: could not resolve hostname ${hostname}`);
  }

  for (const addr of addresses) {
    if (isPrivateIp(addr)) {
      throw new Error(`SSRF blocked: ${hostname} resolves to private IP ${addr}`);
    }
  }
}
import type {
  EmailJobData,
  CleanupJobData,
  WebhookJobData,
  ErpSyncJobData,
  ReportJobData,
  CortexEventJobData,
  ProvisioningJobData,
} from "../lib/jobs/queue.js";
import { processCortexEvent } from "../events/processor.js";

const connection = getRedisConfig();

// ─── Email Worker ──────────────────────────────────────────────────────────────

function createEmailWorker(): Worker {
  return new Worker<EmailJobData>(
    "email",
    async (job: Job<EmailJobData>) => {
      const { to, subject, html, from } = job.data;
      logger.info("Processing email job", { jobId: job.id, to, subject });
      const result = await sendEmail({ to, subject, html, from });
      if (result.ok) {
        logger.info("Email sent", { jobId: job.id, to });
      } else {
        logger.error("Email send failed", { jobId: job.id, to, error: result.error });
        throw new Error(result.error);
      }
    },
    { connection },
  );
}

// ─── Cleanup Worker ────────────────────────────────────────────────────────────

function createCleanupWorker(): Worker {
  return new Worker<CleanupJobData>(
    "cleanup",
    async (job: Job<CleanupJobData>) => {
      const { task } = job.data;
      logger.info("Processing cleanup job", { jobId: job.id, task });

      if (task === "sessions") {
        // Cross-tenant cleanup — uses prismaAdmin so RLS doesn't gate it.
        const result = await prismaAdmin.session.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        logger.info("Deleted expired sessions", { jobId: job.id, count: result.count });
      } else if (task === "audit_logs") {
        const cutoff = new Date(Date.now() - DATA_RETENTION.AUDIT_LOGS_DAYS * 24 * 60 * 60 * 1000);
        const result = await prismaAdmin.auditLog.deleteMany({
          where: { timestamp: { lt: cutoff } },
        });
        logger.info("Deleted old audit logs", {
          jobId: job.id,
          count: result.count,
          retentionDays: DATA_RETENTION.AUDIT_LOGS_DAYS,
        });
      } else if (task === "check-trial-expiry") {
        const { checkTrialExpiry } = await import("../lib/services/subscription.service.js");
        const result = await checkTrialExpiry();
        logger.info("Trial expiry check completed", { jobId: job.id, updated: result.updated });
      } else if (task === "check-grace-period") {
        const { checkGracePeriodExpiry } = await import("../lib/services/subscription.service.js");
        const result = await checkGracePeriodExpiry();
        logger.info("Grace period check completed", { jobId: job.id, updated: result.updated });
      } else if (task === "send-trial-warnings") {
        const { sendTrialWarningEmails } = await import("../lib/services/subscription.service.js");
        const result = await sendTrialWarningEmails();
        logger.info("Trial warning emails sent", {
          jobId: job.id,
          sent3Day: result.sent3Day,
          sent1Day: result.sent1Day,
        });
      } else if (task === "cleanup-expired-trials") {
        const { cleanupExpiredTrialData } = await import("../lib/services/subscription.service.js");
        const result = await cleanupExpiredTrialData();
        logger.info("Expired trial cleanup completed", { jobId: job.id, deleted: result.deleted });
      } else if (task === "purge-deleted-accounts") {
        // B1: hard-delete accounts whose 30-day grace period has elapsed.
        // Drives the Privacy Policy promise of full erasure within 30 days
        // of cancellation. Each account is purged sequentially so a single
        // failure doesn't poison the rest of the batch.
        const { findAccountsDueForHardDelete, hardDeleteAccount } =
          await import("../lib/services/account-cleanup.service.js");
        const due = await findAccountsDueForHardDelete();
        let purged = 0;
        let failed = 0;
        for (const accountId of due) {
          const result = await hardDeleteAccount(accountId);
          if (result.ok) {
            purged += 1;
          } else {
            failed += 1;
            logger.error("purge-deleted-accounts: hard delete failed", {
              jobId: job.id,
              accountId,
              error: result.error,
            });
          }
        }
        logger.info("purge-deleted-accounts completed", {
          jobId: job.id,
          due: due.length,
          purged,
          failed,
        });
      }
    },
    { connection },
  );
}

// ─── Webhooks Worker ───────────────────────────────────────────────────────────

/**
 * Exponential backoff delays for webhook retries (B7).
 * Attempt 1: immediate, Attempt 2: 30s, Attempt 3: 2min, Attempt 4: 15min, Attempt 5: 1hr
 * After 5 failures: circuit breaker disables the endpoint.
 */
const WEBHOOK_RETRY_DELAYS_MS = [0, 30_000, 120_000, 900_000, 3_600_000];

function getWebhookRetryDelay(attemptNumber: number): number {
  return WEBHOOK_RETRY_DELAYS_MS[Math.min(attemptNumber, WEBHOOK_RETRY_DELAYS_MS.length - 1)] ?? 0;
}

function createWebhooksWorker(): Worker {
  return new Worker<WebhookJobData>(
    "webhooks",
    async (job: Job<WebhookJobData>) => {
      const { endpointId, event, payload, deliveryId } = job.data;
      const attemptNumber = job.attemptsMade;
      const maxAttempts = 5;

      logger.info("Processing webhook job", {
        jobId: job.id,
        event,
        endpointId,
        attempt: attemptNumber + 1,
        maxAttempts,
      });

      // Webhook endpoint lookup is by primary key with no tenant context
      // (the worker is invoked from a queued job). Use prismaAdmin to
      // bypass RLS — the endpoint already has its own accountId field
      // that callers verify against the job payload.
      const endpoint = await prismaAdmin.webhookEndpoint.findUnique({
        where: { id: endpointId },
      });

      if (!endpoint || !endpoint.enabled) {
        logger.warn("Skipping webhook: endpoint not found or disabled", { jobId: job.id, endpointId });
        return;
      }

      try {
        // SSRF protection: verify the webhook URL does not target private/reserved IPs
        await assertNotPrivateUrl(endpoint.url);

        // The schema documents WebhookEndpoint.secret as encrypted-at-rest,
        // and any new write paths MUST encrypt before persisting (use the
        // encrypt() helper). Until every legacy row has been backfilled to
        // ciphertext, we tolerate plaintext on read by detecting the format
        // and skipping decryption when the value is not a ciphertext blob.
        // This keeps webhook delivery functional through the migration window
        // without weakening the encrypt-on-write guarantee for new rows.
        //
        // AAD-bound to endpointId on v1 envelopes — the context is ignored on
        // v0 (legacy) ciphertexts so transparent migration still works.
        const secret = isEncrypted(endpoint.secret)
          ? decrypt(endpoint.secret, ENCRYPTION_CONTEXT.webhookSecret(endpointId))
          : endpoint.secret;
        const bodyStr = JSON.stringify(payload);
        const signature = createHmac("sha256", secret).update(bodyStr).digest("hex");

        const res = await fetch(endpoint.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Event": event,
            "X-Delivery-Id": deliveryId,
            "X-Webhook-Signature": signature,
          },
          body: bodyStr,
          signal: AbortSignal.timeout(10_000),
        });

        if (!res.ok) {
          throw new Error(`Webhook delivery failed: ${res.status} ${res.statusText}`);
        }

        // Reset consecutive failures on success
        await prismaAdmin.webhookEndpoint.update({
          where: { id: endpointId },
          data: { consecutiveFailures: 0 },
        });
        logger.info("Webhook delivered", {
          jobId: job.id,
          url: endpoint.url,
          attempt: attemptNumber + 1,
        });
      } catch (err) {
        const newFailures = endpoint.consecutiveFailures + 1;
        const shouldDisable = newFailures >= SECURITY.WEBHOOK_CIRCUIT_BREAKER_THRESHOLD;

        await prismaAdmin.webhookEndpoint.update({
          where: { id: endpointId },
          data: {
            consecutiveFailures: newFailures,
            ...(shouldDisable ? { enabled: false, disabledAt: new Date() } : {}),
          },
        });

        if (shouldDisable) {
          logger.warn("Webhook endpoint disabled after consecutive failures (circuit breaker)", {
            endpointId,
            consecutiveFailures: newFailures,
          });
        }

        const nextAttempt = attemptNumber + 2; // +1 for 0-indexed, +1 for next
        const hasMoreRetries = nextAttempt <= maxAttempts;
        const nextRetryDelay = hasMoreRetries ? getWebhookRetryDelay(attemptNumber + 1) : null;

        logger.error("Webhook delivery failed", {
          jobId: job.id,
          attempt: attemptNumber + 1,
          maxAttempts,
          hasMoreRetries,
          nextRetryDelayMs: nextRetryDelay,
          nextRetryAt: nextRetryDelay ? new Date(Date.now() + nextRetryDelay).toISOString() : null,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    {
      connection,
      settings: {
        backoffStrategy: (attemptsMade: number) => {
          return getWebhookRetryDelay(attemptsMade);
        },
      },
    },
  );
}

// ─── ERP Sync Worker ───────────────────────────────────────────────────────────

function createErpSyncWorker(): Worker {
  return new Worker<ErpSyncJobData>(
    "erp-sync",
    async (job: Job<ErpSyncJobData>) => {
      const { accountId, doctype, name, erpnextSessionId } = job.data;
      logger.info("Processing ERP sync job", { jobId: job.id, accountId, doctype, name });

      try {
        const result = await erpGet(doctype, name, erpnextSessionId, accountId);

        if (result.ok) {
          logger.info("ERP document synced", { jobId: job.id, accountId, doctype, name });
        } else {
          logger.error("ERP sync failed: document fetch error", {
            jobId: job.id,
            accountId,
            doctype,
            name,
            error: result.error,
          });
          throw new Error(result.error);
        }
      } catch (err) {
        logger.error("ERP sync job error", {
          jobId: job.id,
          accountId,
          doctype,
          name,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    { connection },
  );
}

// ─── Reports Worker ────────────────────────────────────────────────────────────

/**
 * Supported report types and their data sources.
 * Each handler fetches data, aggregates, and returns the report payload.
 * The worker stores the result in the audit log for retrieval.
 *
 * Tenant isolation: every handler runs inside a `withTenantScope` block in
 * the worker dispatcher below so that under the post-Phase-3 `westbridge_app`
 * role the RLS `app.current_account_id` setting is bound for every read.
 * Handlers MUST use the `tx` client passed in (which is bound to the same
 * transaction as the set_config) — using the unscoped `prisma` import
 * would route queries through a different connection where the setting
 * is unset, and RLS would default-deny every row.
 *
 * Handlers also still pass `accountId` in their `where` clauses (Layer 1,
 * primary defence); RLS is the secondary safety net.
 */
type ReportTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const REPORT_HANDLERS: Record<
  string,
  (tx: ReportTx, accountId: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>
> = {
  async revenue_summary(tx, accountId, params) {
    const period = (params.period as string) ?? new Date().toISOString().slice(0, 7);
    const startDate = new Date(`${period}-01`);
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + 1);

    logger.info("Generating revenue summary", { accountId, period });

    const invoiceActivity = await tx.auditLog.count({
      where: {
        accountId,
        action: "erp.doc.create",
        resource: "Sales Invoice",
        timestamp: { gte: startDate, lt: endDate },
      },
    });

    return {
      reportType: "revenue_summary",
      period,
      invoicesCreated: invoiceActivity,
      generatedAt: new Date().toISOString(),
    };
  },

  async audit_export(tx, accountId, params) {
    const days = (params.days as number) ?? 30;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    logger.info("Generating audit export", { accountId, days });

    const logs = await tx.auditLog.findMany({
      where: { accountId, timestamp: { gte: cutoff } },
      orderBy: { timestamp: "desc" },
      take: 10_000,
      select: {
        id: true,
        action: true,
        resource: true,
        resourceId: true,
        userId: true,
        ipAddress: true,
        severity: true,
        outcome: true,
        timestamp: true,
      },
    });

    return {
      reportType: "audit_export",
      days,
      rowCount: logs.length,
      rows: logs,
      generatedAt: new Date().toISOString(),
    };
  },

  async user_activity(tx, accountId, _params) {
    logger.info("Generating user activity report", { accountId });

    const users = await tx.user.findMany({
      where: { accountId },
      select: { id: true, name: true, email: true, role: true, status: true, createdAt: true },
    });

    const activeSessions = await tx.session.count({
      where: {
        user: { accountId },
        expiresAt: { gt: new Date() },
      },
    });

    return {
      reportType: "user_activity",
      userCount: users.length,
      activeSessionCount: activeSessions,
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        status: u.status,
        createdAt: u.createdAt.toISOString(),
      })),
      generatedAt: new Date().toISOString(),
    };
  },
};

/** List of supported report types — export for API validation. */
export const SUPPORTED_REPORT_TYPES = Object.keys(REPORT_HANDLERS);

function createReportsWorker(): Worker {
  return new Worker<ReportJobData>(
    "reports",
    async (job: Job<ReportJobData>) => {
      const { accountId, reportType, params, requestedBy } = job.data;
      logger.info("Report generation started", { jobId: job.id, accountId, reportType, requestedBy });

      const handler = REPORT_HANDLERS[reportType];
      if (!handler) {
        logger.error("Unknown report type", { jobId: job.id, reportType, supported: SUPPORTED_REPORT_TYPES });
        throw new Error(`Unknown report type: ${reportType}. Supported: ${SUPPORTED_REPORT_TYPES.join(", ")}`);
      }

      try {
        // Pin the tenant context for the entire report run so that under
        // the `westbridge_app` runtime role, RLS allows the handler's reads
        // and the audit_logs INSERT below. Hand the transaction client `tx`
        // to the handler so its queries run on the same connection where
        // set_config was called — using the outer `prisma` import would
        // bypass the transaction context entirely and RLS would default-deny.
        const result = await withTenantScope(accountId, async (tx) => {
          const handlerResult = await handler(tx, accountId, params);
          // Store the completed report in the audit log for retrieval by the user
          await tx.auditLog.create({
            data: {
              accountId,
              userId: requestedBy,
              action: "report.generated",
              resource: reportType,
              resourceId: job.id ?? crypto.randomUUID(),
              ipAddress: "worker",
              userAgent: "bullmq-reports-worker",
              metadata: JSON.parse(JSON.stringify(handlerResult)),
              severity: "info",
              outcome: "success",
            },
          });
          return handlerResult;
        });

        // Notify connected clients that their report is ready
        void publish(accountId, {
          type: "report.ready",
          payload: { jobId: job.id, reportType, requestedBy },
          timestamp: new Date().toISOString(),
        });

        logger.info("Report generation completed", {
          jobId: job.id,
          reportType,
          accountId,
          rowCount: (result as Record<string, unknown>).rowCount ?? (result as Record<string, unknown>).userCount ?? 0,
        });

        return result;
      } catch (err) {
        logger.error("Report generation failed", {
          jobId: job.id,
          reportType,
          accountId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    { connection },
  );
}

// ─── Provisioning Worker (M5) ──────────────────────────────────────────────────

/**
 * Drains the provisioning queue. Replaces the fire-and-forget dynamic
 * imports that used to live in billing.service.createAccount /
 * markAccountPaid. Each job retries up to 5 times with exponential backoff
 * via the queue config; on permanent failure the BullMQ failed-jobs list
 * preserves the error and the account stays flagged
 * (`erpnextCompany = "__PROVISIONING_FAILED__"`) by the underlying service.
 */
function createProvisioningWorker(): Worker {
  return new Worker<ProvisioningJobData>(
    "provisioning",
    async (job: Job<ProvisioningJobData>) => {
      const data = job.data;
      logger.info("Processing provisioning job", {
        jobId: job.id,
        task: data.task,
        accountId: data.accountId,
        attempt: job.attemptsMade + 1,
      });

      if (data.task === "erpnext") {
        // Use the underlying provisionErpnextAccount (single attempt) and
        // let BullMQ handle the retry budget. The legacy provisionWithRetry
        // had its own in-memory retry loop that would not survive a restart;
        // BullMQ's attempt counter does survive.
        const { provisionErpnextAccount } = await import("../lib/services/provisioning.service.js");
        const result = await provisionErpnextAccount(data.accountId);
        if (!result.ok) {
          // Throw so BullMQ schedules the next attempt with exponential backoff.
          throw new Error(result.error);
        }
        logger.info("Provisioning job succeeded", {
          jobId: job.id,
          accountId: data.accountId,
          companyName: result.data.companyName,
        });
        return;
      }

      if (data.task === "subscription") {
        const { createSubscription } = await import("../lib/services/subscription.service.js");
        // createSubscription returns Result<T,E>; throw on err so BullMQ retries.
        type CreateSubResult = { ok: true; data: unknown } | { ok: false; error: string } | undefined;
        const result = (await createSubscription(data.accountId, data.plan)) as CreateSubResult;
        if (result && "ok" in result && !result.ok) {
          throw new Error(result.error);
        }
        logger.info("Subscription provisioning job succeeded", {
          jobId: job.id,
          accountId: data.accountId,
          plan: data.plan,
        });
        return;
      }

      // Exhaustive check — TypeScript ensures we covered all task variants.
      const _exhaustive: never = data;
      throw new Error(`Unknown provisioning task: ${JSON.stringify(_exhaustive)}`);
    },
    { connection },
  );
}

// ─── Cortex Worker ─────────────────────────────────────────────────────────────

/**
 * Drains the cortex BullMQ queue. Each event flows through processCortexEvent
 * which loads the row, dispatches to a registered agent (Phase 6 wires the
 * dispatch table), and marks the event processed. The worker is intentionally
 * thin — all logic lives in events/processor.ts so it can be unit tested
 * without spinning up a Worker.
 */
function createCortexWorker(): Worker {
  return new Worker<CortexEventJobData>(
    "cortex",
    async (job: Job<CortexEventJobData>) => {
      const start = Date.now();
      const result = await processCortexEvent(job.data);
      logger.info("cortex event processed", {
        jobId: job.id,
        eventId: job.data.eventId,
        type: job.data.type,
        accountId: job.data.accountId,
        traceId: job.data.traceId,
        status: result.status,
        agentId: result.agentId,
        durationMs: Date.now() - start,
      });
      return result;
    },
    { connection },
  );
}

// ─── Start all workers ─────────────────────────────────────────────────────────

export function startWorkers(): Worker[] {
  const workers = [
    createEmailWorker(),
    createCleanupWorker(),
    createWebhooksWorker(),
    createErpSyncWorker(),
    createReportsWorker(),
    createCortexWorker(),
    createProvisioningWorker(),
  ];

  logger.info("Started BullMQ workers", { count: workers.length });
  return workers;
}
