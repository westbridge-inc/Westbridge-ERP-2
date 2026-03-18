/**
 * Misc routes
 *
 * GET /metrics — Prometheus metrics scrape endpoint
 * GET /usage   — current billing period usage for the authenticated account
 * GET /docs    — serves the OpenAPI 3.1 JSON spec
 */
import { Router, Request, Response } from "express";
import { apiSuccess, apiError, apiMeta, getRequestId } from "../types/api.js";
import { checkTieredRateLimit, getClientIdentifier, rateLimitHeaders } from "../lib/api/rate-limit-tiers.js";
import { meter, estimateAiCost } from "../lib/metering.js";
import { prisma } from "../lib/data/prisma.js";
import { requireAuth, toWebRequest } from "../middleware/auth.js";
import * as Sentry from "@sentry/node";

const router = Router();

import { PLAN_USER_LIMITS } from "../lib/constants.js";

const METRICS_TOKEN = process.env.METRICS_TOKEN;
const NODE_ENV = process.env.NODE_ENV ?? "development";

// ---------------------------------------------------------------------------
// GET /metrics — Prometheus metrics scrape endpoint
// ---------------------------------------------------------------------------
router.get("/metrics", async (req: Request, res: Response) => {
  // Token-based authentication: if METRICS_TOKEN is configured, require Bearer token
  if (METRICS_TOKEN) {
    const auth = req.headers["authorization"] as string;
    if (auth !== `Bearer ${METRICS_TOKEN}`) {
      return res.status(401).send("Unauthorized");
    }
  } else if (NODE_ENV === "production") {
    // In production, METRICS_TOKEN must be configured — block access entirely
    return res.status(403).send("Forbidden: METRICS_TOKEN not configured");
  } else {
    // In development/test without a token: only allow from loopback/private ranges.
    // Use req.ip (respects Express trust proxy) with X-Forwarded-For as fallback.
    const forwarded = req.headers["x-forwarded-for"] as string;
    const ip = forwarded?.split(",")[0]?.trim() ?? req.ip ?? "";
    // Deny requests with empty/unknown IP — fail closed
    if (!ip) {
      return res.status(403).send("Forbidden");
    }
    const isInternal =
      ip.startsWith("127.") ||
      ip === "::1" ||
      ip.startsWith("10.") ||
      // RFC 1918: 172.16.0.0/12 = 172.16.x.x through 172.31.x.x
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip) ||
      ip.startsWith("192.168.");
    if (!isInternal) {
      return res.status(403).send("Forbidden");
    }
  }

  const { registry } = await import("../lib/metrics.js");
  const metrics = await registry.metrics();

  return res.status(200).set("Content-Type", registry.contentType).set("Cache-Control", "no-store").send(metrics);
});

// ---------------------------------------------------------------------------
// GET /usage — current billing period usage for the authenticated account
// ---------------------------------------------------------------------------
router.get("/usage", requireAuth, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });

  try {
    const session = req.session!;

    const rateLimit = await checkTieredRateLimit(getClientIdentifier(toWebRequest(req)), "authenticated", "/api/usage");
    if (!rateLimit.allowed) {
      return res
        .status(429)
        .set("X-Response-Time", `${Date.now() - start}ms`)
        .set(rateLimitHeaders(rateLimit) as Record<string, string>)
        .json(apiError("RATE_LIMIT", "Too many requests.", undefined, meta()));
    }

    const [usage, account] = await Promise.all([
      meter.get(session.accountId),
      prisma.account.findUnique({
        where: { id: session.accountId },
        select: { plan: true, users: { select: { id: true } } },
      }),
    ]);

    const plan = account?.plan ?? "Starter";
    const userLimit = PLAN_USER_LIMITS[plan] ?? null;
    const aiCostUsd = estimateAiCost(usage.ai_tokens_input, usage.ai_tokens_output);

    return res.set("X-Response-Time", `${Date.now() - start}ms`).json(
      apiSuccess(
        {
          period: usage.period,
          plan,
          usage: {
            api_calls: { count: usage.api_calls, limit: null },
            erp_docs_created: { count: usage.erp_docs_created, limit: null },
            active_users: { count: usage.active_users_count, limit: userLimit },
            ai_tokens: {
              input: usage.ai_tokens_input,
              output: usage.ai_tokens_output,
              cost_usd: Math.round(aiCostUsd * 100) / 100,
            },
          },
        },
        meta(),
      ),
    );
  } catch (error) {
    Sentry.captureException(error);
    return res
      .status(500)
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
});

// ---------------------------------------------------------------------------
// GET /docs — serves the OpenAPI 3.1 JSON spec
// ---------------------------------------------------------------------------
router.get("/docs", async (_req: Request, res: Response) => {
  const { generateOpenApiSpec } = await import("../lib/api/openapi.js");
  const spec = generateOpenApiSpec();
  return res.set("Content-Type", "application/json").set("Cache-Control", "public, max-age=300").json(spec);
});

export default router;
