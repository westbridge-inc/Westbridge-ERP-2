/**
 * OpenAPI 3.1 spec generator.
 * Generates the spec from registered route schemas using @asteasolutions/zod-to-openapi.
 * Served at GET /api/docs.
 */
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// MUST be called before any registry.register() call so that the .openapi()
// fluent helper is grafted onto the Zod prototype. Without this, every
// schema registration crashes with "zodSchema.openapi is not a function"
// and GET /api/docs returns a 500. Reproduced live: prod was 500'ing because
// this line was missing.
extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// ─── Common schemas ───────────────────────────────────────────────────────────

const ErrorSchema = registry.register(
  "Error",
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
    }),
  }),
);

const SuccessSchema = <T extends z.ZodTypeAny>(dataSchema: T) => z.object({ ok: z.literal(true), data: dataSchema });

// ─── Auth routes ──────────────────────────────────────────────────────────────

const LoginBodySchema = registry.register(
  "LoginBody",
  z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }),
);

const LoginResponseSchema = registry.register(
  "LoginResponse",
  SuccessSchema(z.object({ userId: z.string(), accountId: z.string(), role: z.string() })),
);

registry.registerPath({
  method: "post",
  path: "/api/auth/login",
  tags: ["Authentication"],
  summary: "Log in with email and password",
  request: { body: { content: { "application/json": { schema: LoginBodySchema } } } },
  responses: {
    200: { description: "Login successful", content: { "application/json": { schema: LoginResponseSchema } } },
    401: { description: "Invalid credentials", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const ForgotPasswordBodySchema = registry.register("ForgotPasswordBody", z.object({ email: z.string().email() }));

registry.registerPath({
  method: "post",
  path: "/api/auth/forgot-password",
  tags: ["Authentication"],
  summary: "Request a password reset email",
  request: { body: { content: { "application/json": { schema: ForgotPasswordBodySchema } } } },
  responses: {
    200: { description: "Always returns 200 (prevents enumeration)" },
  },
});

// ─── ERP routes ───────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/erp/list",
  tags: ["ERP"],
  summary: "List ERP documents",
  security: [{ cookieAuth: [] }],
  request: {
    query: z.object({
      doctype: z.string(),
      limit: z.string().optional(),
      offset: z.string().optional(),
      order_by: z.string().optional(),
      filters: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Document list" },
    401: { description: "Unauthenticated", content: { "application/json": { schema: ErrorSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ─── Health routes ────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/health",
  tags: ["Operations"],
  summary: "Comprehensive health check",
  responses: {
    200: { description: "Healthy or degraded" },
    503: { description: "Unhealthy (critical dependency down)" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/health/ready",
  tags: ["Operations"],
  summary: "Readiness probe — all critical dependencies up",
  responses: { 200: { description: "Ready" }, 503: { description: "Not ready" } },
});

registry.registerPath({
  method: "get",
  path: "/api/health/live",
  tags: ["Operations"],
  summary: "Liveness probe — process is alive",
  responses: { 200: { description: "Alive" } },
});

// ─── Signup routes ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/signup",
  tags: ["Authentication"],
  summary: "Create a new account",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().email(),
            companyName: z.string(),
            plan: z.enum(["Starter", "Business", "Enterprise"]),
            modulesSelected: z.array(z.string()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Account created" },
    400: { description: "Validation error" },
    429: { description: "Rate limited" },
  },
});

// ─── CSRF routes ─────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/csrf",
  tags: ["Authentication"],
  summary: "Get CSRF token (double-submit cookie)",
  responses: { 200: { description: "CSRF token set in cookie and body" } },
});

// ─── ERP doc routes ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/erp/doc",
  tags: ["ERP"],
  summary: "Get a single ERP document",
  security: [{ cookieAuth: [] }],
  request: { query: z.object({ doctype: z.string(), name: z.string() }) },
  responses: {
    200: { description: "Document data" },
    401: { description: "Unauthenticated" },
    404: { description: "Not found" },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/erp/doc",
  tags: ["ERP"],
  summary: "Create a new ERP document",
  security: [{ cookieAuth: [] }],
  responses: {
    200: { description: "Document created" },
    400: { description: "Validation error" },
    401: { description: "Unauthenticated" },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/erp/doc",
  tags: ["ERP"],
  summary: "Update an ERP document",
  security: [{ cookieAuth: [] }],
  responses: { 200: { description: "Document updated" }, 401: { description: "Unauthenticated" } },
});

registry.registerPath({
  method: "delete",
  path: "/api/erp/doc",
  tags: ["ERP"],
  summary: "Delete an ERP document",
  security: [{ cookieAuth: [] }],
  responses: { 200: { description: "Document deleted" }, 401: { description: "Unauthenticated" } },
});

registry.registerPath({
  method: "get",
  path: "/api/erp/dashboard",
  tags: ["ERP"],
  summary: "Dashboard aggregated data (revenue, deals, employees)",
  security: [{ cookieAuth: [] }],
  responses: { 200: { description: "Dashboard data" }, 401: { description: "Unauthenticated" } },
});

// ─── Reports routes ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/reports",
  tags: ["Reports"],
  summary: "Enqueue a report generation job",
  security: [{ cookieAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            reportType: z.enum(["revenue_summary", "audit_export", "user_activity"]),
            params: z.record(z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    202: { description: "Report job enqueued" },
    400: { description: "Invalid report type" },
    429: { description: "Rate limited" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/reports",
  tags: ["Reports"],
  summary: "List completed reports",
  security: [{ cookieAuth: [] }],
  request: {
    query: z.object({
      page: z.string().optional(),
      per_page: z.string().optional(),
      report_type: z.string().optional(),
    }),
  },
  responses: { 200: { description: "Paginated report list" } },
});

registry.registerPath({
  method: "get",
  path: "/api/reports/{jobId}",
  tags: ["Reports"],
  summary: "Get report status or result by job ID",
  security: [{ cookieAuth: [] }],
  responses: { 200: { description: "Report status/data" }, 404: { description: "Report not found" } },
});

// ─── Account routes ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "patch",
  path: "/api/account/profile",
  tags: ["Account"],
  summary: "Update user profile",
  security: [{ cookieAuth: [] }],
  responses: { 200: { description: "Profile updated" } },
});

registry.registerPath({
  method: "get",
  path: "/api/account/export",
  tags: ["Account"],
  summary: "GDPR data export (Article 20)",
  security: [{ cookieAuth: [] }],
  responses: { 200: { description: "JSON data export" } },
});

registry.registerPath({
  method: "delete",
  path: "/api/account/delete",
  tags: ["Account"],
  summary: "GDPR account deletion (owner only)",
  security: [{ cookieAuth: [] }],
  responses: { 200: { description: "Account deleted" }, 403: { description: "Not owner" } },
});

// ─── Team routes ─────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/team",
  tags: ["Team"],
  summary: "List team members",
  security: [{ cookieAuth: [] }],
  responses: { 200: { description: "Team member list" } },
});

// ─── Invite routes ───────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/invite",
  tags: ["Team"],
  summary: "Send team invite",
  security: [{ cookieAuth: [] }],
  responses: { 200: { description: "Invite sent" }, 400: { description: "Validation error" } },
});

// ─── Audit routes ────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/audit",
  tags: ["Audit"],
  summary: "Paginated audit logs",
  security: [{ cookieAuth: [] }],
  request: {
    query: z.object({
      page: z.string().optional(),
      per_page: z.string().optional(),
      action: z.string().optional(),
      severity: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    }),
  },
  responses: { 200: { description: "Audit log list" } },
});

