/**
 * Email HTML templates. Returns complete HTML strings.
 * Inline styles only — email clients strip <style> blocks.
 */

/** Escape user-supplied values before inserting into HTML email templates. */
function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

const BRAND_COLOR = "#0f172a";
const ACCENT_COLOR = "#6366f1";
const BG = "#f8fafc";
const CARD_BG = "#ffffff";
const TEXT_MAIN = "#0f172a";
const TEXT_MUTED = "#64748b";
const BORDER = "#e2e8f0";

function layout(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:40px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <!-- Logo -->
        <tr><td style="padding-bottom:24px;text-align:center;">
          <span style="font-size:20px;font-weight:700;color:${BRAND_COLOR};letter-spacing:-0.02em;">Westbridge</span>
        </td></tr>
        <!-- Card -->
        <tr><td style="background:${CARD_BG};border:1px solid ${BORDER};border-radius:12px;padding:40px 40px 32px;">
          ${content}
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding-top:24px;text-align:center;font-size:12px;color:${TEXT_MUTED};">
          &copy; ${new Date().getFullYear()} Westbridge. All rights reserved.<br>
          You received this email because you have an account with Westbridge.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function button(href: string, label: string): string {
  return `<table cellpadding="0" cellspacing="0" style="margin:28px 0;">
    <tr><td style="background:${ACCENT_COLOR};border-radius:8px;">
      <a href="${href}" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${label}</a>
    </td></tr>
  </table>`;
}

function fallbackLink(href: string): string {
  return `<p style="font-size:13px;color:${TEXT_MUTED};margin-top:16px;">
    If the button doesn't work, copy and paste this link into your browser:<br>
    <a href="${href}" style="color:${ACCENT_COLOR};word-break:break-all;">${href}</a>
  </p>`;
}

function expiry(minutes: number): string {
  return `<p style="font-size:13px;color:${TEXT_MUTED};margin-top:8px;">This link expires in ${minutes} minutes.</p>`;
}

// ─── Unsubscribe footer (marketing/product emails only) ──────────────────────

const APP_SETTINGS_URL = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/settings/notifications`;

function unsubscribeFooter(): string {
  return `<p style="font-size:12px;color:${TEXT_MUTED};margin-top:24px;border-top:1px solid ${BORDER};padding-top:16px;">
    You received this email because you opted in to product updates.
    <a href="${APP_SETTINGS_URL}" style="color:${ACCENT_COLOR};text-decoration:underline;">Unsubscribe</a> or manage your notification preferences.
  </p>`;
}

// ─── Templates ────────────────────────────────────────────────────────────────

export interface InviteEmailData {
  inviterName: string;
  companyName: string;
  role: string;
  acceptUrl: string;
}

export function inviteEmail(data: InviteEmailData): string {
  return layout(`
    <h1 style="font-size:22px;font-weight:700;color:${TEXT_MAIN};margin:0 0 8px;">${esc(data.inviterName)} invited you to join ${esc(data.companyName)}</h1>
    <p style="font-size:15px;color:${TEXT_MUTED};margin:0 0 4px;">You've been invited as a <strong style="color:${TEXT_MAIN};">${esc(data.role)}</strong> on the Westbridge platform.</p>
    <p style="font-size:15px;color:${TEXT_MUTED};margin:0 0 24px;">Click the button below to accept the invite and set your password.</p>
    ${button(data.acceptUrl, "Accept invitation")}
    ${fallbackLink(data.acceptUrl)}
    ${expiry(72 * 60)}
    <p style="font-size:13px;color:${TEXT_MUTED};margin-top:16px;">If you weren't expecting this invitation, you can safely ignore this email.</p>
  `);
}

export interface PasswordResetEmailData {
  userName: string;
  resetUrl: string;
}

export function passwordResetEmail(data: PasswordResetEmailData): string {
  return layout(`
    <h1 style="font-size:22px;font-weight:700;color:${TEXT_MAIN};margin:0 0 8px;">Reset your password</h1>
    <p style="font-size:15px;color:${TEXT_MUTED};margin:0 0 24px;">Hi ${esc(data.userName || "there")}, we received a request to reset the password for your Westbridge account.</p>
    ${button(data.resetUrl, "Reset password")}
    ${fallbackLink(data.resetUrl)}
    ${expiry(30)}
    <p style="font-size:13px;color:${TEXT_MUTED};margin-top:16px;">If you didn't request a password reset, you can safely ignore this email. Your password will not be changed.</p>
  `);
}

export interface AccountActivatedEmailData {
  companyName: string;
  plan: string;
  loginUrl: string;
}

export function accountActivatedEmail(data: AccountActivatedEmailData): string {
  return layout(`
    <h1 style="font-size:22px;font-weight:700;color:${TEXT_MAIN};margin:0 0 8px;">Your account is active 🎉</h1>
    <p style="font-size:15px;color:${TEXT_MUTED};margin:0 0 8px;">Payment confirmed. <strong style="color:${TEXT_MAIN};">${esc(data.companyName)}</strong> is now on the <strong style="color:${TEXT_MAIN};">${esc(data.plan)}</strong> plan.</p>
    <p style="font-size:15px;color:${TEXT_MUTED};margin:0 0 24px;">Sign in to start using Westbridge.</p>
    ${button(data.loginUrl, "Go to dashboard")}
    <p style="font-size:13px;color:${TEXT_MUTED};margin-top:8px;">Need help getting started? Reply to this email — we're here.</p>
    ${unsubscribeFooter()}
  `);
}

// ─── Customer Portal Invite ────────────────────────────────────────────────

export interface PortalInviteEmailData {
  customerName: string;
  companyName: string;
  portalUrl: string;
}

export function portalInviteEmail(data: PortalInviteEmailData): string {
  return layout(`
    <h1 style="font-size:22px;font-weight:700;color:${TEXT_MAIN};margin:0 0 8px;">Your documents are ready</h1>
    <p style="font-size:15px;color:${TEXT_MUTED};margin:0 0 4px;">Hi ${esc(data.customerName)},</p>
    <p style="font-size:15px;color:${TEXT_MUTED};margin:0 0 24px;"><strong style="color:${TEXT_MAIN};">${esc(data.companyName)}</strong> has shared your invoices, quotations, and orders with you. Click the link below to view them.</p>
    ${button(data.portalUrl, "View your documents")}
    ${fallbackLink(data.portalUrl)}
    <p style="font-size:13px;color:${TEXT_MUTED};margin-top:16px;">This link expires in 30 days. If you need a new link, please contact ${esc(data.companyName)} directly.</p>
    <p style="font-size:13px;color:${TEXT_MUTED};margin-top:8px;">If you weren't expecting this email, you can safely ignore it.</p>
  `);
}
