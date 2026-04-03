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

const TEXT_PRIMARY = "#0a0a0a";
const TEXT_SECONDARY = "#6b6b6b";
const TEXT_TERTIARY = "#8a8a8a";
const BORDER_COLOR = "#e5e5e5";
const BUTTON_BG = "#0a0a0a";
const LINK_COLOR = "#0a0a0a";

function layout(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#ffffff;">
    <tr><td align="center" style="padding:40px 20px;">
      <table width="560" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;width:100%;">

        <!-- Logo -->
        <tr><td style="padding:0 0 32px 0;">
          <span style="font-size:15px;font-weight:700;color:${TEXT_PRIMARY};letter-spacing:0.08em;text-transform:uppercase;">WESTBRIDGE</span>
        </td></tr>

        <!-- Divider -->
        <tr><td style="padding:0 0 32px 0;">
          <div style="height:1px;background-color:${BORDER_COLOR};"></div>
        </td></tr>

        <!-- Content -->
        <tr><td style="padding:0;">
          ${content}
        </td></tr>

        <!-- Divider -->
        <tr><td style="padding:32px 0 0 0;">
          <div style="height:1px;background-color:${BORDER_COLOR};"></div>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:24px 0 0 0;">
          <p style="font-size:13px;line-height:20px;color:${TEXT_TERTIARY};margin:0;">Westbridge Inc.</p>
          <p style="font-size:13px;line-height:20px;color:${TEXT_TERTIARY};margin:8px 0 0 0;">If you have questions, contact us at <a href="mailto:support@westbridge.com" style="color:${TEXT_TERTIARY};text-decoration:underline;">support@westbridge.com</a></p>
          <p style="font-size:12px;line-height:18px;color:${TEXT_TERTIARY};margin:12px 0 0 0;">You're receiving this email because you have an account with Westbridge. <a href="#" style="color:${TEXT_TERTIARY};text-decoration:underline;">Unsubscribe</a></p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function button(href: string, label: string): string {
  return `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:24px 0;">
    <tr><td align="center" style="background-color:${BUTTON_BG};border-radius:6px;">
      <a href="${href}" target="_blank" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;line-height:20px;">${label}</a>
    </td></tr>
  </table>`;
}

function fallbackLink(href: string): string {
  return `<p style="font-size:13px;line-height:20px;color:${TEXT_TERTIARY};margin:0;">
    If the button above doesn't work, copy and paste this URL into your browser:<br>
    <a href="${href}" style="color:${LINK_COLOR};text-decoration:underline;word-break:break-all;">${href}</a>
  </p>`;
}

function expiry(minutes: number): string {
  const label = minutes >= 60 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`;
  return `<p style="font-size:13px;line-height:20px;color:${TEXT_TERTIARY};margin:12px 0 0 0;">This link will expire in ${label}.</p>`;
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
    <h1 style="font-size:20px;font-weight:600;color:${TEXT_PRIMARY};margin:0 0 16px;line-height:28px;">You've been invited to join ${esc(data.companyName)}</h1>
    <p style="font-size:15px;line-height:24px;color:${TEXT_SECONDARY};margin:0 0 8px;">${esc(data.inviterName)} has invited you to collaborate on Westbridge as a <strong style="color:${TEXT_PRIMARY};font-weight:600;">${esc(data.role)}</strong>.</p>
    <p style="font-size:15px;line-height:24px;color:${TEXT_SECONDARY};margin:0 0 4px;">Accept the invitation below to create your account and get started.</p>
    ${button(data.acceptUrl, "Accept invitation")}
    ${fallbackLink(data.acceptUrl)}
    ${expiry(72 * 60)}
    <p style="font-size:13px;line-height:20px;color:${TEXT_TERTIARY};margin:16px 0 0 0;">If you weren't expecting this invitation, you can ignore this email.</p>
  `);
}

export interface PasswordResetEmailData {
  userName: string;
  resetUrl: string;
}

export function passwordResetEmail(data: PasswordResetEmailData): string {
  return layout(`
    <h1 style="font-size:20px;font-weight:600;color:${TEXT_PRIMARY};margin:0 0 16px;line-height:28px;">Reset your password</h1>
    <p style="font-size:15px;line-height:24px;color:${TEXT_SECONDARY};margin:0 0 4px;">We received a request to reset the password for the Westbridge account associated with ${esc(data.userName || "your email")}.</p>
    <p style="font-size:15px;line-height:24px;color:${TEXT_SECONDARY};margin:0;">Click the button below to choose a new password.</p>
    ${button(data.resetUrl, "Reset password")}
    ${fallbackLink(data.resetUrl)}
    ${expiry(30)}
    <p style="font-size:13px;line-height:20px;color:${TEXT_TERTIARY};margin:16px 0 0 0;">If you didn't make this request, no action is needed. Your password will remain unchanged.</p>
  `);
}

