import { Router, Request, Response } from "express";
import { z } from "zod";
import { checkTieredRateLimit, getClientIdentifier, rateLimitHeaders } from "../lib/api/rate-limit-tiers.js";
import { apiSuccess, apiError, apiMeta, getRequestId } from "../types/api.js";
import { toWebRequest } from "../middleware/auth.js";
import { sendEmail } from "../lib/email/index.js";
import { getRedis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import * as Sentry from "@sentry/node";

const router = Router();

// ─── Zod Schemas ────────────────────────────────────────────────────────────────

const demoLeadSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  email: z.string().email("Valid email is required").max(320),
  company: z.string().min(1, "Company is required").max(200),
  phone: z.string().max(30).optional(),
  country: z.string().min(1, "Country is required").max(100),
});

const newsletterSchema = z.object({
  email: z.string().email("Valid email is required").max(320),
});

// ─── Rate Limit Helpers ─────────────────────────────────────────────────────────

const LEADS_RATE_LIMIT = 3;
const LEADS_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Per-email rate limit for lead capture endpoints: 3 requests per email per hour.
 */
async function checkLeadEmailRateLimit(email: string, endpoint: string) {
  const normalised = email.trim().toLowerCase();
  const key = `rl2:lead:${endpoint}:${normalised}`;
  const now = Date.now();
  const windowStart = now - LEADS_WINDOW_MS;
  const reset = Math.ceil((now + LEADS_WINDOW_MS) / 1000);

  const redis = getRedis();
  if (!redis) {
    logger.warn("Rate limit: Redis unavailable, denying request");
    return { allowed: false, limit: LEADS_RATE_LIMIT, remaining: 0, reset, retryAfter: 3600 };
  }

  try {
    const checkPipeline = redis.pipeline();
    checkPipeline.zremrangebyscore(key, 0, windowStart);
    checkPipeline.zcard(key);
    const checkResults = await checkPipeline.exec();
    const currentCount = (checkResults?.[1]?.[1] as number) ?? 0;

    if (currentCount >= LEADS_RATE_LIMIT) {
      return {
        allowed: false,
        limit: LEADS_RATE_LIMIT,
        remaining: 0,
        reset,
        retryAfter: Math.ceil(LEADS_WINDOW_MS / 1000),
      };
    }

    const member = `${now}:${Math.random().toString(36).slice(2)}`;
    const addPipeline = redis.pipeline();
    addPipeline.zadd(key, now, member);
    addPipeline.pexpire(key, LEADS_WINDOW_MS * 2);
    await addPipeline.exec();

    const remaining = Math.max(0, LEADS_RATE_LIMIT - (currentCount + 1));
    return { allowed: true, limit: LEADS_RATE_LIMIT, remaining, reset };
  } catch (e) {
    logger.warn("Rate limit: Redis error", { error: e instanceof Error ? e.message : String(e) });
    return { allowed: false, limit: LEADS_RATE_LIMIT, remaining: 0, reset, retryAfter: 3600 };
  }
}

// ─── POST /leads/demo ───────────────────────────────────────────────────────────

