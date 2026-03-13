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

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import * as Sentry from "@sentry/node";
import { logger } from "./lib/logger.js";

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

export function createApp(): express.Application {
  const app = express();
  app.set("trust proxy", 1);

  // ─── Global Middleware ─────────────────────────────────────────────────────

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
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

  app.use("/api/auth", authRoutes);
  app.use("/api", signupRoutes);
  app.use("/api", csrfRoutes);
  app.use("/api", erpRoutes);
  app.use("/api", inviteRoutes);
  app.use("/api", adminRoutes);
  app.use("/api", auditRoutes);
  app.use("/api", teamRoutes);
  app.use("/api", accountRoutes);
  app.use("/api", billingRoutes);
  app.use("/api", aiRoutes);
  app.use("/api", analyticsRoutes);
  app.use("/api", healthRoutes);
  app.use("/api", eventsRoutes);
  app.use("/api", webhooksRoutes);
  app.use("/api", reportsRoutes);
  app.use("/api", miscRoutes);
  app.use("/api", cspRoutes);

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
