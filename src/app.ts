/**
 * Express application factory.
 *
 * Separated from server.ts so integration tests can import the configured
 * Express app without starting the HTTP server or BullMQ workers.
 *
 * Usage:
 *   import app from "./app.js";
 *   // In tests: supertest(app).get("/api/health/live")...
 *   // In server.ts: app.listen(PORT)
 */

import express, { Router } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import * as Sentry from "@sentry/node";
import { logger } from "./lib/logger.js";
import { requestLogger } from "./middleware/request-logger.js";
import { responseTime } from "./middleware/response-time.js";
import { tenantContext } from "./middleware/tenant-context.js";
import { requireActiveSubscription, requireCsrf } from "./middleware/auth.js";

// Route imports
import authRoutes from "./routes/auth.routes.js";
import signupRoutes from "./routes/signup.routes.js";
import csrfRoutes from "./routes/csrf.routes.js";
import erpRoutes from "./routes/erp.routes.js";
import inviteRoutes from "./routes/invite.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import auditRoutes from "./routes/audit.routes.js";
import teamRoutes from "./routes/team.routes.js";
import accountRoutes from "./routes/account.routes.js";
import billingRoutes from "./routes/billing.routes.js";
import aiRoutes from "./routes/ai.routes.js";
import analyticsRoutes from "./routes/analytics.routes.js";
import healthRoutes from "./routes/health.routes.js";
import eventsRoutes from "./routes/events.routes.js";
import webhooksRoutes from "./routes/webhooks.routes.js";
import reportsRoutes from "./routes/reports.routes.js";
import miscRoutes from "./routes/misc.routes.js";
import cspRoutes from "./routes/csp.routes.js";
import leadsRoutes from "./routes/leads.routes.js";
import ssoRoutes from "./routes/sso.routes.js";
import documentRoutes from "./routes/document.routes.js";
import settingsRoutes from "./routes/settings.routes.js";
import totpRoutes from "./routes/totp.routes.js";

export function createApp(): express.Application {
  const app = express();
  app.set("trust proxy", 1);

  // ─── Global Middleware ─────────────────────────────────────────────────────

  // Response time header — mount early to capture full request lifecycle (B4)
  app.use(responseTime);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", process.env.FRONTEND_URL ?? "http://localhost:3000"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          reportUri: ["/api/v1/csp-report"],
        },
      },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      hsts: { maxAge: 63072000, includeSubDomains: true, preload: true }, // 2 years
      frameguard: { action: "deny" },
      // noSniff, xssFilter, ieNoOpen are on by default in Helmet
    }),
  );

  app.use(
    cors({
      origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
      credentials: true,
    }),
  );

  app.use(cookieParser());
  app.use(express.json({ limit: "1mb", type: ["application/json", "application/csp-report"] }));
  app.use(express.urlencoded({ extended: true }));

  // Also parse text/plain for analytics beacon requests
  app.use(express.text({ type: "text/plain" }));

  // Global CSRF protection: enforce on state-changing requests that carry a session cookie.
  // Requests without a session cookie have no session to abuse, so CSRF is not applicable.
  // Explicit exemptions for webhook/OAuth callback endpoints that use their own auth.
  const CSRF_EXEMPT_PREFIXES = ["/api/webhooks/", "/api/v1/webhooks/"];
  const CSRF_EXEMPT_PATHS = ["/api/sso/callback", "/api/v1/sso/callback"];
  app.use((req, res, next) => {
    const isMutating = ["POST", "PUT", "DELETE", "PATCH"].includes(req.method);
    if (!isMutating) return next();
    const hasSessionCookie = !!req.cookies?.["westbridge_sid"];
    if (!hasSessionCookie) return next();
    const isExempt = CSRF_EXEMPT_PREFIXES.some((p) => req.path.startsWith(p)) || CSRF_EXEMPT_PATHS.includes(req.path);
    if (isExempt) return next();
    return requireCsrf(req, res, next);
  });

  // Per-request logger context — attaches req.log with request ID
  app.use(requestLogger);

  // Request logging (skipped in test env)
  app.use((req, _res, next) => {
    const start = Date.now();
    _res.on("finish", () => {
      const duration = Date.now() - start;
      if (process.env.NODE_ENV !== "test") {
        logger.info("HTTP request", {
          method: req.method,
          path: req.path,
          status: _res.statusCode,
          duration_ms: duration,
        });
      }
    });
    next();
  });

  // ─── Routes ────────────────────────────────────────────────────────────────

  // Create a shared router for all API routes
  const apiRouter = Router();

  // RLS tenant context: set PostgreSQL session variable for every authenticated request (B1)
  apiRouter.use(tenantContext);

  // Block past_due/canceled accounts from accessing non-billing endpoints
  apiRouter.use(requireActiveSubscription);

  apiRouter.use("/auth", authRoutes);
  apiRouter.use(signupRoutes);
  apiRouter.use(csrfRoutes);
  apiRouter.use(erpRoutes);
  apiRouter.use(inviteRoutes);
  apiRouter.use(adminRoutes);
  apiRouter.use(auditRoutes);
  apiRouter.use(teamRoutes);
  apiRouter.use(accountRoutes);
  apiRouter.use(billingRoutes);
  apiRouter.use(aiRoutes);
  apiRouter.use(analyticsRoutes);
  apiRouter.use(healthRoutes);
  apiRouter.use(eventsRoutes);
  apiRouter.use(webhooksRoutes);
  apiRouter.use(reportsRoutes);
  apiRouter.use(miscRoutes);
  apiRouter.use(cspRoutes);
  apiRouter.use(leadsRoutes);
  apiRouter.use(ssoRoutes);
  apiRouter.use(documentRoutes);
  apiRouter.use(settingsRoutes);
  apiRouter.use("/auth", totpRoutes);

  // Mount versioned API (canonical)
  app.use("/api/v1", apiRouter);

  // Mount unversioned API (backwards compatibility — deprecated per RFC 8594) (B5)
  app.use(
    "/api",
    (req, res, next) => {
      if (!req.path.startsWith("/v1/")) {
        res.setHeader("Deprecation", "true");
        res.setHeader("Sunset", "2026-09-01");
        res.setHeader("Link", '</api/v1/>; rel="successor-version"');
      }
      next();
    },
    apiRouter,
  );

  // ─── 404 Handler ───────────────────────────────────────────────────────────

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Route not found" } });
  });

  // ─── Error Handler ─────────────────────────────────────────────────────────

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error("Unhandled error", { error: err.message, stack: err.stack });
    Sentry.captureException(err);
    res.status(500).json({ ok: false, error: { code: "SERVER_ERROR", message: "Internal server error" } });
  });

  return app;
}

export default createApp();
