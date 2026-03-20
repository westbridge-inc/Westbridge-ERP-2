/**
 * Email client: Resend (primary) with nodemailer SMTP fallback.
 * All email sending in the app goes through sendEmail().
 *
 * Priority:
 *   1. RESEND_API_KEY → use Resend
 *   2. SMTP_HOST      → use nodemailer
 *   3. dev/test        → log and skip
 *   4. production      → error (caught at startup by env.ts)
 */

import { Resend } from "resend";
import { createTransport, type Transporter } from "nodemailer";
import { ok, err, type Result } from "../utils/result.js";
import { logger } from "../logger.js";

// ─── Resend client (lazy singleton) ──────────────────────────────────────────

let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error("RESEND_API_KEY environment variable is required");
    _resend = new Resend(apiKey);
  }
  return _resend;
}

// ─── Nodemailer SMTP transport (lazy singleton) ──────────────────────────────

let _smtpTransport: Transporter | null = null;

function getSmtpTransport(): Transporter | null {
  if (_smtpTransport) return _smtpTransport;

  const host = process.env.SMTP_HOST;
  if (!host) return null;

  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  _smtpTransport = createTransport({
    host,
    port,
    secure: port === 465,
    ...(user && pass ? { auth: { user, pass } } : {}),
  });

  logger.info("SMTP transport initialised", { host, port });
  return _smtpTransport;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
}

export async function sendEmail(opts: SendEmailOptions): Promise<Result<{ id: string }, string>> {
  const from = opts.from ?? process.env.EMAIL_FROM ?? "Westbridge <noreply@westbridge.app>";

  // ── 1. Resend (primary) ────────────────────────────────────────────────────
  if (process.env.RESEND_API_KEY) {
    try {
      const resend = getResend();
      const { data, error } = await resend.emails.send({
        from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
      });
      if (error) return err(error.message);
      return ok({ id: data?.id ?? "" });
    } catch (e) {
      return err(e instanceof Error ? e.message : "Failed to send email via Resend");
    }
  }

  // ── 2. SMTP fallback (nodemailer) ──────────────────────────────────────────
  const smtp = getSmtpTransport();
  if (smtp) {
    try {
      const info = await smtp.sendMail({
        from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
      });
      const messageId: string = typeof info?.messageId === "string" ? info.messageId : `smtp-${Date.now()}`;
      logger.debug("Email sent via SMTP", { to: opts.to, messageId });
      return ok({ id: messageId });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to send email via SMTP";
      logger.error("SMTP send failed", { to: opts.to, error: message });
      return err(message);
    }
  }

  // ── 3. Dev/test — log and skip ─────────────────────────────────────────────
  const isDev = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
  if (isDev) {
    logger.warn("No email transport configured — skipping email send in dev/test", {
      to: opts.to,
      subject: opts.subject,
      nodeEnv: process.env.NODE_ENV,
    });
    return ok({ id: `dev-skipped-${Date.now()}` });
  }

  // ── 4. Production with no transport — hard error ───────────────────────────
  return err("No email transport configured (RESEND_API_KEY or SMTP_HOST required).");
}
