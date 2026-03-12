import { Router, Request, Response } from "express";
import { list } from "../lib/services/erp.service.js";
import { logAudit, auditContext } from "../lib/services/audit.service.js";
import { validateErpFilters } from "../lib/validation/erp-filters.js";
import { apiSuccess, apiError, apiMeta, getRequestId } from "../types/api.js";
import { checkTieredRateLimit, checkErpAccountRateLimit, getClientIdentifier, rateLimitHeaders } from "../lib/api/rate-limit-tiers.js";
import { requireAuth, requireCsrf, rateLimit, toWebRequest } from "../middleware/auth.js";
import * as Sentry from "@sentry/node";
import { prisma } from "../lib/data/prisma.js";
import { ALLOWED_DOCTYPES_SET } from "../lib/erp-constants.js";
import { getDoc, createDoc, updateDoc, deleteDoc } from "../lib/services/erp.service.js";
import { erpDocCreateBodySchema } from "../types/schemas/erp.js";
import { validateSession } from "../lib/services/session.service.js";
import { COOKIE } from "../lib/constants.js";
import { buildDashboardData, DEMO_DATA } from "../lib/services/dashboard.service.js";

const router = Router();

const MAX_BODY_BYTES = 1_048_576;

// ─── GET /erp/list ─────────────────────────────────────────────────────────────