export interface AccountActivatedEmailData {
  companyName: string;
  plan: string;
  loginUrl: string;
}

export function accountActivatedEmail(data: AccountActivatedEmailData): string {
  return layout(`
    <h1 style="font-size:20px;font-weight:600;color:${TEXT_PRIMARY};margin:0 0 16px;line-height:28px;">Your account is ready</h1>
    <p style="font-size:15px;line-height:24px;color:${TEXT_SECONDARY};margin:0 0 8px;">Payment confirmed. <strong style="color:${TEXT_PRIMARY};font-weight:600;">${esc(data.companyName)}</strong> is now active on the <strong style="color:${TEXT_PRIMARY};font-weight:600;">${esc(data.plan)}</strong> plan.</p>
    <p style="font-size:15px;line-height:24px;color:${TEXT_SECONDARY};margin:0;">Sign in to your dashboard to get started.</p>
    ${button(data.loginUrl, "Go to dashboard")}
    <p style="font-size:13px;line-height:20px;color:${TEXT_TERTIARY};margin:0;">Need help? Reach out to us at <a href="mailto:support@westbridge.com" style="color:${LINK_COLOR};text-decoration:underline;">support@westbridge.com</a> and we'll be happy to assist.</p>
  `);
}

// ─── Trial Email Templates ───────────────────────────────────────────────────

export interface TrialWarningEmailData {
  companyName: string;
  daysRemaining: number;
  billingUrl: string;
}

export function trialWarningEmail(data: TrialWarningEmailData): string {
  const dayWord = data.daysRemaining === 1 ? "day" : "days";
  return layout(`
    <h1 style="font-size:20px;font-weight:600;color:${TEXT_PRIMARY};margin:0 0 16px;line-height:28px;">Your trial expires in ${data.daysRemaining} ${dayWord}</h1>
    <p style="font-size:15px;line-height:24px;color:${TEXT_SECONDARY};margin:0 0 8px;">The free trial for <strong style="color:${TEXT_PRIMARY};font-weight:600;">${esc(data.companyName)}</strong> is ending soon.</p>
    <p style="font-size:15px;line-height:24px;color:${TEXT_SECONDARY};margin:0 0 8px;">To keep access to your data and all features, subscribe to a plan before your trial ends.</p>
    <p style="font-size:15px;line-height:24px;color:${TEXT_SECONDARY};margin:0;">If you don't subscribe, your account will be paused and you won't be able to access your workspace.</p>
    ${button(data.billingUrl, "Choose a plan")}
    ${fallbackLink(data.billingUrl)}
    <p style="font-size:13px;line-height:20px;color:${TEXT_TERTIARY};margin:16px 0 0 0;">Questions? Contact us at <a href="mailto:support@westbridge.com" style="color:${LINK_COLOR};text-decoration:underline;">support@westbridge.com</a> -- we're happy to help.</p>
  `);
}

export interface TrialExpiredEmailData {
  companyName: string;
  billingUrl: string;
}

export function trialExpiredEmail(data: TrialExpiredEmailData): string {
  return layout(`
    <h1 style="font-size:20px;font-weight:600;color:${TEXT_PRIMARY};margin:0 0 16px;line-height:28px;">Your trial has expired</h1>
    <p style="font-size:15px;line-height:24px;color:${TEXT_SECONDARY};margin:0 0 8px;">The 14-day free trial for <strong style="color:${TEXT_PRIMARY};font-weight:600;">${esc(data.companyName)}</strong> has ended.</p>
    <p style="font-size:15px;line-height:24px;color:${TEXT_SECONDARY};margin:0 0 8px;">Your account is now paused. All your data is safe -- subscribe to a plan to restore access immediately.</p>
    <p style="font-size:15px;line-height:24px;color:${TEXT_SECONDARY};margin:0;">Accounts that remain inactive for 60 days will have their data permanently removed.</p>
    ${button(data.billingUrl, "Subscribe now")}
    ${fallbackLink(data.billingUrl)}
    <p style="font-size:13px;line-height:20px;color:${TEXT_TERTIARY};margin:16px 0 0 0;">Need help deciding on a plan? Reach out to us at <a href="mailto:support@westbridge.com" style="color:${LINK_COLOR};text-decoration:underline;">support@westbridge.com</a> and we'll be happy to assist.</p>
  `);
}
