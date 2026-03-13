import "dotenv/config";
import { env } from "./lib/env.js"; // Validate env FIRST — crash at startup, not at runtime
import * as Sentry from "@sentry/node";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { startWorkers } from "./workers/index.js";
import { scheduleCleanupJobs } from "./lib/jobs/queue.js";
import { prisma } from "./lib/data/prisma.js";
import { closeRedis } from "./lib/redis.js";

// ─── Sentry — initialize BEFORE anything else can throw ──────────────────────
if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.NODE_ENV === "production" ? 0.1 : 1.0,
    // Capture 100 % of errors, sample 10 % of transactions in prod
  });
  logger.info("Sentry initialised", { environment: env.NODE_ENV });
} else {
  logger.warn("SENTRY_DSN not set — error tracking disabled");
}

const PORT = env.PORT;

// ─── Process-level error handlers ─────────────────────────────────────────────
// Defence-in-depth: catch truly unexpected errors that escape route try/catch.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  if (reason instanceof Error) Sentry.captureException(reason);
});
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception — shutting down", {
    error: err.message,
    stack: err.stack,
  });
  Sentry.captureException(err);
  Sentry.flush(2000).finally(() => process.exit(1));
});

// ─── Start ───────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  logger.info("Westbridge API server running", { port: PORT });
  const workers = startWorkers();
  scheduleCleanupJobs().catch((err) => {
    logger.error("Failed to schedule cleanup jobs", { error: err instanceof Error ? err.message : String(err) });
  });

  // ─── Graceful Shutdown ────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, starting graceful shutdown...`);

    // Safety net: force exit after 10 seconds
    const forceExitTimeout = setTimeout(() => {
      logger.error("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 10_000);
    forceExitTimeout.unref();

    try {
      // Stop accepting new connections
      server.close(() => {
        logger.info("HTTP server closed");
      });

      // Close all BullMQ workers
      await Promise.all(workers.map((w) => w.close()));
      logger.info("All BullMQ workers closed");

      // Close Redis connection
      await closeRedis();
      logger.info("Redis connection closed");

      // Disconnect Prisma
      await prisma.$disconnect();
      logger.info("Prisma disconnected");

      process.exit(0);
    } catch (err) {
      logger.error("Error during graceful shutdown", { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
});

export default app;