router.post("/leads/demo", async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  try {
    // Validate body
    const parsed = demoLeadSchema.safeParse(req.body);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const message =
        fieldErrors.name?.[0] ??
        fieldErrors.email?.[0] ??
        fieldErrors.company?.[0] ??
        fieldErrors.country?.[0] ??
        fieldErrors.phone?.[0] ??
        "Invalid request";
      res.set(responseHeaders());
      return res.status(400).json(apiError("VALIDATION_ERROR", message, undefined, meta()));
    }

    // IP-based rate limit (anonymous tier)
    const id = getClientIdentifier(toWebRequest(req));
    const ipRateLimit = await checkTieredRateLimit(id, "anonymous", "/api/leads/demo");
    if (!ipRateLimit.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(ipRateLimit) });
      return res
        .status(429)
        .json(apiError("RATE_LIMIT", "Too many requests. Please try again later.", undefined, meta()));
    }

    // Per-email rate limit: 3 per hour
    const emailRateLimit = await checkLeadEmailRateLimit(parsed.data.email, "demo");
    if (!emailRateLimit.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(emailRateLimit) });
      return res
        .status(429)
        .json(
          apiError("RATE_LIMIT", "Too many demo requests for this email. Please try again later.", undefined, meta()),
        );
    }

    // Store lead in Redis with 90-day TTL
    const redis = getRedis();
    if (redis) {
      const leadId = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const leadData = JSON.stringify({
        ...parsed.data,
        type: "demo",
        createdAt: new Date().toISOString(),
        requestId,
      });
      await redis.set(`lead:demo:${leadId}`, leadData, "EX", 90 * 24 * 60 * 60);
      // Also add to a sorted set for easy listing
      await redis.zadd("leads:demo", Date.now(), leadId);
    }

    // Send notification email to sales team
    const salesNotification = sendEmail({
      to: "sales@westbridge.gy",
      subject: `New Demo Request from ${parsed.data.name} (${parsed.data.company})`,
      html: `
        <h2>New Demo Request</h2>
        <table>
          <tr><td><strong>Name:</strong></td><td>${parsed.data.name}</td></tr>
          <tr><td><strong>Email:</strong></td><td>${parsed.data.email}</td></tr>
          <tr><td><strong>Company:</strong></td><td>${parsed.data.company}</td></tr>
          <tr><td><strong>Phone:</strong></td><td>${parsed.data.phone ?? "N/A"}</td></tr>
          <tr><td><strong>Country:</strong></td><td>${parsed.data.country}</td></tr>
        </table>
        <p><em>Submitted at ${new Date().toISOString()}</em></p>
      `,
    });

    // Send confirmation email to the lead
    const leadConfirmation = sendEmail({
      to: parsed.data.email,
      subject: "We received your demo request - Westbridge",
      html: `
        <h2>Thank you for your interest, ${parsed.data.name}!</h2>
        <p>We've received your demo request and our team will be in touch within 1 business day.</p>
        <p>In the meantime, feel free to explore our documentation at <a href="https://westbridge.gy">westbridge.gy</a>.</p>
        <br>
        <p>Best regards,<br>The Westbridge Team</p>
      `,
    });

    // Fire emails concurrently (don't block response on delivery)
    void Promise.all([salesNotification, leadConfirmation]).catch((e) => {
      logger.error("Failed to send lead emails", {
        error: e instanceof Error ? e.message : String(e),
        request_id: requestId,
      });
    });

    logger.info("Demo lead captured", {
      email: parsed.data.email,
      company: parsed.data.company,
      request_id: requestId,
    });

    res.set(responseHeaders());
    return res.status(201).json(apiSuccess({ message: "Demo request received. We'll be in touch soon!" }, meta()));
  } catch (error) {
    logger.error("Demo lead capture error", {
      error: error instanceof Error ? error.message : String(error),
      request_id: requestId,
    });
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
});

// ─── POST /leads/newsletter ─────────────────────────────────────────────────────

router.post("/leads/newsletter", async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  try {
    // Validate body
    const parsed = newsletterSchema.safeParse(req.body);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const message = fieldErrors.email?.[0] ?? "Invalid request";
      res.set(responseHeaders());
      return res.status(400).json(apiError("VALIDATION_ERROR", message, undefined, meta()));
    }

    // IP-based rate limit (anonymous tier)
    const id = getClientIdentifier(toWebRequest(req));
    const ipRateLimit = await checkTieredRateLimit(id, "anonymous", "/api/leads/newsletter");
    if (!ipRateLimit.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(ipRateLimit) });
      return res
        .status(429)
        .json(apiError("RATE_LIMIT", "Too many requests. Please try again later.", undefined, meta()));
    }

    // Per-email rate limit: 3 per hour
    const emailRateLimit = await checkLeadEmailRateLimit(parsed.data.email, "newsletter");
    if (!emailRateLimit.allowed) {
      res.set({ ...responseHeaders(), ...rateLimitHeaders(emailRateLimit) });
      return res
        .status(429)
        .json(
          apiError("RATE_LIMIT", "Too many signup attempts for this email. Please try again later.", undefined, meta()),
        );
    }

    // Store email in Redis set
    const redis = getRedis();
    if (redis) {
      await redis.sadd("newsletter:subscribers", parsed.data.email.trim().toLowerCase());
    }

    // Send welcome email to the subscriber
    void sendEmail({
      to: parsed.data.email,
      subject: "Welcome to the Westbridge Newsletter!",
      html: `
        <h2>You're subscribed!</h2>
        <p>Thank you for subscribing to the Westbridge newsletter. You'll receive updates on product features, tips, and industry insights.</p>
        <p>Visit us at <a href="https://westbridge.gy">westbridge.gy</a> to learn more.</p>
        <br>
        <p>Best regards,<br>The Westbridge Team</p>
      `,
    }).catch((e) => {
      logger.error("Failed to send newsletter welcome email", {
        error: e instanceof Error ? e.message : String(e),
        request_id: requestId,
      });
    });

    logger.info("Newsletter subscriber added", { email: parsed.data.email, request_id: requestId });

    res.set(responseHeaders());
    return res.status(201).json(apiSuccess({ message: "Successfully subscribed to the newsletter!" }, meta()));
  } catch (error) {
    logger.error("Newsletter signup error", {
      error: error instanceof Error ? error.message : String(error),
      request_id: requestId,
    });
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
});

export default router;
