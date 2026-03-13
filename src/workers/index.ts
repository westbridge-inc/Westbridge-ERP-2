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
import { logger } from "../lib/logger.js";
import { DATA_RETENTION } from "../lib/data-retention.js";
import { erpGet } from "../lib/data/erpnext.client.js";
import { decrypt } from "../lib/encryption.js";
import { publish } from "../lib/realtime.js";
import { getRedisConfig } from "../lib/redis.js";

// ─── SSRF Protection ──────────────────────────────────────────────────────────

/**
 * Check if an IP address belongs to a private/reserved range.
 * Blocks: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 *         169.254.0.0/16, 0.0.0.0/8, ::1, fc00::/7, fe80::/10
 */
function isPrivateIp(ip: string): boolean {
  // IPv6 loopback and private ranges
  if (ip === "::1" || ip === "::") return true;
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;  // fc00::/7
  if (ip.startsWith("fe80")) return true;                        // fe80::/10

  // IPv4 — handle IPv4-mapped IPv6 (::ffff:x.x.x.x)
  let v4 = ip;
  if (ip.startsWith("::ffff:")) {
    v4 = ip.slice(7);
  }

  const parts = v4.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;

  if (a === 0) return true;                                       // 0.0.0.0/8
  if (a === 10) return true;                                      // 10.0.0.0/8
  if (a === 127) return true;                                     // 127.0.0.0/8
  if (a === 169 && b === 254) return true;                        // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true;               // 172.16.0.0/12
  if (a === 192 && b === 168) return true;                        // 192.168.0.0/16
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
  try { addresses.push(...(await resolve4(hostname))); } catch { /* no A records */ }
  try { addresses.push(...(await resolve6(hostname))); } catch { /* no AAAA records */ }

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
} from "../lib/jobs/queue.js";

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
        const result = await prisma.session.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        logger.info("Deleted expired sessions", { jobId: job.id, count: result.count });
      } else if (task === "audit_logs") {
        const cutoff = new Date(Date.now() - DATA_RETENTION.AUDIT_LOGS_DAYS * 24 * 60 * 60 * 1000);
        const result = await prisma.auditLog.deleteMany({
          where: { timestamp: { lt: cutoff } },
        });
        logger.info("Deleted old audit logs", { jobId: job.id, count: result.count, retentionDays: DATA_RETENTION.AUDIT_LOGS_DAYS });
      }
    },
    { connection },
  );
}

// ─── Webhooks Worker ───────────────────────────────────────────────────────────

function createWebhooksWorker(): Worker {
  return new Worker<WebhookJobData>(
    "webhooks",
    async (job: Job<WebhookJobData>) => {
      const { endpointId, event, payload, deliveryId } = job.data;
      logger.info("Processing webhook job", { jobId: job.id, event, endpointId });

      const endpoint = await prisma.webhookEndpoint.findUnique({
        where: { id: endpointId },
      });

      if (!endpoint || !endpoint.enabled) {
        logger.warn("Skipping webhook: endpoint not found or disabled", { jobId: job.id, endpointId });
        return;
      }

      try {
        // SSRF protection: verify the webhook URL does not target private/reserved IPs
        await assertNotPrivateUrl(endpoint.url);

        const secret = decrypt(endpoint.secret);
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
        await prisma.webhookEndpoint.update({
          where: { id: endpointId },
          data: { consecutiveFailures: 0 },
        });
        logger.info("Webhook delivered", { jobId: job.id, url: endpoint.url });
      } catch (err) {
        const newFailures = endpoint.consecutiveFailures + 1;
        const shouldDisable = newFailures >= 5;

        await prisma.webhookEndpoint.update({
          where: { id: endpointId },
          data: {
            consecutiveFailures: newFailures,
            ...(shouldDisable ? { enabled: false, disabledAt: new Date() } : {}),
          },
        });

        if (shouldDisable) {
          logger.warn("Webhook endpoint disabled after consecutive failures", { endpointId, consecutiveFailures: newFailures });
        }

        logger.error("Webhook delivery failed", { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },
    { connection },
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
          logger.error("ERP sync failed: document fetch error", { jobId: job.id, accountId, doctype, name, error: result.error });
          throw new Error(result.error);
        }
      } catch (err) {
        logger.error("ERP sync job error", { jobId: job.id, accountId, doctype, name, error: err instanceof Error ? err.message : String(err) });
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
 */
const REPORT_HANDLERS: Record<
  string,
  (accountId: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>
> = {
  async revenue_summary(accountId, params) {
    const period = (params.period as string) ?? new Date().toISOString().slice(0, 7);
    const startDate = new Date(`${period}-01`);
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + 1);

    logger.info("Generating revenue summary", { accountId, period });

    const invoiceActivity = await prisma.auditLog.count({
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

  async audit_export(accountId, params) {
    const days = (params.days as number) ?? 30;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    logger.info("Generating audit export", { accountId, days });

    const logs = await prisma.auditLog.findMany({
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

  async user_activity(accountId, _params) {
    logger.info("Generating user activity report", { accountId });

    const users = await prisma.user.findMany({
      where: { accountId },
      select: { id: true, name: true, email: true, role: true, status: true, createdAt: true },
    });

    const activeSessions = await prisma.session.count({
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
        const result = await handler(accountId, params);

        // Store the completed report in the audit log for retrieval by the user
        await prisma.auditLog.create({
          data: {
            accountId,
            userId: requestedBy,
            action: "report.generated",
            resource: reportType,
            resourceId: job.id ?? crypto.randomUUID(),
            ipAddress: "worker",
            userAgent: "bullmq-reports-worker",
            metadata: JSON.parse(JSON.stringify(result)),
            severity: "info",
            outcome: "success",
          },
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

// ─── Start all workers ─────────────────────────────────────────────────────────

export function startWorkers(): Worker[] {
  const workers = [
    createEmailWorker(),
    createCleanupWorker(),
    createWebhooksWorker(),
    createErpSyncWorker(),
    createReportsWorker(),
  ];

  logger.info("Started BullMQ workers", { count: workers.length });
  return workers;
}
