/**
 * Invite service: create invite tokens, validate, and accept invites.
 */

import { randomBytes, createHash } from "crypto";
import { prisma } from "../data/prisma.js";
import { sendEmail } from "../email/index.js";
import { inviteEmail } from "../email/templates.js";
import { ok, err, type Result } from "../utils/result.js";

const INVITE_EXPIRY_HOURS = 72;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export type InviteRole = "admin" | "manager" | "member" | "viewer";

export interface CreateInviteInput {
  accountId: string;
  email: string;
  role: InviteRole;
  inviterName: string;
  companyName: string;
  baseUrl: string;
}

export async function createInvite(input: CreateInviteInput): Promise<Result<{ inviteId: string }, string>> {
  const { accountId, email, role, inviterName, companyName, baseUrl } = input;

  // Check for existing active (non-used, non-expired) invite
  const existingUser = await prisma.user.findUnique({
    where: { accountId_email: { accountId, email } },
  });
  if (existingUser && existingUser.status !== "invited") {
    return err("A user with this email already has an active account.");
  }

  const raw = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

  const invite = await prisma.$transaction(async (tx) => {
    await tx.inviteToken.updateMany({
      where: { accountId, email, usedAt: null },
      data: { usedAt: new Date() },
    });
    return tx.inviteToken.create({
      data: { accountId, email, role, tokenHash, expiresAt },
    });
  });

  const acceptUrl = `${baseUrl}/invite?token=${raw}`;
  const emailResult = await sendEmail({
    to: email,
    subject: `You've been invited to join ${companyName} on Westbridge`,
    html: inviteEmail({ inviterName, companyName, role, acceptUrl }),
  });

  if (!emailResult.ok) {
    // Roll back the invite token so the user can retry
    await prisma.inviteToken.delete({ where: { id: invite.id } }).catch(() => {});
    return err("Unable to send the invite email. Please try again.");
  }

  return ok({ inviteId: invite.id });
}

export interface ValidateInviteResult {
  inviteId: string;
  accountId: string;
  email: string;
  role: InviteRole;
}

export async function validateInviteToken(raw: string): Promise<Result<ValidateInviteResult, string>> {
  const tokenHash = hashToken(raw);
  const invite = await prisma.inviteToken.findUnique({ where: { tokenHash } });
  if (!invite) return err("Invalid or expired invite link.");
  if (invite.usedAt) return err("This invite has already been used.");
  if (invite.expiresAt < new Date()) return err("This invite link has expired.");
  return ok({
    inviteId: invite.id,
    accountId: invite.accountId,
    email: invite.email,
    role: invite.role as InviteRole,
  });
}

export interface AcceptInviteInput {
  raw: string;
  name: string;
}

export async function acceptInvite(
  input: AcceptInviteInput,
): Promise<Result<{ userId: string; accountId: string }, string>> {
  const validateResult = await validateInviteToken(input.raw);
  if (!validateResult.ok) return err(validateResult.error);

  const { inviteId, accountId, email, role } = validateResult.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Mark token as used
      await tx.inviteToken.update({
        where: { id: inviteId },
        data: { usedAt: new Date() },
      });

      // Upsert user — create if not exists, activate if invited
      const existingCount = await tx.user.count({ where: { accountId } });
      const user = await tx.user.upsert({
        where: { accountId_email: { accountId, email } },
        update: { name: input.name, status: "active", role },
        create: {
          accountId,
          email,
          name: input.name,
          role: existingCount === 0 ? "owner" : role,
          status: "active",
        },
      });
      return user;
    });

    return ok({ userId: result.id, accountId });
  } catch (_e) {
    return err("Unable to accept the invite right now. Please try again.");
  }
}
