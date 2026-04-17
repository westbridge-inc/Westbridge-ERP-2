const DEV_LOCAL_SESSION = "dev-local-session";
/**
 * ERP controller — business logic extracted from erp.routes.ts.
 *
 * Each function receives the Express request/response and handles the
 * business logic. The thin route file only wires middleware and delegates.
 */

import * as Sentry from "@sentry/node";

import { list, getDoc, createDoc, updateDoc, deleteDoc } from "../lib/services/erp.service.js";
import { logAudit, auditContext } from "../lib/services/audit.service.js";
import { validateErpFilters } from "../lib/validation/erp-filters.js";
import { apiSuccess, apiError, apiMeta, getRequestId } from "../types/api.js";
import {
  checkTieredRateLimit,
  checkErpAccountRateLimit,
  getClientIdentifier,
  rateLimitHeaders,
} from "../lib/api/rate-limit-tiers.js";
import { toWebRequest } from "../middleware/auth.js";
import { publish } from "../lib/realtime.js";
import { prisma } from "../lib/data/prisma.js";
import { getRedis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { ALLOWED_DOCTYPES_SET, COMPANY_SCOPED_DOCTYPES } from "../lib/erp-constants.js";
import { erpDocCreateBodySchema } from "../types/schemas/erp.js";
import { buildDashboardData } from "../lib/services/dashboard.service.js";

import type { Request, Response } from "express";

// ---------------------------------------------------------------------------
// ERP list response cache (Section 82)
// ---------------------------------------------------------------------------
const ERP_LIST_CACHE_PREFIX = "erp:list:";
const ERP_LIST_CACHE_TTL_SEC = 90; // 90s — spec says 60-120s
const ERP_DOC_CACHE_PREFIX = "erp:doc:";
const ERP_DOC_CACHE_TTL_SEC = 60; // 60s — balance freshness with speed

/**
 * Invalidate all cached ERP list responses for a given account + doctype.
 * Uses SCAN to find matching keys rather than KEYS (safe for production).
 * Fire-and-forget — cache misses are non-fatal.
 */
function invalidateErpListCache(accountId: string, doctype: string): void {
  const redis = getRedis();
  if (!redis || !("scanStream" in redis)) return;
  const pattern = `${ERP_LIST_CACHE_PREFIX}${accountId}:${doctype}:*`;
  const stream = (redis as import("ioredis").Redis).scanStream({ match: pattern, count: 100 });
  stream.on("data", (keys: string[]) => {
    if (keys.length > 0) {
      redis
        .del(...keys)
        .catch((e: unknown) =>
          logger.warn("ERP list cache invalidation failed", { error: e instanceof Error ? e.message : String(e) }),
        );
    }
  });
  stream.on("error", (e: Error) => logger.warn("ERP list cache scan failed", { error: e.message }));
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/**
 * Fields that must never be set by end users on ERP documents.
 * Shared across POST and PUT to eliminate duplication.
 */
const FORBIDDEN_FIELDS = new Set([
  "docstatus",
  "owner",
  "modified_by",
  "creation",
  "modified",
  "idx",
  "parent",
  "parentfield",
  "parenttype",
  "amended_from",
]);

const ORDER_BY_ALLOWLIST = new Set([
  "creation desc",
  "creation asc",
  "modified desc",
  "modified asc",
  "name desc",
  "name asc",
  "posting_date desc",
  "posting_date asc",
  "grand_total desc",
  "grand_total asc",
  "status desc",
  "status asc",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MetaFn = () => ReturnType<typeof apiMeta>;

interface RequestContext {
  requestId: string;
  meta: MetaFn;
  responseHeaders: () => Record<string, string>;
}

function buildContext(req: Request, cacheHeaders = false): RequestContext {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  return {
    requestId,
    meta: () => apiMeta({ request_id: requestId }),
    responseHeaders: (): Record<string, string> => {
      const headers: Record<string, string> = {
        "X-Response-Time": `${Date.now() - start}ms`,
      };
      if (cacheHeaders) {
        headers["Cache-Control"] = "private, no-cache, no-store, must-revalidate";
        headers["Vary"] = "Accept-Encoding, Accept";
      }
      return headers;
    },
  };
}

/** Strip forbidden fields from user-supplied document data. */
function stripForbiddenFields(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([k]) => !FORBIDDEN_FIELDS.has(k)));
}

// ---------------------------------------------------------------------------
// Tenant isolation helper
// ---------------------------------------------------------------------------

/**
 * Verify that a document belongs to the caller's ERPNext company.
 * Returns `true` if access is denied (caller should 403), `false` if OK.
 */
async function verifyTenantAccess(
  _doctype: string,
  accountId: string,
  docData: Record<string, unknown>,
): Promise<boolean> {
  if (!docData.company) return false;

  const account = await prisma.account
    .findUnique({ where: { id: accountId }, select: { erpnextCompany: true } })
    .catch(err => { console.error("Ignored Error:", err); return null; });

  if (!account?.erpnextCompany) return false;

  return docData.company !== account.erpnextCompany;
}

// ---------------------------------------------------------------------------
// GET /erp/list
// ---------------------------------------------------------------------------

export async function handleList(req: Request, res: Response): Promise<Response> {
  const { requestId, meta, responseHeaders } = buildContext(req, true);

  try {
    const session = req.session!;
    const rl = await checkTieredRateLimit(getClientIdentifier(toWebRequest(req)), "authenticated", "/api/erp/list");
    if (!rl.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(rl) });
      return res
        .status(429)
        .json(apiError("RATE_LIMIT", "Too many requests. Try again in a minute.", undefined, meta()));
    }
    const erpAccountLimit = await checkErpAccountRateLimit(session.accountId);
    if (!erpAccountLimit.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(erpAccountLimit) });
      return res
        .status(429)
        .json(
          apiError("RATE_LIMIT", "Too many ERP requests for this account. Try again in a minute.", undefined, meta()),
        );
    }
    const ctx = auditContext(toWebRequest(req));
    const { accountId, erpnextSid } = session;
    // Fall back to API-key auth when no per-user ERPNext session is available
    // (e.g. fresh signup that hasn't completed ERPNext login flow yet).
    // The ERP client uses ERPNEXT_API_KEY/SECRET when sid is DEV_LOCAL_SESSION.
    const sid = erpnextSid ?? DEV_LOCAL_SESSION;

    const doctype = req.query.doctype as string | undefined;
    if (!doctype) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("BAD_REQUEST", "doctype required", undefined, meta()));
    }
    if (!ALLOWED_DOCTYPES_SET.has(doctype)) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("BAD_REQUEST", "Invalid or unsupported document type", undefined, meta()));
    }

    const rawOrderBy = (req.query.order_by as string) ?? "creation desc";
    const orderBy = ORDER_BY_ALLOWLIST.has(rawOrderBy.toLowerCase()) ? rawOrderBy : "creation desc";
    const pageSize = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20", 10) || 20));
    const rawPage = (req.query.page as string) ?? "0";
    const pageNum = parseInt(rawPage, 10);
    if (Number.isNaN(pageNum) || pageNum < 0 || !Number.isInteger(pageNum)) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("BAD_REQUEST", "page must be a non-negative integer", undefined, meta()));
    }
    const MAX_PAGE = 10_000;
    if (pageNum > MAX_PAGE) {
      res.set(responseHeaders());
      return res
        .status(400)
        .json(apiError("BAD_REQUEST", `Page number exceeds maximum (${MAX_PAGE})`, undefined, meta()));
    }
    const page = pageNum;
    const limit_start = page * pageSize;
    const fields = req.query.fields as string | undefined;
    const filtersParam = req.query.filters as string | undefined;

    const filtersResult = validateErpFilters(filtersParam);
    if (!filtersResult.ok) {
      res.set(responseHeaders());
      return res
        .status(400)
        .json(apiError("BAD_REQUEST", String(filtersResult.error ?? "Invalid filters"), undefined, meta()));
    }

    const params: Record<string, string> = {
      limit_page_length: String(pageSize),
      limit_start: String(limit_start),
      order_by: orderBy,
    };
    if (fields) {
      if (fields.startsWith("[")) {
        params.fields = fields;
      } else {
        params.fields = JSON.stringify(fields.split(",").map((f) => f.trim()));
      }
    } else {
      params.fields = JSON.stringify(["*"]);
    }
    if (filtersResult.filters && filtersResult.filters.length > 0)
      params.filters = JSON.stringify(filtersResult.filters);

    const account = await prisma.account
      .findUnique({ where: { id: accountId }, select: { erpnextCompany: true } })
      .catch(err => { console.error("Ignored Error:", err); return null; });
    const rawCompany = account?.erpnextCompany;
    const hasValidCompany = !!rawCompany && rawCompany !== "__PROVISIONING_FAILED__";
    // Tenant isolation: company-scoped doctypes without a provisioned company
    // must never return unscoped ERPNext data. Short-circuit to an empty list.
    if (COMPANY_SCOPED_DOCTYPES.has(doctype) && !hasValidCompany) {
      res.set({ ...responseHeaders(), "X-Cache": "BYPASS" });
      return res.json(apiSuccess([], { ...meta(), page, pageSize, hasMore: false }));
    }
    const companyScope = COMPANY_SCOPED_DOCTYPES.has(doctype) ? rawCompany : null;

    // ── ERP list cache (Section 82) ───────────────────────────────────────
    const cacheKey = `${ERP_LIST_CACHE_PREFIX}${accountId}:${doctype}:${JSON.stringify(params)}`;
    const redis = getRedis();
    if (redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached) as { data: unknown[]; hasMore: boolean };
          logAudit({
            accountId: session.accountId,
            userId: session.userId,
            action: "erp.list.read",
            resource: doctype,
            ipAddress: ctx.ipAddress,
            userAgent: ctx.userAgent,
            severity: "info",
            outcome: "success",
            metadata: { cached: true },
          }).catch((err: any) => console.error("Background task failed", err));
          res.set({ ...responseHeaders(), "X-Cache": "HIT" });
          return res.json(apiSuccess(parsed.data, { ...meta(), page, pageSize, hasMore: parsed.hasMore }));
        }
      } catch (e) {
        logger.warn("ERP list cache read failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }

    const result = await list(doctype, sid, params, accountId ?? undefined, companyScope);
    if (!result.ok) {
      const status = result.error === "doctype required" ? 400 : 502;
      res.set(responseHeaders());
      const message = status === 400 ? result.error : "Unable to load data right now. Please try again.";
      return res.status(status).json(apiError("ERP_ERROR", message, undefined, meta()));
    }
    logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "erp.list.read",
      resource: doctype,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      severity: "info",
      outcome: "success",
    }).catch((err: any) => console.error("Background task failed", err));
    const hasMore = Array.isArray(result.data) && result.data.length === pageSize;

    // Cache the successful response
    if (redis) {
      redis
        .set(cacheKey, JSON.stringify({ data: result.data, hasMore }), "EX", ERP_LIST_CACHE_TTL_SEC)
        .catch((e: unknown) =>
          logger.warn("ERP list cache write failed", { error: e instanceof Error ? e.message : String(e) }),
        );
    }

    res.set({ ...responseHeaders(), "X-Cache": "MISS" });
    return res.json(apiSuccess(result.data, { ...meta(), page, pageSize, hasMore }));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    res.set(responseHeaders());
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
}

