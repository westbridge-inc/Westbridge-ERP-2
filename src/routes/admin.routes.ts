/**
 * Admin routes
 *
 * GET  /admin/flags                  — list all feature flags
 * PUT  /admin/flags                  — update a feature flag (admin only)
 * GET  /admin/jobs                   — queue stats from BullMQ for all queues
 * POST /admin/jobs/:id/retry         — retry a specific failed BullMQ job
 * POST /admin/webhooks/:id/enable    — re-enable a disabled webhook endpoint
 */
import { Router, Request, Response } from "express";
import { getAllFlags, setFlag, type FeatureFlag } from "../lib/feature-flags.js";
import { apiSuccess, apiError, apiMeta, getRequestId } from "../types/api.js";
import * as Sentry from "@sentry/node";
import { z } from "zod";
import { emailQueue, erpSyncQueue, reportsQueue, cleanupQueue } from "../lib/jobs/queue.js";
import type { Queue } from "bullmq";
import { cacheControl } from "../lib/api/cache-headers.js";
import { prisma } from "../lib/data/prisma.js";
import { logAudit } from "../lib/services/audit.service.js";
import { requireAuth, requirePermission, requireCsrf, toWebRequest } from "../middleware/auth.js";

const router = Router();

// ---------------------------------------------------------------------------
// Zod schemas for flag validation
// ---------------------------------------------------------------------------
const flagRuleSchema = z.object({
  condition: z.enum(["user_id", "account_id", "email_domain", "percentage", "environment"]),
  operator: z.enum(["equals", "contains", "in", "percentage_rollout"]),
  value: z.unknown().default(null),
  flagValue: z.union([z.boolean(), z.string(), z.number()]),
});

const flagSchema = z.object({
  key: z.string().min(1).max(100),
  defaultValue: z.union([z.boolean(), z.string(), z.number()]),
  description: z.string().max(500),
  rules: z.array(flagRuleSchema),
});

// ---------------------------------------------------------------------------
// Queue map for job routes
// ---------------------------------------------------------------------------
const QUEUES_LIST = [
  { name: "email", queue: emailQueue },
  { name: "erp-sync", queue: erpSyncQueue },
  { name: "reports", queue: reportsQueue },
  { name: "cleanup", queue: cleanupQueue },
];

const QUEUES_MAP: Record<string, Queue> = {
  email: emailQueue,
  "erp-sync": erpSyncQueue,
  reports: reportsQueue,
  cleanup: cleanupQueue,
};

// ---------------------------------------------------------------------------
// GET /admin/flags — list all feature flags
// ---------------------------------------------------------------------------
router.get("/admin/flags", requireAuth, requirePermission("admin:*"), async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });

  try {
    const flags = await getAllFlags();
    return res.set("X-Response-Time", `${Date.now() - start}ms`).json(apiSuccess(flags, meta()));
  } catch (error) {
    Sentry.captureException(error);
    return res.status(500).set("X-Response-Time", `${Date.now() - start}ms`).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
});

// ---------------------------------------------------------------------------
// PUT /admin/flags — update a feature flag (owner only)
// ---------------------------------------------------------------------------
router.put("/admin/flags", requireAuth, requirePermission("admin:*"), requireCsrf, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });

  try {
    const body = req.body;
    if (!body || Object.keys(body).length === 0) {
      return res.status(400).set("X-Response-Time", `${Date.now() - start}ms`).json(apiError("INVALID_JSON", "Invalid request body", undefined, meta()));
    }

    const parsed = flagSchema.safeParse(body);
    if (!parsed.success) {
      return res.status(400).set("X-Response-Time", `${Date.now() - start}ms`).json(apiError("VALIDATION_ERROR", parsed.error.flatten().formErrors[0] ?? "Invalid flag", undefined, meta()));
    }

    await setFlag(parsed.data as FeatureFlag);

    return res.set("X-Response-Time", `${Date.now() - start}ms`).json(apiSuccess({ updated: true }, meta()));
  } catch (error) {
    Sentry.captureException(error);
    return res.status(500).set("X-Response-Time", `${Date.now() - start}ms`).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
});

