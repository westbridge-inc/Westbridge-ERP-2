import "dotenv/config";
import { env } from "./lib/env.js"; // Validate env FIRST — crash at startup, not at runtime
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { startWorkers } from "./workers/index.js";
import { scheduleCleanupJobs } from "./lib/jobs/queue.js";
import { prisma } from "./lib/data/prisma.js";
import { closeRedis } from "./lib/redis.js";

const PORT = env.PORT;

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