// ---------------------------------------------------------------------------
// GET /erp/doc
// ---------------------------------------------------------------------------

export async function handleGetDoc(req: Request, res: Response): Promise<Response> {
  const { requestId, meta, responseHeaders } = buildContext(req);

  try {
    const session = req.session!;
    const ctx = auditContext(toWebRequest(req));

    const doctype = req.query.doctype as string | undefined;
    const name = req.query.name as string | undefined;
    if (!doctype || !name) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("BAD_REQUEST", "doctype and name required", undefined, meta()));
    }
    if (!ALLOWED_DOCTYPES_SET.has(doctype)) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("BAD_REQUEST", "Invalid or unsupported document type", undefined, meta()));
    }

    // ── ERP doc cache ─────────────────────────────────────────────────────
    const docCacheKey = `${ERP_DOC_CACHE_PREFIX}${session.accountId}:${doctype}:${name}`;
    const redisForDoc = getRedis();
    if (redisForDoc) {
      try {
        const cached = await redisForDoc.get(docCacheKey);
        if (cached) {
          res.set({ ...responseHeaders(), "X-Cache": "HIT" });
          return res.json(apiSuccess(JSON.parse(cached), meta()));
        }
      } catch (e) {
        logger.warn("ERP doc cache read failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }

    const result = await getDoc(doctype, name, session.erpnextSid ?? DEV_LOCAL_SESSION, session.accountId);
    if (!result.ok) {
      const status = result.error === "Not found" ? 404 : 502;
      res.set(responseHeaders());
      const message = status === 404 ? "Document not found." : "Unable to load data right now. Please try again.";
      return res.status(status).json(apiError("ERP_ERROR", message, undefined, meta()));
    }

    // Tenant isolation
    if (await verifyTenantAccess(doctype, session.accountId, result.data as Record<string, unknown>)) {
      res.set(responseHeaders());
      return res.status(403).json(apiError("FORBIDDEN", "You do not have access to this document", undefined, meta()));
    }

    logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "erp.doc.read",
      resource: doctype,
      resourceId: name,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      severity: "info",
      outcome: "success",
    }).catch((err: any) => console.error("Background task failed", err));

    // Cache the successful response
    if (redisForDoc) {
      redisForDoc
        .set(docCacheKey, JSON.stringify(result.data), "EX", ERP_DOC_CACHE_TTL_SEC)
        .catch((e: unknown) =>
          logger.warn("ERP doc cache write failed", { error: e instanceof Error ? e.message : String(e) }),
        );
    }

    res.set({ ...responseHeaders(), "X-Cache": "MISS" });
    return res.json(apiSuccess(result.data, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res
      .status(500)
      .json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, apiMeta({ request_id: requestId })));
  }
}