router.get("/erp/list", requireAuth, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms`, "Cache-Control": "private, no-cache, no-store, must-revalidate", "Vary": "Accept-Encoding, Accept" });

  try {
    const session = req.session!;
    const rateLimit = await checkTieredRateLimit(getClientIdentifier(toWebRequest(req)), "authenticated", "/api/erp/list");
    if (!rateLimit.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(rateLimit) });
      return res.status(429).json(
        apiError("RATE_LIMIT", "Too many requests. Try again in a minute.", undefined, meta())
      );
    }
    const erpAccountLimit = await checkErpAccountRateLimit(session.accountId);
    if (!erpAccountLimit.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(erpAccountLimit) });
      return res.status(429).json(
        apiError("RATE_LIMIT", "Too many ERP requests for this account. Try again in a minute.", undefined, meta())
      );
    }
    const ctx = auditContext(toWebRequest(req));
    const { accountId, erpnextSid } = session;
    if (!erpnextSid) {
      res.set(responseHeaders());
      return res.status(401).json(
        apiError("UNAUTHORIZED", "ERP session not available. Please log in again.", undefined, meta())
      );
    }
    const sid = erpnextSid;

    const doctype = req.query.doctype as string | undefined;
    if (!doctype) {
      res.set(responseHeaders());
      return res.status(400).json(
        apiError("BAD_REQUEST", "doctype required", undefined, meta())
      );
    }
    if (!ALLOWED_DOCTYPES_SET.has(doctype)) {
      res.set(responseHeaders());
      return res.status(400).json(
        apiError("BAD_REQUEST", "Invalid or unsupported document type", undefined, meta())
      );
    }

    const ORDER_BY_ALLOWLIST = new Set([
      "creation desc", "creation asc", "modified desc", "modified asc",
      "name desc", "name asc", "posting_date desc", "posting_date asc",
      "grand_total desc", "grand_total asc", "status desc", "status asc",
    ]);
    const rawOrderBy = (req.query.order_by as string) ?? "creation desc";
    const orderBy = ORDER_BY_ALLOWLIST.has(rawOrderBy.toLowerCase()) ? rawOrderBy : "creation desc";
    const pageSize = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20", 10) || 20));
    const rawPage = (req.query.page as string) ?? "0";
    const pageNum = parseInt(rawPage, 10);
    if (Number.isNaN(pageNum) || pageNum < 0 || !Number.isInteger(pageNum)) {
      res.set(responseHeaders());
      return res.status(400).json(
        apiError("BAD_REQUEST", "page must be a non-negative integer", undefined, meta())
      );
    }
    const MAX_PAGE = 10_000;
    if (pageNum > MAX_PAGE) {
      res.set(responseHeaders());
      return res.status(400).json(
        apiError("BAD_REQUEST", `Page number exceeds maximum (${MAX_PAGE})`, undefined, meta())
      );
    }
    const page = pageNum;
    const limit_start = page * pageSize;
    const fields = req.query.fields as string | undefined;
    const filtersParam = req.query.filters as string | undefined;

    const filtersResult = validateErpFilters(filtersParam);
    if (!filtersResult.ok) {
      res.set(responseHeaders());
      return res.status(400).json(
        apiError("BAD_REQUEST", String(filtersResult.error ?? "Invalid filters"), undefined, meta())
      );
    }

    const params: Record<string, string> = {
      limit_page_length: String(pageSize),
      limit_start: String(limit_start),
      order_by: orderBy,
    };
    if (fields) params.fields = JSON.stringify(fields.split(",").map((f) => f.trim()));
    if (filtersResult.filters && filtersResult.filters.length > 0) params.filters = JSON.stringify(filtersResult.filters);

    const account = await prisma.account.findUnique({ where: { id: accountId }, select: { erpnextCompany: true } }).catch(() => null);
    const result = await list(doctype, sid, params, accountId ?? undefined, account?.erpnextCompany);
    if (!result.ok) {
      const status = result.error === "doctype required" ? 400 : 502;
      res.set(responseHeaders());
      return res.status(status).json(
        apiError("ERP_ERROR", result.error, undefined, meta())
      );
    }
    void logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "erp.list.read",
      resource: doctype,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      severity: "info",
      outcome: "success",
    });
    const hasMore = Array.isArray(result.data) && result.data.length === pageSize;
    res.set(responseHeaders());
    return res.json(
      apiSuccess(result.data, { ...meta(), page, pageSize, hasMore })
    );
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    res.set({ "X-Response-Time": `${Date.now() - start}ms` });
    return res.status(500).json(
      apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta())
    );
  }
});

// ─── GET /erp/doc ──────────────────────────────────────────────────────────────

router.get("/erp/doc", requireAuth, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  try {
    const session = req.session!;
    if (!session.erpnextSid) {
      res.set(responseHeaders());
      return res.status(401).json(apiError("UNAUTHORIZED", "ERP session not available. Please log in again.", undefined, meta()));
    }
    const ctx = auditContext(toWebRequest(req));
    const rateLimitGet = await checkTieredRateLimit(getClientIdentifier(toWebRequest(req)), "authenticated", "/api/erp/doc");
    if (!rateLimitGet.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(rateLimitGet) });
      return res.status(429).json(
        apiError("RATE_LIMIT", "Too many requests. Try again in a minute.", undefined, meta())
      );
    }

    const doctype = req.query.doctype as string | undefined;
    const name = req.query.name as string | undefined;
    if (!doctype || !name) {
      res.set(responseHeaders());
      return res.status(400).json(
        apiError("BAD_REQUEST", "doctype and name required", undefined, meta())
      );
    }
    if (!ALLOWED_DOCTYPES_SET.has(doctype)) {
      res.set(responseHeaders());
      return res.status(400).json(
        apiError("BAD_REQUEST", "Invalid or unsupported document type", undefined, meta())
      );
    }

    const result = await getDoc(doctype, name, session.erpnextSid as string, session.accountId);
    if (!result.ok) {
      const status = result.error === "Not found" ? 404 : 502;
      res.set(responseHeaders());
      return res.status(status).json(
        apiError("ERP_ERROR", result.error, undefined, meta())
      );
    }

    // Tenant isolation: verify the doc belongs to the caller's ERPNext company.
    const account = await prisma.account.findUnique({ where: { id: session.accountId }, select: { erpnextCompany: true } }).catch(() => null);
    if (account?.erpnextCompany) {
      const doc = result.data as Record<string, unknown>;
      if (doc.company && doc.company !== account.erpnextCompany) {
        res.set(responseHeaders());
        return res.status(403).json(
          apiError("FORBIDDEN", "You do not have access to this document", undefined, meta())
        );
      }
    }

    void logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "erp.doc.read",
      resource: doctype,
      resourceId: name,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      severity: "info",
      outcome: "success",
    });
    res.set(responseHeaders());
    return res.json(apiSuccess(result.data, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(
      apiError("SERVER_ERROR", "An unexpected error occurred", undefined, apiMeta({ request_id: requestId }))
    );
  }
});

// ─── POST /erp/doc ─────────────────────────────────────────────────────────────

router.post("/erp/doc", requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  try {
    const contentLength = parseInt(req.headers["content-length"] as string ?? "0", 10);
    if (contentLength > MAX_BODY_BYTES) {
      res.set(responseHeaders());
      return res.status(413).json(
        apiError("PAYLOAD_TOO_LARGE", "Request body exceeds 1MB limit", undefined, meta())
      );
    }

    const session = req.session!;
    const ctx = auditContext(toWebRequest(req));

    if (!session.erpnextSid) {
      res.set(responseHeaders());
      return res.status(401).json(apiError("UNAUTHORIZED", "ERP session not available. Please log in again.", undefined, meta()));
    }

    const rateLimitPost = await checkTieredRateLimit(getClientIdentifier(toWebRequest(req)), "authenticated", "/api/erp/doc");
    if (!rateLimitPost.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(rateLimitPost) });
      return res.status(429).json(
        apiError("RATE_LIMIT", "Too many requests. Try again in a minute.", undefined, meta())
      );
    }

    const body = req.body;

    const parsed = erpDocCreateBodySchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.flatten().fieldErrors;
      const message = (first.doctype as string[])?.[0] ?? "Invalid request";
      res.set(responseHeaders());
      return res.status(400).json(
        apiError("VALIDATION_ERROR", message, undefined, meta())
      );
    }

    const FORBIDDEN_FIELDS = new Set([
      "docstatus", "owner", "modified_by", "creation", "modified",
      "idx", "parent", "parentfield", "parenttype", "amended_from",
    ]);
    const { doctype, ...rawData } = parsed.data as { doctype: string; [k: string]: unknown };
    const data = Object.fromEntries(
      Object.entries(rawData).filter(([k]) => !FORBIDDEN_FIELDS.has(k))
    );
    if (!ALLOWED_DOCTYPES_SET.has(doctype)) {
      res.set(responseHeaders());
      return res.status(400).json(
        apiError("BAD_REQUEST", "Invalid or unsupported document type", undefined, meta())
      );
    }
    const result = await createDoc(doctype, session.erpnextSid as string, data as Record<string, unknown>, session.accountId);
    if (!result.ok) {
      res.set(responseHeaders());
      return res.status(502).json(
        apiError("ERP_ERROR", result.error, undefined, meta())
      );
    }
    const created = result.data as { name?: string };
    void logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "erp.doc.create",
      resource: doctype,
      resourceId: created?.name ?? undefined,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      severity: "info",
      outcome: "success",
    });
    // Meter billable doc creation — fire-and-forget
    const { meter } = await import("../lib/metering.js");
    meter.increment(session.accountId, "erp_docs_created").catch(() => {});
    res.set(responseHeaders());
    return res.json(apiSuccess(result.data, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(
      apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta())
    );
  }
});

// ─── PUT /erp/doc ──────────────────────────────────────────────────────────────

router.put("/erp/doc", requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  try {
    const contentLength = parseInt(req.headers["content-length"] as string ?? "0", 10);
    if (contentLength > MAX_BODY_BYTES) {
      res.set(responseHeaders());
      return res.status(413).json(
        apiError("PAYLOAD_TOO_LARGE", "Request body exceeds 1MB limit", undefined, meta())
      );
    }

    const session = req.session!;
    const ctx = auditContext(toWebRequest(req));

    if (!session.erpnextSid) {
      res.set(responseHeaders());
      return res.status(401).json(apiError("UNAUTHORIZED", "ERP session not available. Please log in again.", undefined, meta()));
    }

    const rateLimitPut = await checkTieredRateLimit(getClientIdentifier(toWebRequest(req)), "authenticated", "/api/erp/doc");
    if (!rateLimitPut.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(rateLimitPut) });
      return res.status(429).json(
        apiError("RATE_LIMIT", "Too many requests. Try again in a minute.", undefined, meta())
      );
    }

    const body = req.body;

    const parsed = erpDocCreateBodySchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.flatten().fieldErrors;
      const message = (first.doctype as string[])?.[0] ?? "Invalid request";
      res.set(responseHeaders());
      return res.status(400).json(
        apiError("VALIDATION_ERROR", message, undefined, meta())
      );
    }

    const FORBIDDEN_FIELDS = new Set([
      "docstatus", "owner", "modified_by", "creation", "modified",
      "idx", "parent", "parentfield", "parenttype", "amended_from",
    ]);
    const { doctype, name, ...rawData } = parsed.data as { doctype: string; name: string; [k: string]: unknown };
    const data = Object.fromEntries(
      Object.entries(rawData).filter(([k]) => !FORBIDDEN_FIELDS.has(k))
    );

    if (!name) {
      res.set(responseHeaders());
      return res.status(400).json(
        apiError("BAD_REQUEST", "name is required for update", undefined, meta())
      );
    }

    if (!ALLOWED_DOCTYPES_SET.has(doctype)) {
      res.set(responseHeaders());
      return res.status(400).json(
        apiError("BAD_REQUEST", "Invalid or unsupported document type", undefined, meta())
      );
    }

    // Tenant isolation: verify the doc belongs to the caller's ERPNext company before updating.
    const accountPut = await prisma.account.findUnique({ where: { id: session.accountId }, select: { erpnextCompany: true } }).catch(() => null);
    if (accountPut?.erpnextCompany) {
      const existing = await getDoc(doctype, name, session.erpnextSid as string, session.accountId);
      if (existing.ok) {
        const doc = existing.data as Record<string, unknown>;
        if (doc.company && doc.company !== accountPut.erpnextCompany) {
          res.set(responseHeaders());
          return res.status(403).json(
            apiError("FORBIDDEN", "You do not have access to this document", undefined, meta())
          );
        }
      }
    }

    const result = await updateDoc(doctype, name, session.erpnextSid as string, data as Record<string, unknown>, session.accountId);
    if (!result.ok) {
      res.set(responseHeaders());
      return res.status(502).json(
        apiError("ERP_ERROR", result.error, undefined, meta())
      );
    }
    void logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "erp.doc.update",
      resource: doctype,
      resourceId: name,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      severity: "info",
      outcome: "success",
    });
    // Meter billable doc update — fire-and-forget
    const { meter } = await import("../lib/metering.js");
    meter.increment(session.accountId, "erp_docs_updated").catch(() => {});
    res.set(responseHeaders());
    return res.json(apiSuccess(result.data, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(
      apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta())
    );
  }
});

// ─── DELETE /erp/doc ────────────────────────────────────────────────────────────

router.delete("/erp/doc", requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  try {
    const session = req.session!;
    const ctx = auditContext(toWebRequest(req));

    if (!session.erpnextSid) {
      res.set(responseHeaders());
      return res.status(401).json(apiError("UNAUTHORIZED", "ERP session not available. Please log in again.", undefined, meta()));
    }

    const rateLimitDelete = await checkTieredRateLimit(getClientIdentifier(toWebRequest(req)), "authenticated", "/api/erp/doc");
    if (!rateLimitDelete.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(rateLimitDelete) });
      return res.status(429).json(
        apiError("RATE_LIMIT", "Too many requests. Try again in a minute.", undefined, meta())
      );
    }

    const doctype = req.query.doctype as string | undefined;
    const name = req.query.name as string | undefined;
    if (!doctype || !name) {
      res.set(responseHeaders());
      return res.status(400).json(
        apiError("BAD_REQUEST", "doctype and name required", undefined, meta())
      );
    }

    if (!ALLOWED_DOCTYPES_SET.has(doctype)) {
      res.set(responseHeaders());
      return res.status(400).json(
        apiError("BAD_REQUEST", "Invalid or unsupported document type", undefined, meta())
      );
    }

    // Tenant isolation: verify the doc belongs to the caller's ERPNext company before deleting.
    const accountDel = await prisma.account.findUnique({ where: { id: session.accountId }, select: { erpnextCompany: true } }).catch(() => null);
    if (accountDel?.erpnextCompany) {
      const existing = await getDoc(doctype, name, session.erpnextSid as string, session.accountId);
      if (existing.ok) {
        const doc = existing.data as Record<string, unknown>;
        if (doc.company && doc.company !== accountDel.erpnextCompany) {
          res.set(responseHeaders());
          return res.status(403).json(
            apiError("FORBIDDEN", "You do not have access to this document", undefined, meta())
          );
        }
      }
    }

    const result = await deleteDoc(doctype, name, session.erpnextSid as string, session.accountId);
    if (!result.ok) {
      res.set(responseHeaders());
      return res.status(502).json(
        apiError("ERP_ERROR", result.error, undefined, meta())
      );
    }
    void logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "erp.doc.delete",
      resource: doctype,
      resourceId: name,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      severity: "info",
      outcome: "success",
    });
    res.set(responseHeaders());
    return res.json(apiSuccess(result.data, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(
      apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta())
    );
  }
});

// ─── GET /erp/dashboard ────────────────────────────────────────────────────────

router.get("/erp/dashboard", requireAuth, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  try {
    const session = req.session!;

    const rateLimit = await checkTieredRateLimit(getClientIdentifier(toWebRequest(req)), "authenticated", "/api/erp/dashboard");
    if (!rateLimit.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(rateLimit) });
      return res.status(429).json(apiError("RATE_LIMIT", "Too many requests", undefined, meta()));
    }

    const { accountId, erpnextSid, userId } = session;

    // Fetch account's ERPNext company for multi-tenant scoping
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { erpnextCompany: true },
    });

    const payload = await buildDashboardData(
      erpnextSid ?? userId,
      accountId,
      account?.erpnextCompany ?? null
    );

    res.set(responseHeaders());
    return res.json(apiSuccess(payload, meta()));
  } catch (err) {
    Sentry.captureException(err);
    res.set(responseHeaders());
    return res.status(500).json(
      apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta())
    );
  }
});

export default router;