registry.registerPath({
  method: "get",
  path: "/api/audit/export",
  tags: ["Audit"],
  summary: "Export audit logs (CSV or JSON)",
  security: [{ cookieAuth: [] }],
  responses: { 200: { description: "Streamed export" } },
});

// ─── Billing routes ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/billing/history",
  tags: ["Billing"],
  summary: "Get billing history",
  security: [{ cookieAuth: [] }],
  responses: { 200: { description: "Billing history" } },
});

// ─── Admin routes ────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/admin/flags",
  tags: ["Admin"],
  summary: "List feature flags",
  security: [{ cookieAuth: [] }],
  responses: { 200: { description: "Feature flag list" } },
});

registry.registerPath({
  method: "get",
  path: "/api/admin/jobs",
  tags: ["Admin"],
  summary: "Queue stats for all BullMQ queues",
  security: [{ cookieAuth: [] }],
  responses: { 200: { description: "Queue statistics" } },
});

// ─── AI routes ───────────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/ai/chat",
  tags: ["AI"],
  summary: "Send a message to the AI assistant",
  security: [{ cookieAuth: [] }],
  responses: { 200: { description: "AI response" }, 429: { description: "Usage limit reached" } },
});

// ─── Events routes ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/events/stream",
  tags: ["Events"],
  summary: "Server-Sent Events stream for real-time updates",
  security: [{ cookieAuth: [] }],
  responses: { 200: { description: "SSE stream" } },
});

// ─── Metrics routes ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/metrics",
  tags: ["Operations"],
  summary: "Prometheus metrics endpoint",
  responses: { 200: { description: "Prometheus text format" } },
});

// ─── Spec generation ──────────────────────────────────────────────────────────

export function generateOpenApiSpec() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Westbridge API",
      version: "1.0.0",
      description: "Enterprise ERP SaaS platform API",
    },
    servers: [{ url: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000" }],
  });
}
