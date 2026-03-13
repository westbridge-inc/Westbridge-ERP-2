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
  const from = opts.from ?? process.env.EMAIL_FROM ?? "Westbridge <noreply@westbridge.app>";
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
    return err(e instanceof Error ? e.message : "Failed to send email");
  }
}
