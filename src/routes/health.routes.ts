/**
 * Health routes
 *
 * GET /health       — comprehensive health check
 * GET /health/live  — liveness probe (K8s/ECS)
 * GET /health/ready — readiness probe (K8s/ECS)
 */
import { Router, Request, Response } from "express";
import { prisma } from "../lib/data/prisma.js";
import { getRequestId, apiSuccess } from "../types/api.js";
import { getRedis } from "../lib/redis.js";
import { getUptimeSeconds } from "../lib/uptime.js";
import { toWebRequest } from "../middleware/auth.js";
import os from "os";
import { statfsSync } from "fs";

const router = Router();

type CheckStatus = "healthy" | "degraded" | "unhealthy";
interface CheckResult {
  status: CheckStatus;
  latency_ms: number;
  message?: string;
}

async function checkDatabase(): Promise<CheckResult> {
  const start = Date.now();
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ]);
    const latency = Date.now() - start;
    return { status: latency > 1000 ? "degraded" : "healthy", latency_ms: latency };
  } catch (_e) {
    return { status: "unhealthy", latency_ms: Date.now() - start, message: "unreachable" };
  }
}

async function checkRedis(): Promise<CheckResult> {
  const redis = getRedis();
  if (!redis) return { status: "unhealthy", latency_ms: 0, message: "not configured" };
  const start = Date.now();
  try {
    await Promise.race([
      redis.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ]);
    const latency = Date.now() - start;
    return { status: latency > 500 ? "degraded" : "healthy", latency_ms: latency };
  } catch (_e) {
    return { status: "unhealthy", latency_ms: Date.now() - start, message: "unreachable" };
  }
}

async function checkErpNext(): Promise<CheckResult> {
  const url = process.env.ERPNEXT_URL ?? "http://localhost:8080";
  const start = Date.now();
  try {
    const res = await fetch(`${url}/api/method/ping`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    const latency = Date.now() - start;
    if (!res.ok) return { status: "degraded", latency_ms: latency, message: "upstream error" };
    if (latency > 1000) return { status: "degraded", latency_ms: latency, message: "slow response" };
    return { status: "healthy", latency_ms: latency };
  } catch (_e) {
    return { status: "degraded", latency_ms: Date.now() - start, message: "unreachable" };
  }
}

function checkMemory(): CheckResult {
  const total = os.totalmem();
  const free = os.freemem();
  const usedPercent = Math.round(((total - free) / total) * 100);
  return {
    status: usedPercent > 95 ? "unhealthy" : usedPercent > 85 ? "degraded" : "healthy",
    latency_ms: 0,
    message: `${usedPercent}% used`,
  };
}

function checkDisk(): CheckResult {
  try {
    const stat = statfsSync("/");
    const totalBytes = stat.blocks * stat.bsize;
    const freeBytes = stat.bfree * stat.bsize;
    const usedPercent = Math.round(((totalBytes - freeBytes) / totalBytes) * 100);
    return {
      status: usedPercent > 95 ? "unhealthy" : usedPercent > 85 ? "degraded" : "healthy",
      latency_ms: 0,
      message: `${usedPercent}% used`,
    };
  } catch {
    // statfsSync may not be available on all platforms
    return { status: "healthy", latency_ms: 0, message: "check unavailable" };
  }
}

// ---------------------------------------------------------------------------
// GET /health — comprehensive health check
// ---------------------------------------------------------------------------
router.get("/health", async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));

  const [dbCheck, redisCheck, erpCheck] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkErpNext(),
  ]);
  const memCheck = checkMemory();
  const diskCheck = checkDisk();

  const checks = {
    database: dbCheck,
    redis: redisCheck,
    erp: erpCheck,
    memory: memCheck,
    disk: diskCheck,
  };

  // Database is critical; Redis is critical; ERP and system checks are non-critical
  const criticalOk = dbCheck.status !== "unhealthy" && redisCheck.status !== "unhealthy";
  const allOk = Object.values(checks).every((c) => c.status === "healthy");
  const overallStatus: CheckStatus = allOk ? "healthy" : criticalOk ? "degraded" : "unhealthy";
  const httpStatus = overallStatus === "unhealthy" ? 503 : 200;

  const body = apiSuccess(
    {
      status: overallStatus,
      version: "0.1.0",
      uptime_seconds: getUptimeSeconds(),
      checks,
      timestamp: new Date().toISOString(),
    },
    { request_id: requestId }
  );
  return res
    .status(httpStatus)
    .set("X-Response-Time", `${Date.now() - start}ms`)
    .set("Cache-Control", "no-store")
    .json(body);
});

// ---------------------------------------------------------------------------
// GET /health/live — liveness probe
// ---------------------------------------------------------------------------
router.get("/health/live", async (_req: Request, res: Response) => {
  return res
    .status(200)
    .set("Cache-Control", "no-store")
    .json({ alive: true, uptime_seconds: getUptimeSeconds() });
});

// ---------------------------------------------------------------------------
// GET /health/ready — readiness probe
// ---------------------------------------------------------------------------
router.get("/health/ready", async (_req: Request, res: Response) => {
  const checks = await Promise.allSettled([
    prisma.$queryRaw`SELECT 1`,
    (async () => {
      const r = getRedis();
      if (!r) throw new Error("Redis not configured");
      await r.ping();
    })(),
  ]);

  const [db, redis] = checks;
  const ready = db.status === "fulfilled" && redis.status === "fulfilled";

  return res
    .status(ready ? 200 : 503)
    .set("Cache-Control", "no-store")
    .json({
      ready,
      checks: {
        database: db.status === "fulfilled" ? "ok" : "error",
        redis: redis.status === "fulfilled" ? "ok" : "error",
      },
    });
});

export default router;
