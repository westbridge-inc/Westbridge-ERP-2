/**
 * Report routes
 *
 * POST /reports          — enqueue a report generation job
 * GET  /reports          — list completed reports for the current account
 * GET  /reports/:jobId   — get a specific report result by job ID
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import { apiSuccess, apiError, apiMeta, getRequestId } from "../types/api.js";
import { requireAuth, requirePermission, toWebRequest } from "../middleware/auth.js";
import { validateCsrf, CSRF_COOKIE_NAME } from "../lib/csrf.js";
import { logAudit, auditContext } from "../lib/services/audit.service.js";
import { enqueueReport, reportsQueue } from "../lib/jobs/queue.js";
import { SUPPORTED_REPORT_TYPES } from "../workers/index.js";
import { prisma } from "../lib/data/prisma.js";
import { checkTieredRateLimit, rateLimitHeaders } from "../lib/api/rate-limit-tiers.js";
import * as Sentry from "@sentry/node";

const router = Router();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const generateReportSchema = z.object({
  reportType: z.string().min(1),
  params: z.record(z.unknown()).default({}),
});

// ---------------------------------------------------------------------------
// POST /reports — enqueue a report generation job
// ---------------------------------------------------------------------------
router.post("/reports", requireAuth, requirePermission("reports:create"), async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const ctx = auditContext(toWebRequest(req));

  try {
    const session = req.session!;

    // CSRF validation
    const csrfCookie = req.cookies[CSRF_COOKIE_NAME];
    const csrfHeader = (req.headers["x-csrf-token"] as string) ?? (req.headers["X-CSRF-Token"] as string);
    if (!validateCsrf(csrfHeader, csrfCookie)) {
      logAudit({
        accountId: session.accountId,
        userId: session.userId,
        action: "reports.csrf_failure",
        resourceId: req.path,
        ipAddress: ctx.ipAddress,
        severity: "warn",
        outcome: "failure",
      }).catch((err: any) => console.error("Background task failed", err));
      return res.status(403).json(apiError("FORBIDDEN", "Invalid or missing CSRF token.", undefined, meta()));
    }

    // Rate limit: 10 reports per hour per account
    const rateLimit = await checkTieredRateLimit(session.accountId, "authenticated", "/api/reports");
    if (!rateLimit.allowed) {
      return res
        .status(429)
        .set(rateLimitHeaders(rateLimit) as Record<string, string>)
        .json(apiError("RATE_LIMIT", "Report generation rate limit exceeded. Try again later.", undefined, meta()));
    }

    // Validate request body
    const parsed = generateReportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).set("X-Response-Time", `${Date.now() - start}ms`).json(
        apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body", undefined, meta())
      );
    }

    const { reportType, params } = parsed.data;

    // Validate report type
    if (!SUPPORTED_REPORT_TYPES.includes(reportType)) {
      return res.status(400).set("X-Response-Time", `${Date.now() - start}ms`).json(
        apiError("INVALID_REPORT_TYPE", `Unsupported report type. Supported: ${SUPPORTED_REPORT_TYPES.join(", ")}`, undefined, meta())
      );
    }

    // Enqueue the report job
    const jobId = await enqueueReport({
      accountId: session.accountId,
      reportType,
      params,
      requestedBy: session.userId,
    });

    logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "report.requested",
      resource: reportType,
      resourceId: jobId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      severity: "info",
      outcome: "success",
      metadata: { reportType, params },
    }).catch((err: any) => console.error("Background task failed", err));

    return res
      .status(202)
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .json(apiSuccess({ jobId, reportType, status: "queued" }, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });

    const message = error instanceof Error && error.message.includes("queue capacity")
      ? error.message
      : "An unexpected error occurred";
    const status = error instanceof Error && error.message.includes("queue capacity") ? 503 : 500;

    return res.status(status).set("X-Response-Time", `${Date.now() - start}ms`).json(
      apiError("SERVER_ERROR", message, undefined, meta())
    );
  }
});

// ---------------------------------------------------------------------------
// GET /reports — list completed reports for the current account
// ---------------------------------------------------------------------------
router.get("/reports", requireAuth, requirePermission("reports:read"), async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));

  try {
    const session = req.session!;
    const page = Math.max(1, parseInt(req.query.page as string ?? "1", 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page as string ?? "20", 10) || 20));
    const reportTypeFilter = (req.query.report_type as string) ?? undefined;

    const where: { accountId: string; action: string; resource?: string } = {
      accountId: session.accountId,
      action: "report.generated",
    };
    if (reportTypeFilter) where.resource = reportTypeFilter;

    const [total, reports] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { timestamp: "desc" },
        skip: (page - 1) * perPage,
        take: perPage,
        select: {
          id: true,
          resource: true,
          resourceId: true,
          userId: true,
          metadata: true,
          timestamp: true,
        },
      }),
    ]);

    const totalPages = Math.ceil(total / perPage);

    return res
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .json(apiSuccess(
        {
          reports: reports.map((r) => ({
            id: r.id,
            reportType: r.resource,
            jobId: r.resourceId,
            requestedBy: r.userId,
            data: r.metadata,
            completedAt: r.timestamp.toISOString(),
          })),
        },
        apiMeta({
          request_id: requestId,
          pagination: { page, per_page: perPage, total, total_pages: totalPages },
        })
      ));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).set("X-Response-Time", `${Date.now() - start}ms`).json(
      apiError("SERVER_ERROR", "An unexpected error occurred", undefined, apiMeta({ request_id: requestId }))
    );
  }
});

// ---------------------------------------------------------------------------
// GET /reports/:jobId — get report status or result by job ID
// ---------------------------------------------------------------------------
router.get("/reports/:jobId", requireAuth, requirePermission("reports:read"), async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });

  try {
    const session = req.session!;
    const jobId = req.params.jobId as string;

    // First check BullMQ for active/waiting jobs
    const job = await reportsQueue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      const jobAccountId = (job.data as { accountId?: string })?.accountId;

      // Verify the job belongs to this account
      if (jobAccountId !== session.accountId) {
        return res.status(404).set("X-Response-Time", `${Date.now() - start}ms`).json(
          apiError("NOT_FOUND", "Report not found", undefined, meta())
        );
      }

      if (state === "completed") {
        return res.set("X-Response-Time", `${Date.now() - start}ms`).json(
          apiSuccess({ jobId, status: "completed", data: job.returnvalue }, meta())
        );
      }

      if (state === "failed") {
        return res.set("X-Response-Time", `${Date.now() - start}ms`).json(
          apiSuccess({ jobId, status: "failed", error: job.failedReason }, meta())
        );
      }

      return res.set("X-Response-Time", `${Date.now() - start}ms`).json(
        apiSuccess({ jobId, status: state, reportType: (job.data as { reportType?: string })?.reportType }, meta())
      );
    }

    // Job not in BullMQ (already cleaned up) — check audit log for stored result
    const auditEntry = await prisma.auditLog.findFirst({
      where: {
        accountId: session.accountId,
        action: "report.generated",
        resourceId: jobId,
      },
      select: {
        resource: true,
        metadata: true,
        timestamp: true,
        userId: true,
      },
    });

    if (auditEntry) {
      return res.set("X-Response-Time", `${Date.now() - start}ms`).json(
        apiSuccess({
          jobId,
          status: "completed",
          reportType: auditEntry.resource,
          data: auditEntry.metadata,
          completedAt: auditEntry.timestamp.toISOString(),
          requestedBy: auditEntry.userId,
        }, meta())
      );
    }

    return res.status(404).set("X-Response-Time", `${Date.now() - start}ms`).json(
      apiError("NOT_FOUND", "Report not found", undefined, meta())
    );
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).set("X-Response-Time", `${Date.now() - start}ms`).json(
      apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta())
    );
  }
});

export default router;
