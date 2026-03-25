/**
 * Customer Portal routes — token-based access for end customers.
 *
 * End customers access their invoices, quotations, and orders via a
 * portal link with a token query parameter. No full Westbridge account
 * or session cookie is required.
 *
 * POST /portal/invite         — (authenticated) Generate portal token and email customer
 * GET  /portal/validate       — Validate a portal token
 * GET  /portal/invoices       — List customer's Sales Invoices
 * GET  /portal/quotations     — List customer's Quotations
 * GET  /portal/orders         — List customer's Sales Orders
 * POST /portal/quotations/accept — Accept a quotation
 * GET  /portal/invoice-pdf    — Download invoice PDF
 */

import { Router, Request, Response } from "express";
import { randomBytes, createHash } from "crypto";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import { prisma } from "../lib/data/prisma.js";
import { requireAuth, requireCsrf, toWebRequest } from "../middleware/auth.js";
import { apiSuccess, apiError, apiMeta, getRequestId } from "../types/api.js";
import { checkTieredRateLimit, getClientIdentifier, rateLimitHeaders } from "../lib/api/rate-limit-tiers.js";
import { logAudit, auditContext } from "../lib/services/audit.service.js";
import { sendEmail } from "../lib/email/index.js";
import { portalInviteEmail } from "../lib/email/templates.js";
import { logger } from "../lib/logger.js";

const router = Router();

const PORTAL_TOKEN_EXPIRY_DAYS = 30;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

interface ValidatedPortalToken {
  customerName: string;
  customerEmail: string;
  accountId: string;
}

async function validatePortalToken(token: string): Promise<ValidatedPortalToken | null> {
  if (!token || typeof token !== "string" || token.length < 10) return null;

  const tokenHash = hashToken(token);
  const record = await prisma.portalToken.findUnique({ where: { tokenHash } });

  if (!record) return null;
  if (record.expiresAt < new Date()) return null;

  return {
    customerName: record.customerName,
    customerEmail: record.customerEmail,
    accountId: record.accountId,
  };
}

/** Build ERPNext API auth headers using API key/secret. */
function erpAuthHeaders(): Record<string, string> {
  const apiKey = process.env.ERPNEXT_API_KEY ?? "";
  const apiSecret = process.env.ERPNEXT_API_SECRET ?? "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey && apiSecret) {
    headers["Authorization"] = `token ${apiKey}:${apiSecret}`;
  }
  return headers;
}

const ERPNEXT_URL = process.env.ERPNEXT_URL ?? "http://localhost:8080";

/** Fetch ERP list for a specific customer, scoped to their account's company. */
async function fetchCustomerDocs(
  doctype: string,
  customerName: string,
  accountId: string,
  extraFilters?: unknown[][],
): Promise<unknown[]> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { erpnextCompany: true },
  });

  const filters: unknown[][] = [
    [doctype, "customer", "=", customerName],
    ...(account?.erpnextCompany ? [[doctype, "company", "=", account.erpnextCompany]] : []),
    ...(extraFilters ?? []),
  ];

  const params = new URLSearchParams({
    filters: JSON.stringify(filters),
    fields: JSON.stringify(["*"]),
    limit_page_length: "100",
    order_by: "creation desc",
  });

  const res = await fetch(`${ERPNEXT_URL}/api/resource/${encodeURIComponent(doctype)}?${params.toString()}`, {
    headers: erpAuthHeaders(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    logger.error("Portal ERP fetch failed", { doctype, status: res.status });
    return [];
  }

  const body = (await res.json()) as { data?: unknown[] };
  return Array.isArray(body?.data) ? body.data : [];
}

// ─── POST /portal/invite ──────────────────────────────────────────────────────

const inviteBodySchema = z.object({
  customerName: z.string().min(1).max(280),
  customerEmail: z.string().email(),
});

router.post("/invite", requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });
  const ctx = auditContext(toWebRequest(req));

  try {
    const session = req.session!;

    const rateLimit = await checkTieredRateLimit(
      getClientIdentifier(toWebRequest(req)),
      "authenticated",
      "/api/portal/invite",
    );
    if (!rateLimit.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(rateLimit) });
      return res.status(429).json(apiError("RATE_LIMIT", "Too many requests.", undefined, meta()));
    }

    const parsed = inviteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.set(responseHeaders());
      return res
        .status(400)
        .json(apiError("VALIDATION_ERROR", "customerName and customerEmail are required", undefined, meta()));
    }

    const { customerName, customerEmail } = parsed.data;
    const { accountId, userId } = session;

    // Generate token
    const raw = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(raw);
    const expiresAt = new Date(Date.now() + PORTAL_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const portalToken = await prisma.portalToken.create({
      data: {
        accountId,
        customerName,
        customerEmail,
        tokenHash,
        expiresAt,
      },
    });

    // Build portal URL
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const portalUrl = `${baseUrl}/portal?token=${raw}`;

    // Get account info for branding
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { companyName: true },
    });

    // Send email
    await sendEmail({
      to: customerEmail,
      subject: `Your documents from ${account?.companyName ?? "Westbridge"}`,
      html: portalInviteEmail({
        customerName,
        companyName: account?.companyName ?? "Westbridge",
        portalUrl,
      }),
    });

    void logAudit({
      accountId,
      userId,
      action: "portal.invite.sent",
      metadata: { customerName, customerEmail },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      severity: "info",
      outcome: "success",
    });

    res.set(responseHeaders());
    return res.json(apiSuccess({ tokenId: portalToken.id, portalUrl }, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
});

