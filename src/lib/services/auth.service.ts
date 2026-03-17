/**
 * Auth service: ERPNext login, password hashing & verification.
 * Orchestrates data layer; returns Result.
 */

import { createHash } from "crypto";
import { erpLogin } from "../data/auth.client.js";
import { ok, err, type Result } from "../utils/result.js";
import { logger } from "../logger.js";
import bcrypt from "bcrypt";
import { prisma } from "../data/prisma.js";
import { validatePassword } from "../password-policy.js";

// ---------------------------------------------------------------------------
// Password hashing & verification
// ---------------------------------------------------------------------------

const BCRYPT_ROUNDS = 12;

/**
 * Hash a password using bcrypt with 12 rounds.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Verify a password against a stored bcrypt hash.
 *
 * Legacy SHA-256 hashes are no longer accepted — all passwords must be
 * bcrypt-hashed. If a legacy hash is encountered, the function returns false
 * and logs a warning so the account can be flagged for password reset.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  // Reject legacy SHA-256 hashes — they are unsalted and insecure
  if (hash.length === 64 && /^[a-f0-9]+$/.test(hash)) {
    logger.warn("Legacy SHA-256 password hash encountered — rejecting login. User must reset password.");
    return false;
  }
  return bcrypt.compare(password, hash);
}

// RFC 5322-inspired email format check. Not exhaustive — the goal is to reject
// clearly invalid inputs (e.g. "x", "", "foo@") before sending them to ERPNext,
// which may return error messages that expose internal details.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function login(email: string, password: string): Promise<Result<string, string>> {
  const trimmedEmail = email?.trim() ?? "";
  if (!trimmedEmail) return err("Email and password required");
  if (!EMAIL_REGEX.test(trimmedEmail)) return err("Invalid email address");

  // Reject whitespace-only passwords. Passwords with leading/trailing spaces
  // are intentionally preserved (some users set them deliberately), but a
  // password consisting entirely of whitespace is almost certainly a mistake.
  if (!password || !password.trim()) return err("Email and password required");

  const erpResult = await erpLogin(trimmedEmail, password);

  // In development, fall back to local bcrypt verification when ERPNext is
  // unreachable. This allows local testing without a running ERPNext instance.
  if (!erpResult.ok && process.env.NODE_ENV === "development") {
    logger.info("ERPNext login failed, trying local password fallback (dev mode)");
    const user = await prisma.user
      .findFirst({ where: { email: trimmedEmail }, select: { passwordHash: true } })
      .catch(() => null);
    if (user?.passwordHash) {
      const match = await verifyPassword(password, user.passwordHash);
      if (match) {
        logger.info("Local password verification succeeded (dev mode)");
        return ok("dev-local-session");
      }
    }
  }

  return erpResult;
}

// ---------------------------------------------------------------------------
// Change password
// ---------------------------------------------------------------------------

export interface ChangePasswordInput {
  userId: string;
  currentPassword: string;
  newPassword: string;
  /** The raw session token so we can keep the current session alive. */
  sessionToken: string;
}

/**
 * Change a user's password: validates the current password, enforces
 * password policy, updates ERPNext (non-fatal on failure), updates the
 * local bcrypt hash, and revokes all sessions except the current one.
 *
 * Returns a Result with a success message or an error code + message.
 */
export async function changePassword(
  input: ChangePasswordInput,
): Promise<Result<{ message: string }, { code: string; message: string }>> {
  const { userId, currentPassword, newPassword, sessionToken } = input;

  // --- Validate new password policy ---
  const { valid, errors } = validatePassword(newPassword);
  if (!valid) {
    return err({ code: "VALIDATION", message: errors.join(". ") });
  }

  // --- Verify current password ---
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, passwordHash: true },
  });
  if (!user) {
    return err({ code: "NOT_FOUND", message: "User not found" });
  }

  const match = await verifyPassword(currentPassword, user.passwordHash ?? "");
  if (!match) {
    return err({ code: "UNAUTHORIZED", message: "Current password is incorrect" });
  }

  // --- Update password in ERPNext (non-fatal) ---
  const erpUrl = process.env.ERPNEXT_URL ?? "http://localhost:8080";
  const erpApiKey = process.env.ERPNEXT_API_KEY ?? "";
  const erpApiSecret = process.env.ERPNEXT_API_SECRET ?? "";
  const erpRes = await fetch(`${erpUrl}/api/method/frappe.core.doctype.user.user.update_password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(erpApiKey && erpApiSecret ? { Authorization: `token ${erpApiKey}:${erpApiSecret}` } : {}),
    },
    body: JSON.stringify({
      new_password: newPassword,
      logout_all_sessions: 0,
      user: user.email,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);

  if (erpRes && !erpRes.ok) {
    const text = await erpRes.text().catch(() => "");
    logger.warn("change-password: ERPNext update failed", {
      status: erpRes.status,
      body: text,
    });
  }

  // --- Update hash and revoke all other sessions (keep current only) ---
  const tokenHash = createHash("sha256").update(sessionToken).digest("hex");
  const newHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash },
    }),
    prisma.session.deleteMany({
      where: { userId: user.id, token: { not: tokenHash } },
    }),
  ]);

  return ok({ message: "Password updated successfully" });
}
