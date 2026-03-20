import { Router, Request, Response } from "express";
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
import { requireAuth, requireCsrf, rateLimit, toWebRequest } from "../middleware/auth.js";
import { publish } from "../lib/realtime.js";
import * as Sentry from "@sentry/node";
import { prisma } from "../lib/data/prisma.js";
import { ALLOWED_DOCTYPES_SET, COMPANY_SCOPED_DOCTYPES } from "../lib/erp-constants.js";
import { erpDocCreateBodySchema } from "../types/schemas/erp.js";
import { buildDashboardData } from "../lib/services/dashboard.service.js";

const router = Router();

// ---------------------------------------------------------------------------
// Tenant isolation helper — shared across GET, PUT, DELETE /erp/doc
// ---------------------------------------------------------------------------

/**
 * Verify that a document belongs to the caller's ERPNext company.
 * Returns `true` if access is denied (caller should 403), `false` if OK.
 *
 * Checks the document's actual data (not the user-supplied doctype) to
 * determine whether tenant isolation applies. If the document has no
 * `company` field, access is always allowed.
 */
async function verifyTenantAccess(
  _doctype: string,
  accountId: string,
  docData: Record<string, unknown>,
): Promise<boolean> {
  // Tenant isolation is based on the document's actual company field,
  // not the user-supplied doctype — prevents bypass via crafted doctype.
  if (!docData.company) return false;

  const account = await prisma.account
    .findUnique({ where: { id: accountId }, select: { erpnextCompany: true } })
    .catch(() => null);

  if (!account?.erpnextCompany) return false;

  return docData.company !== account.erpnextCompany;
}

// ─── GET /erp/list ─────────────────────────────────────────────────────────────

router.get("/erp/list", requireAuth, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({
    "X-Response-Time": `${Date.now() - start}ms`,
    "Cache-Control": "private, no-cache, no-store, must-revalidate",
    Vary: "Accept-Encoding, Accept",
  });

  try {
    const session = req.session!;
    const rateLimit = await checkTieredRateLimit(
      getClientIdentifier(toWebRequest(req)),
      "authenticated",
      "/api/erp/list",
    );
    if (!rateLimit.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(rateLimit) });
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
    if (!erpnextSid) {
      res.set(responseHeaders());
      return res
        .status(401)
        .json(apiError("UNAUTHORIZED", "ERP session not available. Please log in again.", undefined, meta()));
    }
    const sid = erpnextSid;

    const doctype = req.query.doctype as string | undefined;
    if (!doctype) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("BAD_REQUEST", "doctype required", undefined, meta()));
    }
    if (!ALLOWED_DOCTYPES_SET.has(doctype)) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("BAD_REQUEST", "Invalid or unsupported document type", undefined, meta()));
    }

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
      // Handle both comma-separated "name,customer" and JSON array '["name","customer"]' formats
      if (fields.startsWith("[")) {
        params.fields = fields;
      } else {
        params.fields = JSON.stringify(fields.split(",").map((f) => f.trim()));
      }
    } else {
      // Default to all fields — ERPNext only returns 'name' without this
      params.fields = JSON.stringify(["*"]);
    }
    if (filtersResult.filters && filtersResult.filters.length > 0)
      params.filters = JSON.stringify(filtersResult.filters);

    const account = await prisma.account
      .findUnique({ where: { id: accountId }, select: { erpnextCompany: true } })
      .catch(() => null);
    // Only pass erpnextCompany for doctypes that actually have a company field —
    // otherwise ERPNext returns 417 for the invalid filter.
    const companyScope = COMPANY_SCOPED_DOCTYPES.has(doctype) ? account?.erpnextCompany : null;
    const result = await list(doctype, sid, params, accountId ?? undefined, companyScope);
    if (!result.ok) {
      const status = result.error === "doctype required" ? 400 : 502;
      res.set(responseHeaders());
      return res.status(status).json(apiError("ERP_ERROR", result.error, undefined, meta()));
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
    return res.json(apiSuccess(result.data, { ...meta(), page, pageSize, hasMore }));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    res.set({ "X-Response-Time": `${Date.now() - start}ms` });
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
});

// ─── GET /erp/doc ──────────────────────────────────────────────────────────────

router.get("/erp/doc", requireAuth, rateLimit("authenticated", "/api/erp/doc"), async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  try {
    const session = req.session!;
    if (!session.erpnextSid) {
      res.set(responseHeaders());
      return res
        .status(401)
        .json(apiError("UNAUTHORIZED", "ERP session not available. Please log in again.", undefined, meta()));
    }
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

    const result = await getDoc(doctype, name, session.erpnextSid as string, session.accountId);
    if (!result.ok) {
      const status = result.error === "Not found" ? 404 : 502;
      res.set(responseHeaders());
      return res.status(status).json(apiError("ERP_ERROR", result.error, undefined, meta()));
    }

    // Tenant isolation
    if (await verifyTenantAccess(doctype, session.accountId, result.data as Record<string, unknown>)) {
      res.set(responseHeaders());
      return res.status(403).json(apiError("FORBIDDEN", "You do not have access to this document", undefined, meta()));
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
    return res
      .status(500)
      .json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, apiMeta({ request_id: requestId })));
  }
});