// ---------------------------------------------------------------------------
// POST /erp/doc
// ---------------------------------------------------------------------------

export async function handleCreateDoc(req: Request, res: Response): Promise<Response> {
  const { requestId, meta, responseHeaders } = buildContext(req);

  try {
    const session = req.session!;
    const ctx = auditContext(toWebRequest(req));

    const rateLimitPost = await checkTieredRateLimit(
      getClientIdentifier(toWebRequest(req)),
      "authenticated",
      "/api/erp/doc",
    );
    if (!rateLimitPost.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(rateLimitPost) });
      return res
        .status(429)
        .json(apiError("RATE_LIMIT", "Too many requests. Try again in a minute.", undefined, meta()));
    }

    const parsed = erpDocCreateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.flatten().fieldErrors;
      const message = (first.doctype as string[])?.[0] ?? "Invalid request";
      res.set(responseHeaders());
      return res.status(400).json(apiError("VALIDATION_ERROR", message, undefined, meta()));
    }

    const { doctype, ...rawData } = parsed.data as { doctype: string; [k: string]: unknown };
    const data = stripForbiddenFields(rawData);
    if (!ALLOWED_DOCTYPES_SET.has(doctype)) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("BAD_REQUEST", "Invalid or unsupported document type", undefined, meta()));
    }
    const result = await createDoc(
      doctype,
      session.erpnextSid ?? DEV_LOCAL_SESSION,
      data as Record<string, unknown>,
      session.accountId,
    );
    if (!result.ok) {
      res.set(responseHeaders());
      return res
        .status(502)
        .json(apiError("ERP_ERROR", "Unable to create the document right now. Please try again.", undefined, meta()));
    }
    // Invalidate ERP list cache for this account + doctype after mutation
    invalidateErpListCache(session.accountId, doctype);
    const created = result.data as { name?: string };
    logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "erp.doc.create",
      resource: doctype,
      resourceId: created?.name ?? undefined,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      severity: "info",
      outcome: "success",
    }).catch((err: any) => console.error("Background task failed", err));
    publish(session.accountId, {
      type: "erp.doc_updated",
      payload: { title: `${doctype} created`, message: `${created?.name ?? "New document"} was created` },
      timestamp: new Date().toISOString(),
    }).catch((err: any) => console.error("Background task failed", err));
    // Meter billable doc creation -- fire-and-forget
    const { meter } = await import("../lib/metering.js");
    meter.increment(session.accountId, "erp_docs_created").catch(() => {});
    res.set(responseHeaders());
    return res.json(apiSuccess(result.data, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
}

// ---------------------------------------------------------------------------
// PUT /erp/doc
// ---------------------------------------------------------------------------

export async function handleUpdateDoc(req: Request, res: Response): Promise<Response> {
  const { requestId, meta, responseHeaders } = buildContext(req);

  try {
    const session = req.session!;
    const ctx = auditContext(toWebRequest(req));

    const parsed = erpDocCreateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.flatten().fieldErrors;
      const message = (first.doctype as string[])?.[0] ?? "Invalid request";
      res.set(responseHeaders());
      return res.status(400).json(apiError("VALIDATION_ERROR", message, undefined, meta()));
    }

    const { doctype, name, ...rawData } = parsed.data as { doctype: string; name: string; [k: string]: unknown };
    const data = stripForbiddenFields(rawData);

    if (!name) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("BAD_REQUEST", "name is required for update", undefined, meta()));
    }

    if (!ALLOWED_DOCTYPES_SET.has(doctype)) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("BAD_REQUEST", "Invalid or unsupported document type", undefined, meta()));
    }

    // Tenant isolation: always fetch and verify ownership before updating
    const existing = await getDoc(doctype, name, session.erpnextSid ?? DEV_LOCAL_SESSION, session.accountId);
    if (
      existing.ok &&
      (await verifyTenantAccess(doctype, session.accountId, existing.data as Record<string, unknown>))
    ) {
      res.set(responseHeaders());
      return res.status(403).json(apiError("FORBIDDEN", "You do not have access to this document", undefined, meta()));
    }

    const result = await updateDoc(
      doctype,
      name,
      session.erpnextSid ?? DEV_LOCAL_SESSION,
      data as Record<string, unknown>,
      session.accountId,
    );
    if (!result.ok) {
      res.set(responseHeaders());
      return res
        .status(502)
        .json(apiError("ERP_ERROR", "Unable to update the document right now. Please try again.", undefined, meta()));
    }
    // Invalidate ERP list cache for this account + doctype after mutation
    invalidateErpListCache(session.accountId, doctype);
    logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "erp.doc.update",
      resource: doctype,
      resourceId: name,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      severity: "info",
      outcome: "success",
    }).catch((err: any) => console.error("Background task failed", err));
    // Meter billable doc update -- fire-and-forget
    const { meter } = await import("../lib/metering.js");
    meter.increment(session.accountId, "erp_docs_updated").catch(() => {});
    res.set(responseHeaders());
    return res.json(apiSuccess(result.data, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
}

// ---------------------------------------------------------------------------
// DELETE /erp/doc
// ---------------------------------------------------------------------------

export async function handleDeleteDoc(req: Request, res: Response): Promise<Response> {
  const { requestId, meta, responseHeaders } = buildContext(req);

  try {
    const session = req.session!;
    const ctx = auditContext(toWebRequest(req));

    const doctype = req.query.doctype as string | undefined;
    const name = req.query.name as string | undefined;
    if (!doctype || !name) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("BAD_REQUEST", "doctype and name required", undefined, meta()));
    }

    if (!ALLOWED_DOCTYPES_SET.has(doctype)) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("BAD_REQUEST", "Invalid or unsupported document type", undefined, meta()));
    }

    // Tenant isolation: always fetch and verify ownership before deleting
    const existing = await getDoc(doctype, name, session.erpnextSid ?? DEV_LOCAL_SESSION, session.accountId);
    if (
      existing.ok &&
      (await verifyTenantAccess(doctype, session.accountId, existing.data as Record<string, unknown>))
    ) {
      res.set(responseHeaders());
      return res.status(403).json(apiError("FORBIDDEN", "You do not have access to this document", undefined, meta()));
    }

    const result = await deleteDoc(doctype, name, session.erpnextSid ?? DEV_LOCAL_SESSION, session.accountId);
    if (!result.ok) {
      res.set(responseHeaders());
      return res
        .status(502)
        .json(apiError("ERP_ERROR", "Unable to delete the document right now. Please try again.", undefined, meta()));
    }
    // Invalidate ERP list cache for this account + doctype after mutation
    invalidateErpListCache(session.accountId, doctype);
    logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "erp.doc.delete",
      resource: doctype,
      resourceId: name,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      severity: "info",
      outcome: "success",
    }).catch((err: any) => console.error("Background task failed", err));
    res.set(responseHeaders());
    return res.json(apiSuccess(result.data, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
}

// ---------------------------------------------------------------------------
// GET /erp/dashboard
// ---------------------------------------------------------------------------

export async function handleDashboard(req: Request, res: Response): Promise<Response> {
  const { meta, responseHeaders } = buildContext(req);

  try {
    const session = req.session!;

    const rl = await checkTieredRateLimit(
      getClientIdentifier(toWebRequest(req)),
      "authenticated",
      "/api/erp/dashboard",
    );
    if (!rl.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(rl) });
      return res.status(429).json(apiError("RATE_LIMIT", "Too many requests", undefined, meta()));
    }

    const { accountId, erpnextSid, userId } = session;

    // Fetch account's ERPNext company for multi-tenant scoping
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { erpnextCompany: true },
    });

    // Tenant isolation: if the account has no provisioned ERPNext company
    // (fresh signup still in-flight, or provisioning failed), return empty
    // data instead of unscoped ERPNext results. Never leak cross-tenant data.
    const companyName = account?.erpnextCompany;
    if (!companyName || companyName === "__PROVISIONING_FAILED__") {
      const { EMPTY_DATA } = await import("../lib/services/dashboard.service.js");
      res.set(responseHeaders());
      return res.json(apiSuccess(EMPTY_DATA, meta()));
    }

    const payload = await buildDashboardData(erpnextSid ?? userId, accountId, companyName);

    res.set(responseHeaders());
    return res.json(apiSuccess(payload, meta()));
  } catch (err) {
    Sentry.captureException(err);
    res.set(responseHeaders());
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
}
