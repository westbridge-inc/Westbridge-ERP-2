/**
 * TOTP 2FA routes.
 *
 * POST /auth/2fa/setup    — Generate TOTP secret + QR code
 * POST /auth/2fa/verify   — Verify TOTP code and enable 2FA
 * POST /auth/2fa/disable  — Disable 2FA
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { randomBytes, createHash, createHmac } from "crypto";
import { requireAuth, requireCsrf, rateLimit, toWebRequest } from "../middleware/auth.js";
import { apiSuccess, apiError, apiMeta, getRequestId } from "../types/api.js";
import { logAudit, auditContext } from "../lib/services/audit.service.js";
import { encrypt, decrypt } from "../lib/encryption.js";
import { prisma } from "../lib/data/prisma.js";

const router = Router();

// Base32 encoding for TOTP secrets (RFC 4648)
const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function toBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_CHARS[(value << (5 - bits)) & 31];
  return output;
}

function fromBase32(str: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of str.toUpperCase()) {
    const idx = alphabet.indexOf(c);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

// Verify TOTP with ±1 time step window (RFC 6238 clock skew tolerance).
//
// NOTE: SHA-1 is REQUIRED here by RFC 6238 for compatibility with every major
// authenticator app (Google Authenticator, Authy, 1Password, Microsoft
// Authenticator). HMAC-SHA1 is NOT weakened by SHA-1's collision vulnerabilities
// because TOTP does not rely on collision resistance — it relies on HMAC's
// pseudorandom function properties. Changing to SHA-256 would break 2FA for
// every user enrolled in the system.
function verifyTotp(secret: Buffer, code: string): boolean {
  for (const offset of [-1, 0, 1]) {
    const time = Math.floor(Date.now() / 1000 / 30) + offset;
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeBigInt64BE(BigInt(time));
    // nosemgrep: javascript.node-stdlib.cryptography.crypto-weak-algorithm.crypto-weak-algorithm
    const hmac = createHmac("sha1", secret).update(timeBuffer).digest();
    const off = hmac[hmac.length - 1]! & 0xf;
    const c = ((hmac[off]! & 0x7f) << 24) | (hmac[off + 1]! << 16) | (hmac[off + 2]! << 8) | hmac[off + 3]!;
    if (String(c % 1000000).padStart(6, "0") === code) return true;
  }
  return false;
}

// ─── POST /auth/2fa/setup ───────────────────────────────────────────────────

router.post("/auth/2fa/setup", requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const session = req.session!;
  const requestId = getRequestId(toWebRequest(req));

  // Check if already set up
  const existing = await prisma.totpSecret.findUnique({ where: { userId: session.userId } });
  if (existing?.verified) {
    return res
      .status(400)
      .json(apiError("ALREADY_ENABLED", "2FA is already enabled. Disable it first to reconfigure."));
  }

  // Generate secret
  const secretBytes = randomBytes(20);
  const base32Secret = toBase32(secretBytes);

  // Get user email for the QR label
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { email: true },
  });

  // Generate backup codes
  const backupCodes = Array.from({ length: 8 }, () => randomBytes(4).toString("hex"));
  const hashedBackupCodes = backupCodes.map((c) => createHash("sha256").update(c).digest("hex"));

  // Store encrypted secret
  await prisma.totpSecret.upsert({
    where: { userId: session.userId },
    update: {
      secret: encrypt(base32Secret),
      verified: false,
      backupCodes: hashedBackupCodes,
    },
    create: {
      userId: session.userId,
      secret: encrypt(base32Secret),
      verified: false,
      backupCodes: hashedBackupCodes,
    },
  });

  // Generate otpauth URI for QR code scanning
  const issuer = "Westbridge";
  const otpauthUri = `otpauth://totp/${issuer}:${encodeURIComponent(user?.email ?? session.userId)}?secret=${base32Secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

  return res.json(
    apiSuccess(
      {
        secret: base32Secret,
        otpauthUri,
        backupCodes,
        qrHint: "Scan the QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.)",
      },
      apiMeta({ request_id: requestId }),
    ),
  );
});

// ─── POST /auth/2fa/verify ──────────────────────────────────────────────────

const verifySchema = z.object({ code: z.string().length(6).regex(/^\d+$/) });

router.post(
  "/auth/2fa/verify",
  requireAuth,
  requireCsrf,
  rateLimit("authenticated", "/api/auth/2fa/verify"),
  async (req: Request, res: Response) => {
    const session = req.session!;
    const requestId = getRequestId(toWebRequest(req));
    const ctx = auditContext(toWebRequest(req));

    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(apiError("VALIDATION", "6-digit code required"));
    }

    const totp = await prisma.totpSecret.findUnique({ where: { userId: session.userId } });
    if (!totp) {
      return res.status(400).json(apiError("NOT_SETUP", "2FA setup not started. Call /auth/2fa/setup first."));
    }

    const secretBase32 = decrypt(totp.secret);
    // Decode base32 to bytes
    const secretBytes = fromBase32(secretBase32);

    if (!verifyTotp(secretBytes, parsed.data.code)) {
      return res.status(401).json(apiError("INVALID_CODE", "Invalid verification code. Try again."));
    }

    await prisma.totpSecret.update({
      where: { userId: session.userId },
      data: { verified: true },
    });

    void logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "auth.2fa.enabled",
      ...ctx,
      severity: "info",
      outcome: "success",
    });

    return res.json(apiSuccess({ enabled: true }, apiMeta({ request_id: requestId })));
  },
);

// ─── POST /auth/2fa/disable ─────────────────────────────────────────────────

router.post("/auth/2fa/disable", requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const session = req.session!;
  const requestId = getRequestId(toWebRequest(req));
  const ctx = auditContext(toWebRequest(req));

  await prisma.totpSecret.deleteMany({ where: { userId: session.userId } });

  void logAudit({
    accountId: session.accountId,
    userId: session.userId,
    action: "auth.2fa.disabled",
    ...ctx,
    severity: "warn",
    outcome: "success",
  });

  return res.json(apiSuccess({ disabled: true }, apiMeta({ request_id: requestId })));
});

// ─── POST /auth/2fa/recover ─────────────────────────────────────────────────
//
// Single-use backup code redemption. The client supplies one of the 8 codes
// generated at /auth/2fa/setup. The matching SHA-256 hash is removed from
// the user's `backupCodes` array on success so each code is one-shot.
//
// This endpoint requires a valid session (the user has already passed the
// password step) and acts as the second factor in place of a TOTP code,
// solving the lockout case where the user has lost their authenticator app.
//
// Rate-limited and CSRF-protected to prevent online brute-force of the
// 32-bit-per-code search space.

const recoverSchema = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{8}$/, "Backup code must be 8 hex characters"),
});

router.post(
  "/auth/2fa/recover",
  requireAuth,
  requireCsrf,
  rateLimit("authenticated", "/api/auth/2fa/recover"),
  async (req: Request, res: Response) => {
    const session = req.session!;
    const requestId = getRequestId(toWebRequest(req));
    const ctx = auditContext(toWebRequest(req));

    const parsed = recoverSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json(apiError("VALIDATION", "Backup code must be 8 hexadecimal characters (e.g. a1b2c3d4)"));
    }

    const totp = await prisma.totpSecret.findUnique({ where: { userId: session.userId } });
    if (!totp || !totp.verified) {
      // Audit the attempt — recovery on a non-2FA account is suspicious enough
      // to warrant a record even though we return a generic error.
      void logAudit({
        accountId: session.accountId,
        userId: session.userId,
        action: "auth.2fa.recover_attempted_no_2fa",
        ...ctx,
        severity: "warn",
        outcome: "failure",
      });
      return res.status(400).json(apiError("NOT_ENABLED", "2FA is not enabled for this account"));
    }

    // Hash the supplied code and look for a match in the stored array.
    // The codes are stored as SHA-256 hashes, never plaintext, so even a
    // database leak does not yield usable backup codes.
    const candidateHash = createHash("sha256").update(parsed.data.code).digest("hex");
    const remaining = totp.backupCodes.filter((stored) => stored !== candidateHash);

    if (remaining.length === totp.backupCodes.length) {
      // No match: do NOT decrement remaining-codes counters or change state.
      // The audit log captures the failure for incident response.
      void logAudit({
        accountId: session.accountId,
        userId: session.userId,
        action: "auth.2fa.recover_failed",
        ...ctx,
        severity: "warn",
        outcome: "failure",
      });
      return res.status(401).json(apiError("INVALID_CODE", "Backup code is invalid or already used"));
    }

    // One-shot consumption: persist the array with the matched code removed.
    await prisma.totpSecret.update({
      where: { userId: session.userId },
      data: { backupCodes: remaining },
    });

    void logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "auth.2fa.recover_succeeded",
      metadata: { remainingCodes: remaining.length },
      ...ctx,
      severity: remaining.length === 0 ? "critical" : "warn",
      outcome: "success",
    });

    return res.json(
      apiSuccess(
        {
          recovered: true,
          remainingCodes: remaining.length,
          warning:
            remaining.length === 0
              ? "You have used your last backup code. Disable and re-enroll 2FA to generate new codes."
              : remaining.length <= 2
                ? `Only ${remaining.length} backup codes remain. Re-enroll 2FA soon to refresh them.`
                : undefined,
        },
        apiMeta({ request_id: requestId }),
      ),
    );
  },
);

export default router;
