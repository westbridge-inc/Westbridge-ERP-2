/**
 * Audit routes
 *
 * GET /audit         — paginated audit logs for the current account
 * GET /audit/export  — streamed audit log export (CSV or JSON)
 */
import { Router, Request, Response } from "express";
import { logAudit, auditContext, CSV_HEADER, rowToCsv } from "../lib/services/audit.service.js";
import { prisma } from "../lib/data/prisma.js";
import { apiSuccess, apiError, apiMeta, getRequestId } from "../types/api.js";
import { checkTieredRateLimit, rateLimitHeaders } from "../lib/api/rate-limit-tiers.js";
import { requireAuth, requirePermission, toWebRequest } from "../middleware/auth.js";
import * as Sentry from "@sentry/node";

const router = Router();

const MAX_PER_PAGE = 100;
const BATCH_SIZE = 500; // rows per DB query to keep memory footprint low

// ---------------------------------------------------------------------------
// GET /audit — paginated audit logs for the current account
// ---------------------------------------------------------------------------
router.get("/audit", requireAuth, requirePermission("audit_logs:read"), async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = (pagination?: { page: number; per_page: number; total: number; total_pages: number }) =>
    apiMeta({ request_id: requestId, ...(pagination && { pagination }) });
  const ctx = auditContext(toWebRequest(req));

  try {
    const session = req.session!;

    const page = Math.max(1, parseInt(req.query.page as string ?? "1", 10) || 1);
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, parseInt(req.query.per_page as string ?? "20", 10) || 20));
    const actionFilter = (req.query.action as string) ?? undefined;
    const severityFilter = (req.query.severity as string) ?? undefined;
    const fromParam = (req.query.from as string) ?? null;
    const toParam = (req.query.to as string) ?? null;
    const fromDate = fromParam ? new Date(fromParam) : undefined;
    const toDate = toParam ? new Date(toParam) : undefined;

    const where: { accountId: string; action?: string; severity?: string; timestamp?: { gte?: Date; lte?: Date } } = {
      accountId: session.accountId,
    };
    if (actionFilter) where.action = actionFilter;
    if (severityFilter) where.severity = severityFilter;
    if (fromDate || toDate) {
      where.timestamp = {};
      if (fromDate && !isNaN(fromDate.getTime())) where.timestamp.gte = fromDate;
      if (toDate && !isNaN(toDate.getTime())) where.timestamp.lte = toDate;
    }

    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { timestamp: "desc" },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
    ]);

    logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "audit.log.accessed",
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      severity: "info",
      outcome: "success",
    }).catch((err: any) => console.error("Background task failed", err));

    const totalPages = Math.ceil(total / perPage);
    return res
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .json(
        apiSuccess(
          { logs },
          meta({ page, per_page: perPage, total, total_pages: totalPages })
        )
      );
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).set("X-Response-Time", `${Date.now() - start}ms`).json(
      apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta())
    );
  }
});

// ---------------------------------------------------------------------------
// GET /audit/export — streamed audit log export (CSV or JSON)
// ---------------------------------------------------------------------------
router.get("/audit/export", requireAuth, requirePermission("audit_logs:read"), async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const ctx = auditContext(toWebRequest(req));

  // Inline error response helper
  const errorResponse = (code: string, message: string, status: number) =>
    res.status(status).json(
      { error: { code, message }, meta: apiMeta({ request_id: requestId }) }
    );

  try {
    const session = req.session!;
    if (!session || (session.role !== "owner" && session.role !== "admin")) {
      return res.status(403).json(apiError("FORBIDDEN", "Admin access required", undefined, apiMeta({ request_id: requestId })));
    }

    const rateLimit = await checkTieredRateLimit(session.accountId, "authenticated", "/api/audit/export");
    if (!rateLimit.allowed) {
      return res
        .status(429)
        .set(rateLimitHeaders(rateLimit) as Record<string, string>)
        .json(
          { error: { code: "RATE_LIMIT", message: "Audit export rate limit: 5 per hour. Try again later." }, meta: apiMeta({ request_id: requestId }) }
        );
    }

    const fromParam = (req.query.from as string) ?? null;
    const toParam = (req.query.to as string) ?? null;
    const format = (req.query.format as string) === "json" ? "json" : "csv";

    const fromDate = fromParam ? new Date(fromParam) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toDate = toParam ? new Date(toParam) : new Date();

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return errorResponse("BAD_REQUEST", "Invalid date format. Use ISO 8601 (e.g. 2026-01-01).", 400);
    }
    if (fromDate > toDate) {
      return errorResponse("BAD_REQUEST", "'from' must be before 'to'.", 400);
    }

    const fromStr = fromDate.toISOString().slice(0, 10);
    const toStr = toDate.toISOString().slice(0, 10);
    const filename = `audit-${fromStr}-${toStr}.${format}`;

    // Log the export action before streaming begins
    logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "audit.export.started",
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      severity: "info",
      outcome: "success",
      metadata: { format, from: fromStr, to: toStr },
    }).catch((err: any) => console.error("Background task failed", err));

    const contentType = format === "csv" ? "text/csv" : "application/json";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Response-Time": `${Date.now() - start}ms`,
      "Cache-Control": "private, no-store",
      "Transfer-Encoding": "chunked",
    });

    let skip = 0;
    let firstBatch = true;

    if (format === "csv") {
      res.write(CSV_HEADER);
    } else {
      res.write("[\n");
    }

    while (true) {
      const rows = await prisma.auditLog.findMany({
        where: {
          accountId: session.accountId,
          timestamp: { gte: fromDate, lte: toDate },
        },
        orderBy: { timestamp: "asc" },
        skip,
        take: BATCH_SIZE,
        select: {
          timestamp: true,
          action: true,
          userId: true,
          ipAddress: true,
          severity: true,
          outcome: true,
          resource: true,
          resourceId: true,
          metadata: true,
        },
      });

      if (rows.length === 0) break;

      for (const row of rows) {
        if (format === "csv") {
          res.write(rowToCsv(row));
        } else {
          const prefix = firstBatch ? "  " : ",\n  ";
          res.write(prefix + JSON.stringify(row));
          firstBatch = false;
        }
      }

      skip += rows.length;
      if (rows.length < BATCH_SIZE) break;
    }

    if (format === "json") {
      res.write("\n]\n");
    }

    res.end();
  } catch (error) {
    Sentry.captureException(error);
    // If headers haven't been sent yet we can send a JSON error
    if (!res.headersSent) {
      return errorResponse("SERVER_ERROR", "An unexpected error occurred", 500);
    }
    res.end();
  }
});

export default router;
