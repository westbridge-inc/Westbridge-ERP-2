/**
 * Email client: thin wrapper around Resend with retry-on-failure (M6).
 *
 * All email sending in the app goes through sendEmail(). Email is treated
 * as best-effort by callers (signup activation, password reset, invites,
 * audit notifications) but a single Resend hiccup should not silently
 * burn a password reset link or an account activation. We retry with
 * exponential backoff on transient failures (5xx, network errors, timeouts).
 *
 * Retry budget:
 *   - 3 attempts total (initial + 2 retries)
 *   - Backoff: 250ms → 750ms → 2_250ms (jittered)
 *   - Aborts on 4xx (auth/validation failures — retrying won't help)
 *
 * If all retries fail, the function returns err() and logs an error-level
 * event so the caller (and Sentry) sees the permanent failure. Callers
 * that need stronger guarantees (signup activation, password reset) should
 * be moved to BullMQ via enqueueEmail() so the job survives a process
 * restart and benefits from the queue's own retry/backoff machinery.
 */

import { Resend } from "resend";
import { ok, err, type Result } from "../utils/result.js";
import { logger } from "../logger.js";

let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error("RESEND_API_KEY environment variable is required");
    _resend = new Resend(apiKey);
  }
  return _resend;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;

function backoffDelay(attempt: number): number {
  // Exponential backoff with full jitter to spread thundering-herd retries.
  const exp = BASE_BACKOFF_MS * Math.pow(3, attempt);
  return Math.floor(exp * (0.5 + Math.random() * 0.5));
}

function isTransientError(error: unknown): boolean {
  // Resend's SDK error shape: { name, message, statusCode? }
  if (error && typeof error === "object") {
    const e = error as { statusCode?: number; name?: string; message?: string };
    if (typeof e.statusCode === "number") {
      // Retry 5xx and 429. 4xx other than 429 are caller errors — retry
      // would just waste budget.
      return e.statusCode >= 500 || e.statusCode === 429;
    }
    // No status code → likely a network/timeout error → retryable.
    return true;
  }
  return true;
}

export async function sendEmail(opts: SendEmailOptions): Promise<Result<{ id: string }, string>> {
  const from = opts.from ?? process.env.EMAIL_FROM ?? "Westbridge <noreply@westbridgetoday.com>";

  const nodeEnv = process.env.NODE_ENV;

  // STAGING SAFETY: staging never sends real email by design — even if
  // RESEND_API_KEY is set. This protects against an operator running a
  // smoke-test signup against staging and accidentally emailing a real
  // user from a production-shaped Resend account. The dev/test path
  // below still uses Resend when explicitly mocked in unit tests.
  if (nodeEnv === "staging") {
    logger.warn(
      `[email] NODE_ENV=staging — email send intentionally skipped. To: ${opts.to}, Subject: ${opts.subject}`,
    );
    return ok({ id: `staging-skipped-${Date.now()}` });
  }

  // In development/test without RESEND_API_KEY, log instead of silently failing
  if (!process.env.RESEND_API_KEY) {
    const isDev = nodeEnv === "development" || nodeEnv === "test";
    if (isDev) {
      logger.warn(
        `[email] RESEND_API_KEY not set — skipping email send in ${nodeEnv}. ` +
          `To: ${opts.to}, Subject: ${opts.subject}`,
      );
      return ok({ id: `dev-skipped-${Date.now()}` });
    }
    return err("RESEND_API_KEY is not configured. Email cannot be sent.");
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const resend = getResend();
      const { data, error } = await resend.emails.send({
        from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
      });
      if (!error) {
        if (attempt > 0) {
          logger.info("Email send succeeded after retry", {
            to: opts.to,
            subject: opts.subject,
            attempts: attempt + 1,
          });
        }
        return ok({ id: data?.id ?? "" });
      }
      lastError = error;
      // Resend SDK returns errors as { name, message } — treat as transient
      // unless we can prove they're 4xx.
      if (!isTransientError(error)) {
        logger.error("Email send failed (non-retryable)", {
          to: opts.to,
          subject: opts.subject,
          error: typeof error === "object" && error !== null ? JSON.stringify(error) : String(error),
        });
        return err("Unable to send the email right now. Please try again.");
      }
    } catch (e) {
      lastError = e;
      if (!isTransientError(e)) {
        logger.error("Email send threw (non-retryable)", {
          to: opts.to,
          subject: opts.subject,
          error: e instanceof Error ? e.message : String(e),
        });
        return err("Unable to send the email right now. Please try again.");
      }
    }

    // Last attempt? Don't sleep, just log and fall through.
    if (attempt < MAX_ATTEMPTS - 1) {
      const delay = backoffDelay(attempt);
      logger.warn("Email send failed (transient) — retrying", {
        to: opts.to,
        subject: opts.subject,
        attempt: attempt + 1,
        nextRetryInMs: delay,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  logger.error("Email send permanently failed after all retries", {
    to: opts.to,
    subject: opts.subject,
    attempts: MAX_ATTEMPTS,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
  return err("Unable to send the email right now. Please try again.");
}
