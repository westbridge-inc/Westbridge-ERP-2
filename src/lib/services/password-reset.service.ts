/**
 * Password reset service: create tokens, validate, trigger ERPNext reset.
 */

import { randomBytes, createHash } from "crypto";
import { prisma } from "../data/prisma.js";
import { sendEmail } from "../email/index.js";
import { passwordResetEmail } from "../email/templates.js";
import { ok, err, type Result } from "../utils/result.js";

const RESET_EXPIRY_MINUTES = 30;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function requestPasswordReset(
  email: string,
  baseUrl: string
): Promise<Result<{ sent: boolean }, string>> {
  // Always return ok to prevent user enumeration — we only actually send if found
  const user = await prisma.user.findFirst({
    where: { email, status: "active" },
    include: { account: true },
  });

  if (!user) return ok({ sent: true }); // silent — don't reveal whether email exists

  // Invalidate any existing tokens for this user
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const raw = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + RESET_EXPIRY_MINUTES * 60 * 1000);

  try {
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });

    const resetUrl = `${baseUrl}/reset-password?token=${raw}`;
    await sendEmail({
      to: email,
      subject: "Reset your Westbridge password",
      html: passwordResetEmail({ userName: user.name ?? "", resetUrl }),
    });
  } catch {
    // Swallow errors — don't reveal whether email exists or token was saved
  }

  return ok({ sent: true });
}

export interface ValidateResetTokenResult {
  tokenId: string;
  userId: string;
  email: string;
}

export async function validateResetToken(
  raw: string
): Promise<Result<ValidateResetTokenResult, string>> {
  const tokenHash = hashToken(raw);
  const token = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  if (!token) return err("Invalid or expired reset link.");
  if (token.usedAt) return err("This reset link has already been used.");
  if (token.expiresAt < new Date()) return err("This reset link has expired. Request a new one.");
  return ok({ tokenId: token.id, userId: token.userId, email: token.user.email });
}

export interface ApplyPasswordResetInput {
  raw: string;
  newPassword: string;
}

export async function applyPasswordReset(
  input: ApplyPasswordResetInput
): Promise<Result<{ success: boolean }, string>> {
  const validateResult = await validateResetToken(input.raw);
  if (!validateResult.ok) return err(validateResult.error);

  const { tokenId, userId, email } = validateResult.data;

  // Trigger ERPNext password reset via its API (requires admin credentials)
  const erpUrl = process.env.ERPNEXT_URL ?? "http://localhost:8080";
  const erpApiKey = process.env.ERPNEXT_API_KEY ?? "";
  const erpApiSecret = process.env.ERPNEXT_API_SECRET ?? "";
  try {
    const res = await fetch(`${erpUrl}/api/method/frappe.core.doctype.user.user.update_password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(erpApiKey && erpApiSecret
          ? { Authorization: `token ${erpApiKey}:${erpApiSecret}` }
          : {}),
      },
      body: JSON.stringify({ new_password: input.newPassword, logout_all_sessions: 1, user: email }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return err("Failed to update password. Please try again.");
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : "Service temporarily unavailable");
  }

  // Mark token used, reset lockout state, and revoke all sessions (stolen tokens invalid after password change)
  await prisma.$transaction([
    prisma.passwordResetToken.update({ where: { id: tokenId }, data: { usedAt: new Date() } }),
    prisma.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: 0, lockedUntil: null, passwordChangedAt: new Date() },
    }),
    prisma.session.deleteMany({ where: { userId } }),
  ]);

  return ok({ success: true });
}
