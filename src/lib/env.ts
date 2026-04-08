/**
 * Environment validation — crash at startup, not at runtime.
 *
 * Every environment variable the backend needs is declared and validated
 * here using Zod.  If any required variable is missing or malformed,
 * the server fails immediately with a clear error message instead of
 * silently breaking at runtime.
 *
 * Usage:
 *   import { env } from "./lib/env.js";
 *   console.log(env.DATABASE_URL);
 */

import { z } from "zod";
import { logger } from "./logger.js";
import { validateEncryptionKey } from "./encryption.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

const envSchema = z.object({
  // ── Core ────────────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  // ── Database ────────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().url().default("postgresql://user:password@localhost:5432/westbridge?schema=public"),

  // ── Redis ───────────────────────────────────────────────────────────────────
  REDIS_URL: z.string().default("redis://localhost:6379"),
  REDIS_HOST: z.string().optional(),
  REDIS_PORT: z.coerce.number().int().positive().optional(),
  REDIS_PASSWORD: z.string().optional(),

  // ── Frontend ────────────────────────────────────────────────────────────────
  FRONTEND_URL: z.string().default("http://localhost:3000"),
  NEXT_PUBLIC_APP_URL: z.string().default("http://localhost:3000"),

  // ── Security (required in production) ───────────────────────────────────────
  SESSION_SECRET: z.string().default("change-me-in-production"),
  CSRF_SECRET: z.string().default("change-me-in-production"),
  CSRF_SECRET_PREVIOUS: z.string().optional().default(""),
  ENCRYPTION_KEY: z.string().default("change-me-in-production"),
  ENCRYPTION_KEY_PREVIOUS: z.string().optional().default(""),

  // ── ERPNext ─────────────────────────────────────────────────────────────────
  ERPNEXT_URL: z.string().default("http://localhost:8080"),
  ERPNEXT_API_KEY: z.string().optional().default(""),
  ERPNEXT_API_SECRET: z.string().optional().default(""),

  // ── Email ───────────────────────────────────────────────────────────────────
  RESEND_API_KEY: z.string().optional().default(""),
  EMAIL_FROM: z.string().optional().default("Westbridge <noreply@westbridgetoday.com>"),
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),

  // ── AI ──────────────────────────────────────────────────────────────────────
  ANTHROPIC_API_KEY: z.string().optional().default(""),

  // ── Billing (Paddle — Merchant of Record) ────────────────────────────────────
  PADDLE_API_KEY: z.string().optional().default(""),
  PADDLE_WEBHOOK_SECRET: z.string().optional().default(""),
  PADDLE_SANDBOX: z.string().optional().default("true"),
  PADDLE_CLIENT_TOKEN: z.string().optional().default(""),
  PADDLE_PRICE_SOLO: z.string().optional().default(""),
  PADDLE_PRICE_STARTER: z.string().optional().default(""),
  PADDLE_PRICE_BUSINESS: z.string().optional().default(""),
  PADDLE_PRICE_ENTERPRISE: z.string().optional().default(""),

  // ── Observability ───────────────────────────────────────────────────────────
  SENTRY_DSN: z.string().optional().default(""),
  POSTHOG_API_KEY: z.string().optional().default(""),
  POSTHOG_HOST: z.string().optional().default("https://app.posthog.com"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  METRICS_TOKEN: z.string().optional(),

  // ── Multi-tenant ────────────────────────────────────────────────────────────
  SYSTEM_ACCOUNT_ID: z.string().optional(),

  // ── Feature Flags ───────────────────────────────────────────────────────────
  DEPLOY_STAGE: z.string().optional().default("dev"),

  // ── Cookies ─────────────────────────────────────────────────────────────────
  COOKIE_SAME_SITE: z.enum(["none", "lax", "strict"]).optional().default("none"),
});

// ─── Parse & Export ──────────────────────────────────────────────────────────

function parseEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.flatten().fieldErrors;
    console.error("❌ Invalid environment variables:", formatted);
    throw new Error(`Missing or invalid environment variables:\n${JSON.stringify(formatted, null, 2)}`);
  }

  // Safety checks for non-development/test environments (production, staging, etc.)
  const isProduction = result.data.NODE_ENV !== "development" && result.data.NODE_ENV !== "test";
  if (isProduction) {
    const warnings: string[] = [];
    if (result.data.SESSION_SECRET === "change-me-in-production") {
      warnings.push("SESSION_SECRET is still the default — generate with: openssl rand -hex 32");
    }
    if (result.data.CSRF_SECRET === "change-me-in-production") {
      warnings.push("CSRF_SECRET is still the default — generate with: openssl rand -hex 32");
    }
    if (result.data.ENCRYPTION_KEY === "change-me-in-production") {
      warnings.push("ENCRYPTION_KEY is still the default — generate with: openssl rand -hex 32");
    }
    if (warnings.length > 0) {
      console.error(`\n⚠️  PRODUCTION SECURITY WARNINGS:\n  • ${warnings.join("\n  • ")}\n`);
      throw new Error("Insecure default secrets detected in production. See warnings above.");
    }

    // Email is critical: password resets, invites, and payment receipts all require it
    if (!result.data.RESEND_API_KEY && !result.data.SMTP_HOST) {
      throw new Error(
        "RESEND_API_KEY (or SMTP_HOST) is required in production. " +
          "Password resets, invites, and payment receipts will silently fail without it.",
      );
    }

    // AI is optional but warn if not configured
    if (!result.data.ANTHROPIC_API_KEY) {
      logger.warn("ANTHROPIC_API_KEY not set — AI assistant will show 'coming soon' to users");
    }

    // Non-fatal warnings for observability & config
    if (!result.data.SENTRY_DSN) {
      logger.warn("SENTRY_DSN not set — error tracking is disabled in production");
    }
    if (result.data.FRONTEND_URL && !result.data.FRONTEND_URL.startsWith("https://")) {
      logger.warn(`FRONTEND_URL is not HTTPS (${result.data.FRONTEND_URL}) — CORS may allow insecure origins`);
    }

    // Postgres TLS hygiene: surface DATABASE_URL configurations that could
    // permit plaintext on the wire. We warn (not throw) because some
    // deployments — notably Fly.io's WireGuard mesh — already encrypt at
    // the network layer and may legitimately use sslmode=disable for the
    // application protocol. Loopback connections to a local DB sidecar are
    // exempted because they never leave the host.
    //
    // Acceptable: require, verify-ca, verify-full
    // Warn:       prefer, allow, <unset>  (these tolerate plaintext fallback)
    // Loud warn:  disable                 (explicitly opts out of TLS)
    //
    // Set REQUIRE_DB_TLS=true to upgrade these warnings to a hard failure.
    const dbUrl = result.data.DATABASE_URL;
    const isLoopback = /@(localhost|127\.0\.0\.1|::1)[:/]/.test(dbUrl);
    if (!isLoopback) {
      let sslmode = "";
      try {
        sslmode = new URL(dbUrl).searchParams.get("sslmode") ?? "";
      } catch {
        // Malformed URL — Zod already validated .url() so this should not
        // happen, but we keep the parser inside a try to avoid masking the
        // real failure at startup.
      }
      const strict = new Set(["require", "verify-ca", "verify-full"]);
      if (!strict.has(sslmode)) {
        const requireStrict = process.env.REQUIRE_DB_TLS === "true";
        const message =
          `DATABASE_URL has sslmode=${sslmode || "<unset>"} — this permits plaintext over the wire. ` +
          `For SaaS-grade encryption append "?sslmode=require" (or verify-ca/verify-full).`;
        if (requireStrict) {
          throw new Error(`${message} Set REQUIRE_DB_TLS=false to downgrade this to a warning.`);
        }
        logger.warn(message);
      }
    }
  }

  // Always validate encryption keys at startup (dev included) so a malformed
  // ENCRYPTION_KEY surfaces immediately on boot rather than at first request.
  // We skip this only when the default placeholder is in use (dev/test paths
  // that don't actually exercise the crypto layer).
  if (result.data.ENCRYPTION_KEY !== "change-me-in-production") {
    try {
      validateEncryptionKey();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`❌ Encryption key validation failed at startup: ${msg}`);
      throw e;
    }
  }

  return result.data;
}

export const env = parseEnv();

export type Env = z.infer<typeof envSchema>;
