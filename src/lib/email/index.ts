/**
 * Email client: thin wrapper around Resend.
 * All email sending in the app goes through sendEmail().
 */

import { Resend } from "resend";
import { ok, err, type Result } from "../utils/result.js";

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

export async function sendEmail(opts: SendEmailOptions): Promise<Result<{ id: string }, string>> {
  const from = opts.from ?? process.env.EMAIL_FROM ?? "Westbridge <noreply@westbridgetoday.com>";

  // In development/test without RESEND_API_KEY, log instead of silently failing
  if (!process.env.RESEND_API_KEY) {
    const isDev = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
    if (isDev) {
      console.warn(
        `[email] RESEND_API_KEY not set — skipping email send in ${process.env.NODE_ENV}. ` +
          `To: ${opts.to}, Subject: ${opts.subject}`,
      );
      return ok({ id: `dev-skipped-${Date.now()}` });
    }
    return err("RESEND_API_KEY is not configured. Email cannot be sent.");
  }

  try {
    const resend = getResend();
    const { data, error } = await resend.emails.send({
      from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
    });
    if (error) return err("Unable to send the email right now. Please try again.");
    return ok({ id: data?.id ?? "" });
  } catch (_e) {
    return err("Unable to send the email right now. Please try again.");
  }
}