// ─── POST /erp/doc ─────────────────────────────────────────────────────────────

router.post("/erp/doc", requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  try {
    const session = req.session!;
    const ctx = auditContext(toWebRequest(req));

    if (!session.erpnextSid) {
      res.set(responseHeaders());
      return res
        .status(401)
        .json(apiError("UNAUTHORIZED", "ERP session not available. Please log in again.", undefined, meta()));
    }

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

    const body = req.body;

    const parsed = erpDocCreateBodySchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.flatten().fieldErrors;
      const message = (first.doctype as string[])?.[0] ?? "Invalid request";
      res.set(responseHeaders());
      return res.status(400).json(apiError("VALIDATION_ERROR", message, undefined, meta()));
    }

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
    const { doctype, ...rawData } = parsed.data as { doctype: string; [k: string]: unknown };
    const data = Object.fromEntries(Object.entries(rawData).filter(([k]) => !FORBIDDEN_FIELDS.has(k)));
    if (!ALLOWED_DOCTYPES_SET.has(doctype)) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("BAD_REQUEST", "Invalid or unsupported document type", undefined, meta()));
    }
    const result = await createDoc(
      doctype,
      session.erpnextSid as string,
      data as Record<string, unknown>,
      session.accountId,
    );
    if (!result.ok) {
      res.set(responseHeaders());
      return res.status(502).json(apiError("ERP_ERROR", result.error, undefined, meta()));
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
    void publish(session.accountId, {
      type: "erp.doc_updated",
      payload: { title: `${doctype} created`, message: `${created?.name ?? "New document"} was created` },
      timestamp: new Date().toISOString(),
    });
    // Meter billable doc creation — fire-and-forget
    const { meter } = await import("../lib/metering.js");
    meter.increment(session.accountId, "erp_docs_created").catch(() => {});
    res.set(responseHeaders());
    return res.json(apiSuccess(result.data, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
});

// ─── PUT /erp/doc ──────────────────────────────────────────────────────────────

router.put(
  "/erp/doc",
  requireAuth,
  requireCsrf,
  rateLimit("authenticated", "/api/erp/doc"),
  async (req: Request, res: Response) => {
    const start = Date.now();
    const requestId = getRequestId(toWebRequest(req));
    const meta = () => apiMeta({ request_id: requestId });
    const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

    try {
      const session = req.session!;
      const ctx = auditContext(toWebRequest(req));

      if (!session.erpnextSid) {
        res.set(responseHeaders());
        return res
          .status(401)
          .json(apiError("UNAUTHORIZED", "ERP session not available. Please log in again.", undefined, meta()));
      }

      const body = req.body;

      const parsed = erpDocCreateBodySchema.safeParse(body);
      if (!parsed.success) {
        const first = parsed.error.flatten().fieldErrors;
        const message = (first.doctype as string[])?.[0] ?? "Invalid request";
        res.set(responseHeaders());
        return res.status(400).json(apiError("VALIDATION_ERROR", message, undefined, meta()));
      }

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
      const { doctype, name, ...rawData } = parsed.data as { doctype: string; name: string; [k: string]: unknown };
      const data = Object.fromEntries(Object.entries(rawData).filter(([k]) => !FORBIDDEN_FIELDS.has(k)));

      if (!name) {
        res.set(responseHeaders());
        return res.status(400).json(apiError("BAD_REQUEST", "name is required for update", undefined, meta()));
      }

      if (!ALLOWED_DOCTYPES_SET.has(doctype)) {
        res.set(responseHeaders());
        return res.status(400).json(apiError("BAD_REQUEST", "Invalid or unsupported document type", undefined, meta()));
      }

      // Tenant isolation: always fetch and verify ownership before updating
      const existing = await getDoc(doctype, name, session.erpnextSid as string, session.accountId);
      if (
        existing.ok &&
        (await verifyTenantAccess(doctype, session.accountId, existing.data as Record<string, unknown>))
      ) {
        res.set(responseHeaders());
        return res
          .status(403)
          .json(apiError("FORBIDDEN", "You do not have access to this document", undefined, meta()));
      }

      const result = await updateDoc(
        doctype,
        name,
        session.erpnextSid as string,
        data as Record<string, unknown>,
        session.accountId,
      );
      if (!result.ok) {
        res.set(responseHeaders());
        return res.status(502).json(apiError("ERP_ERROR", result.error, undefined, meta()));
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
      return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
    }
  },
);

// ─── DELETE /erp/doc ────────────────────────────────────────────────────────────

router.delete(
  "/erp/doc",
  requireAuth,
  requireCsrf,
  rateLimit("authenticated", "/api/erp/doc"),
  async (req: Request, res: Response) => {
    const start = Date.now();
    const requestId = getRequestId(toWebRequest(req));
    const meta = () => apiMeta({ request_id: requestId });
    const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

    try {
      const session = req.session!;
      const ctx = auditContext(toWebRequest(req));

      if (!session.erpnextSid) {
        res.set(responseHeaders());
        return res
          .status(401)
          .json(apiError("UNAUTHORIZED", "ERP session not available. Please log in again.", undefined, meta()));
      }

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
      const existing = await getDoc(doctype, name, session.erpnextSid as string, session.accountId);
      if (
        existing.ok &&
        (await verifyTenantAccess(doctype, session.accountId, existing.data as Record<string, unknown>))
      ) {
        res.set(responseHeaders());
        return res
          .status(403)
          .json(apiError("FORBIDDEN", "You do not have access to this document", undefined, meta()));
      }

      const result = await deleteDoc(doctype, name, session.erpnextSid as string, session.accountId);
      if (!result.ok) {
        res.set(responseHeaders());
        return res.status(502).json(apiError("ERP_ERROR", result.error, undefined, meta()));
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
      return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
    }
  },
);

// ─── POST /erp/batch ────────────────────────────────────────────────────────────

router.post(
  "/erp/batch",
  requireAuth,
  requireCsrf,
  rateLimit("authenticated", "/api/erp/batch"),
  async (req: Request, res: Response) => {
    const start = Date.now();
    const requestId = getRequestId(toWebRequest(req));
    const meta = () => apiMeta({ request_id: requestId });
    const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

    try {
      const session = req.session!;
      const ctx = auditContext(toWebRequest(req));

      if (!session.erpnextSid) {
        res.set(responseHeaders());
        return res
          .status(401)
          .json(apiError("UNAUTHORIZED", "ERP session not available. Please log in again.", undefined, meta()));
      }

      const { doctype, items } = req.body as { doctype?: string; items?: unknown[] };

      if (!doctype || typeof doctype !== "string") {
        res.set(responseHeaders());
        return res.status(400).json(apiError("BAD_REQUEST", "doctype is required", undefined, meta()));
      }

      if (!ALLOWED_DOCTYPES_SET.has(doctype)) {
        res.set(responseHeaders());
        return res.status(400).json(apiError("BAD_REQUEST", "Invalid or unsupported document type", undefined, meta()));
      }

      if (!Array.isArray(items) || items.length === 0) {
        res.set(responseHeaders());
        return res.status(400).json(apiError("BAD_REQUEST", "items must be a non-empty array", undefined, meta()));
      }

      const MAX_BATCH_SIZE = 100;
      if (items.length > MAX_BATCH_SIZE) {
        res.set(responseHeaders());
        return res
          .status(400)
          .json(apiError("BAD_REQUEST", `Batch size exceeds maximum of ${MAX_BATCH_SIZE} items`, undefined, meta()));
      }

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

      const results = await Promise.allSettled(
        items.map(async (item) => {
          if (!item || typeof item !== "object") {
            throw new Error("Each item must be an object");
          }
          const rawData = item as Record<string, unknown>;
          const data = Object.fromEntries(Object.entries(rawData).filter(([k]) => !FORBIDDEN_FIELDS.has(k)));
          const result = await createDoc(doctype, session.erpnextSid as string, data, session.accountId);
          if (!result.ok) {
            throw new Error(result.error);
          }
          return result.data;
        }),
      );

      let created = 0;
      let failed = 0;
      const errors: string[] = [];

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === "fulfilled") {
          created++;
        } else {
          failed++;
          if (errors.length < 20) {
            errors.push(`Item ${i + 1}: ${r.reason instanceof Error ? r.reason.message : "Unknown error"}`);
          }
        }
      }

      void logAudit({
        accountId: session.accountId,
        userId: session.userId,
        action: "erp.batch.create",
        resource: doctype,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        severity: "info",
        outcome: failed === 0 ? "success" : "failure",
        meta: { created, failed, total: items.length },
      });

      // Meter billable doc creations — fire-and-forget
      if (created > 0) {
        const { meter } = await import("../lib/metering.js");
        meter.increment(session.accountId, "erp_docs_created", created).catch(() => {});
      }

      res.set(responseHeaders());
      return res.json(apiSuccess({ created, failed, errors }, meta()));
    } catch (error) {
      Sentry.captureException(error, { extra: { request_id: requestId } });
      return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
    }
  },
);

// ─── GET /erp/dashboard ────────────────────────────────────────────────────────

router.get("/erp/dashboard", requireAuth, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  try {
    const session = req.session!;

    const rateLimit = await checkTieredRateLimit(
      getClientIdentifier(toWebRequest(req)),
      "authenticated",
      "/api/erp/dashboard",
    );
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

    const payload = await buildDashboardData(erpnextSid ?? userId, accountId, account?.erpnextCompany ?? null);

    res.set(responseHeaders());
    return res.json(apiSuccess(payload, meta()));
  } catch (err) {
    Sentry.captureException(err);
    res.set(responseHeaders());
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
});

export default router;