// ─── GET /portal/validate ────────────────────────────────────────────────────

router.get("/validate", async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  try {
    const rateLimit = await checkTieredRateLimit(
      getClientIdentifier(toWebRequest(req)),
      "anonymous",
      "/api/portal/validate",
    );
    if (!rateLimit.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(rateLimit) });
      return res.status(429).json(apiError("RATE_LIMIT", "Too many requests.", undefined, meta()));
    }

    const token = req.query.token as string | undefined;
    if (!token) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("BAD_REQUEST", "token is required", undefined, meta()));
    }

    const validated = await validatePortalToken(token);
    if (!validated) {
      res.set(responseHeaders());
      return res
        .status(401)
        .json(
          apiError(
            "INVALID_TOKEN",
            "This link is invalid or has expired. Please contact your vendor for a new link.",
            undefined,
            meta(),
          ),
        );
    }

    // Get company name for display
    const account = await prisma.account.findUnique({
      where: { id: validated.accountId },
      select: { companyName: true },
    });

    res.set(responseHeaders());
    return res.json(
      apiSuccess(
        {
          customerName: validated.customerName,
          customerEmail: validated.customerEmail,
          accountId: validated.accountId,
          companyName: account?.companyName ?? "",
        },
        meta(),
      ),
    );
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
});

// ─── GET /portal/invoices ────────────────────────────────────────────────────

router.get("/invoices", async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  try {
    const rateLimit = await checkTieredRateLimit(
      getClientIdentifier(toWebRequest(req)),
      "anonymous",
      "/api/portal/invoices",
    );
    if (!rateLimit.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(rateLimit) });
      return res.status(429).json(apiError("RATE_LIMIT", "Too many requests.", undefined, meta()));
    }

    const token = req.query.token as string | undefined;
    if (!token) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("BAD_REQUEST", "token is required", undefined, meta()));
    }

    const validated = await validatePortalToken(token);
    if (!validated) {
      res.set(responseHeaders());
      return res.status(401).json(apiError("INVALID_TOKEN", "Invalid or expired token", undefined, meta()));
    }

    const invoices = await fetchCustomerDocs("Sales Invoice", validated.customerName, validated.accountId);

    res.set(responseHeaders());
    return res.json(apiSuccess(invoices, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
});

// ─── GET /portal/quotations ─────────────────────────────────────────────────

router.get("/quotations", async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  try {
    const rateLimit = await checkTieredRateLimit(
      getClientIdentifier(toWebRequest(req)),
      "anonymous",
      "/api/portal/quotations",
    );
    if (!rateLimit.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(rateLimit) });
      return res.status(429).json(apiError("RATE_LIMIT", "Too many requests.", undefined, meta()));
    }

    const token = req.query.token as string | undefined;
    if (!token) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("BAD_REQUEST", "token is required", undefined, meta()));
    }

    const validated = await validatePortalToken(token);
    if (!validated) {
      res.set(responseHeaders());
      return res.status(401).json(apiError("INVALID_TOKEN", "Invalid or expired token", undefined, meta()));
    }

    const quotations = await fetchCustomerDocs("Quotation", validated.customerName, validated.accountId);

    res.set(responseHeaders());
    return res.json(apiSuccess(quotations, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
});

// ─── GET /portal/orders ─────────────────────────────────────────────────────

