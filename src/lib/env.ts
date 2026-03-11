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

// ─── Schema ──────────────────────────────────────────────────────────────────

const envSchema = z.object({
  // ── Core ────────────────────────────────────────────────────────────────────
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  // ── Database ────────────────────────────────────────────────────────────────
  DATABASE_URL: z
    .string()
    .url()
    .default("postgresql://user:password@localhost:5432/westbridge?schema=public"),

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
  EMAIL_FROM: z.string().optional().default("Westbridge <noreply@westbridge.app>"),
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),

  // ── AI ──────────────────────────────────────────────────────────────────────
  ANTHROPIC_API_KEY: z.string().optional().default(""),

  // ── Billing ─────────────────────────────────────────────────────────────────
  TWOCO_SECRET_WORD: z.string().optional().default(""),
  TWOCO_LINK_STARTER: z.string().optional().default(""),
  TWOCO_LINK_BUSINESS: z.string().optional().default(""),
  TWOCO_LINK_ENTERPRISE: z.string().optional().default(""),
  TWOCHECKOUT_MERCHANT_CODE: z.string().optional().default(""),
  TWOCHECKOUT_SECRET_KEY: z.string().optional().default(""),

  // ── Observability ───────────────────────────────────────────────────────────
  SENTRY_DSN: z.string().optional().default(""),
  POSTHOG_API_KEY: z.string().optional().default(""),
  POSTHOG_HOST: z.string().optional().default("https://app.posthog.com"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
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
    throw new Error(
      `Missing or invalid environment variables:\n${JSON.stringify(formatted, null, 2)}`
    );
  }

  // Production safety checks
  if (result.data.NODE_ENV === "production") {
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
  }

  return result.data;
}

export const env = parseEnv();

export type Env = z.infer<typeof envSchema>;
