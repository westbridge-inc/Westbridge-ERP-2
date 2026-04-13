import "./instrumentation.js";
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
//
// beforeSend redacts:
//   1. Absolute filesystem paths in stack frames + breadcrumbs (security patch)
//      finding — leaks the build environment's directory layout, which
//      tells an attacker about the deploy topology and may expose user
//      home directories on dev machines).
//   2. Common secret-like values from request data (cookies, auth headers).
//
// The redaction is intentionally conservative: we strip the leading
// directory components but keep `app/...` or `dist/...` so the file path
// remains diagnosable. Anything outside those build roots gets reduced to
// just the basename so the trace is still readable but the host layout is
// not disclosed.
function redactPath(path: string): string {
  // Keep common build roots intact for diagnosability.
  const buildRoots = ["/app/", "/dist/", "/src/", "/node_modules/"];
  for (const root of buildRoots) {
    const idx = path.indexOf(root);
    if (idx !== -1) return path.slice(idx + 1); // strip leading slash
  }
  // Otherwise: strip everything up to the basename so we don't leak directory layout.
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === -1 ? path : `<redacted>/${path.slice(lastSlash + 1)}`;
}

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-csrf-token",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
]);

function redactHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!headers) return headers;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER_NAMES.has(k.toLowerCase()) ? "[REDACTED]" : v;
  }
  return out;
}

if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.NODE_ENV === "production" ? 0.1 : 1.0,
    // Capture 100 % of errors, sample 10 % of transactions in prod
    beforeSend(event) {
      try {
        // Redact absolute filesystem paths in stack frames.
        if (event.exception?.values) {
          for (const ex of event.exception.values) {
            if (ex.stacktrace?.frames) {
              for (const frame of ex.stacktrace.frames) {
                if (frame.filename) frame.filename = redactPath(frame.filename);
                if (frame.abs_path) frame.abs_path = redactPath(frame.abs_path);
              }
            }
          }
        }
        // Redact filenames in threads (rare in Node).
        if (event.threads?.values) {
          for (const t of event.threads.values) {
            if (t.stacktrace?.frames) {
              for (const frame of t.stacktrace.frames) {
                if (frame.filename) frame.filename = redactPath(frame.filename);
                if (frame.abs_path) frame.abs_path = redactPath(frame.abs_path);
              }
            }
          }
        }
        // Redact request headers.
        if (event.request?.headers) {
          event.request.headers = redactHeaders(event.request.headers as Record<string, unknown>) as never;
        }
        // Drop request cookies entirely — Sentry has no business seeing session cookies.
        if (event.request?.cookies) {
          delete event.request.cookies;
        }
      } catch {
        // Never let beforeSend itself break Sentry — return the original event on error.
      }
      return event;
    },
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

const server = app.listen(PORT, async () => {
  logger.info("Westbridge API server running", { port: PORT });

  // ─── Connection warmup — pre-establish DB and Redis pools ───────────────
  // Without this, the first user request pays the connection setup cost
  // (200-500ms on Railway). Warming up here makes all user requests fast.
  try {
    const warmupStart = Date.now();
    const { getRedis } = await import("./lib/redis.js");
    await Promise.all([
      prisma.$queryRaw`SELECT 1`.then(() => logger.info("Database pool warmed up")),
      getRedis()
        ?.ping()
        .then(() => logger.info("Redis connection warmed up")),
    ]);
    logger.info("Connection warmup complete", { duration_ms: Date.now() - warmupStart });
  } catch (err) {
    logger.warn("Connection warmup failed (will retry on first request)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

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