router.get("/orders", async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  try {
    const rateLimit = await checkTieredRateLimit(
      getClientIdentifier(toWebRequest(req)),
      "anonymous",
      "/api/portal/orders",
    );
    if (!rateLimit.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(rateLimit) });
      return res.status(429).json(apiError("RATE_LIMIT", "Too many requests.", undefined, meta()));
    }

    const token = req.query.token as string | undefined;
    if (!token) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("BAD_REQUEST", "token is required", undefined, meta()));
    }

    const validated = await validatePortalToken(token);
    if (!validated) {
      res.set(responseHeaders());
      return res.status(401).json(apiError("INVALID_TOKEN", "Invalid or expired token", undefined, meta()));
    }

    const orders = await fetchCustomerDocs("Sales Order", validated.customerName, validated.accountId);

    res.set(responseHeaders());
    return res.json(apiSuccess(orders, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
});

// ─── POST /portal/quotations/accept ─────────────────────────────────────────

const acceptQuotationSchema = z.object({
  quotationName: z.string().min(1),
});

router.post("/quotations/accept", async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  try {
    const rateLimit = await checkTieredRateLimit(
      getClientIdentifier(toWebRequest(req)),
      "anonymous",
      "/api/portal/quotations/accept",
    );
    if (!rateLimit.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(rateLimit) });
      return res.status(429).json(apiError("RATE_LIMIT", "Too many requests.", undefined, meta()));
    }

    const token = req.query.token as string | undefined;
    if (!token) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("BAD_REQUEST", "token is required", undefined, meta()));
    }

    const validated = await validatePortalToken(token);
    if (!validated) {
      res.set(responseHeaders());
      return res.status(401).json(apiError("INVALID_TOKEN", "Invalid or expired token", undefined, meta()));
    }

    const parsed = acceptQuotationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("VALIDATION_ERROR", "quotationName is required", undefined, meta()));
    }

    const { quotationName } = parsed.data;

    // Verify quotation belongs to this customer
    const quotations = await fetchCustomerDocs("Quotation", validated.customerName, validated.accountId, [
      ["Quotation", "name", "=", quotationName],
    ]);

    if (quotations.length === 0) {
      res.set(responseHeaders());
      return res.status(404).json(apiError("NOT_FOUND", "Quotation not found", undefined, meta()));
    }

    // Submit the quotation (docstatus = 1) via ERPNext
    const submitRes = await fetch(`${ERPNEXT_URL}/api/resource/Quotation/${encodeURIComponent(quotationName)}`, {
      method: "PUT",
      headers: erpAuthHeaders(),
      body: JSON.stringify({ docstatus: 1 }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!submitRes.ok) {
      logger.error("Portal quotation accept failed", { quotationName, status: submitRes.status });
      res.set(responseHeaders());
      return res
        .status(502)
        .json(apiError("UPSTREAM_ERROR", "Failed to accept quotation. Please try again.", undefined, meta()));
    }

    res.set(responseHeaders());
    return res.json(apiSuccess({ accepted: true, quotationName }, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
});

// ─── GET /portal/invoice-pdf ────────────────────────────────────────────────

router.get("/invoice-pdf", async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  try {
    const rateLimit = await checkTieredRateLimit(
      getClientIdentifier(toWebRequest(req)),
      "anonymous",
      "/api/portal/invoice-pdf",
    );
    if (!rateLimit.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(rateLimit) });
      return res.status(429).json(apiError("RATE_LIMIT", "Too many requests.", undefined, meta()));
    }

    const token = req.query.token as string | undefined;
    const name = req.query.name as string | undefined;
    if (!token || !name) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("BAD_REQUEST", "token and name are required", undefined, meta()));
    }

    const validated = await validatePortalToken(token);
    if (!validated) {
      res.set(responseHeaders());
      return res.status(401).json(apiError("INVALID_TOKEN", "Invalid or expired token", undefined, meta()));
    }

    // Verify the invoice belongs to this customer
    const invoices = await fetchCustomerDocs("Sales Invoice", validated.customerName, validated.accountId, [
      ["Sales Invoice", "name", "=", name],
    ]);

    if (invoices.length === 0) {
      res.set(responseHeaders());
      return res.status(404).json(apiError("NOT_FOUND", "Invoice not found", undefined, meta()));
    }

    // Proxy PDF from ERPNext
    const params = new URLSearchParams({
      doctype: "Sales Invoice",
      name,
      format: "Standard",
      no_letterhead: "0",
    });

    const pdfRes = await fetch(
      `${ERPNEXT_URL}/api/method/frappe.utils.print_format.download_pdf?${params.toString()}`,
      {
        headers: erpAuthHeaders(),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!pdfRes.ok) {
      logger.error("Portal PDF generation failed", { name, status: pdfRes.status });
      res.set(responseHeaders());
      return res.status(502).json(apiError("UPSTREAM_ERROR", "Failed to generate PDF", undefined, meta()));
    }

    const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `Invoice-${safeName}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    return res.send(pdfBuffer);
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
});

export default router;