// ---------------------------------------------------------------------------
// GET /admin/jobs — queue stats from BullMQ for all queues
// ---------------------------------------------------------------------------
router.get("/admin/jobs", requireAuth, requirePermission("admin:*"), async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });

  try {
    const stats = await Promise.all(
      QUEUES_LIST.map(async ({ name, queue }) => {
        const [waitingCount, activeCount, completedCount, failedCount, failedJobs] = await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
          queue.getCompletedCount(),
          queue.getFailedCount(),
          queue.getFailed(0, 49), // last 50 failed jobs
        ]);

        // Oldest waiting job
        const waiting = await queue.getWaiting(0, 0);
        const oldestWaitingMs = waiting[0]?.timestamp
          ? Date.now() - (waiting[0].timestamp as number)
          : null;

        return {
          queue: name,
          waiting: waitingCount,
          active: activeCount,
          completed: completedCount,
          failed: failedCount,
          oldestWaitingMs,
          failedJobs: failedJobs.slice(0, 10).map((job) => ({
            id: job.id,
            name: job.name,
            data: job.data,
            failedReason: job.failedReason,
            attemptsMade: job.attemptsMade,
            timestamp: job.timestamp,
          })),
        };
      })
    );

    return res
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .set("Cache-Control", cacheControl.private())
      .json(apiSuccess({ queues: stats }, meta()));
  } catch (error) {
    Sentry.captureException(error);
    return res.status(500).set("X-Response-Time", `${Date.now() - start}ms`).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
});

// ---------------------------------------------------------------------------
// POST /admin/jobs/:id/retry — retry a specific failed BullMQ job
// ---------------------------------------------------------------------------
router.post("/admin/jobs/:id/retry", requireAuth, requirePermission("admin:*"), requireCsrf, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });

  try {
    const { id } = req.params;
    const queueName = String(req.query.queue ?? "");

    if (!queueName || !QUEUES_MAP[queueName]) {
      return res.status(400).set("X-Response-Time", `${Date.now() - start}ms`).json(
        apiError("BAD_REQUEST", `Unknown queue. Valid: ${Object.keys(QUEUES_MAP).join(", ")}`, undefined, meta())
      );
    }

    const queue = QUEUES_MAP[queueName]!;
    const job = await queue.getJob(String(id));

    if (!job) {
      return res.status(404).set("X-Response-Time", `${Date.now() - start}ms`).json(apiError("NOT_FOUND", "Job not found", undefined, meta()));
    }

    await job.retry();

    return res.set("X-Response-Time", `${Date.now() - start}ms`).json(apiSuccess({ retried: true, jobId: id }, meta()));
  } catch (error) {
    Sentry.captureException(error);
    return res.status(500).set("X-Response-Time", `${Date.now() - start}ms`).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
});

// ---------------------------------------------------------------------------
// POST /admin/webhooks/:id/enable — re-enable a disabled webhook endpoint
// ---------------------------------------------------------------------------
router.post("/admin/webhooks/:id/enable", requireAuth, requirePermission("admin:*"), requireCsrf, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });

  try {
    const session = req.session!;

    const { id } = req.params;

    // Verify the endpoint belongs to this account
    const endpoint = await prisma.webhookEndpoint.findFirst({
      where: { id: String(id), accountId: String(session.accountId) },
      select: { id: true },
    });

    if (!endpoint) {
      return res.status(404).set("X-Response-Time", `${Date.now() - start}ms`).json(apiError("NOT_FOUND", "Webhook endpoint not found", undefined, meta()));
    }

    await prisma.webhookEndpoint.update({
      where: { id: String(id) },
      data: { disabledAt: null, consecutiveFailures: 0, enabled: true },
    });

    logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "webhook.endpoint.re_enabled",
      resourceId: String(id),
      ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? "unknown",
      severity: "info",
      outcome: "success",
    }).catch((err: any) => console.error("Background task failed", err));

    return res.set("X-Response-Time", `${Date.now() - start}ms`).json(apiSuccess({ enabled: true }, meta()));
  } catch (error) {
    Sentry.captureException(error);
    return res.status(500).set("X-Response-Time", `${Date.now() - start}ms`).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
});

export default router;
