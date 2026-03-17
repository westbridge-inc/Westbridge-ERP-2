/**
 * Team routes
 *
 * GET    /team           — returns all users belonging to the current account
 * DELETE /team/:id       — remove a team member (soft-delete + revoke sessions)
 * PATCH  /team/:id/role  — change a team member's role
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/data/prisma.js";
import { apiSuccess, apiError, apiMeta, getRequestId } from "../types/api.js";
import { checkTieredRateLimit, getClientIdentifier, rateLimitHeaders } from "../lib/api/rate-limit-tiers.js";
import { requireAuth, requireCsrf, requirePermission, toWebRequest } from "../middleware/auth.js";
import { revokeAllUserSessions } from "../lib/services/session.service.js";
import { logAudit, auditContext } from "../lib/services/audit.service.js";
import { ROLES } from "../lib/rbac.js";

const router = Router();

function formatRelative(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 2) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// GET /team — returns all users belonging to the current account
// ---------------------------------------------------------------------------
router.get("/team", requireAuth, requirePermission("users:read"), async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });

  const session = req.session!;

  const rateLimit = await checkTieredRateLimit(getClientIdentifier(toWebRequest(req)), "authenticated", "/api/team");
  if (!rateLimit.allowed) {
    return res
      .status(429)
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .set(rateLimitHeaders(rateLimit) as Record<string, string>)
      .json(apiError("RATE_LIMIT", "Too many requests", undefined, meta()));
  }

  const users = await prisma.user.findMany({
    where: { accountId: session.accountId },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      status: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const currentUserId = session.userId;

  const members = users.map((u) => ({
    id: u.id,
    name: u.name ?? u.email.split("@")[0],
    email: u.email,
    role: u.role,
    status: u.status,
    lastActive: u.createdAt ? formatRelative(u.createdAt) : "Never",
    isYou: u.id === currentUserId,
  }));

  return res.set("X-Response-Time", `${Date.now() - start}ms`).json(apiSuccess({ members }, meta()));
});

// ---------------------------------------------------------------------------
// DELETE /team/:id — remove a team member
// ---------------------------------------------------------------------------
router.delete(
  "/team/:id",
  requireAuth,
  requireCsrf,
  requirePermission("users:remove"),
  async (req: Request, res: Response) => {
    const requestId = getRequestId(toWebRequest(req));
    const meta = () => apiMeta({ request_id: requestId });
    const ctx = auditContext(toWebRequest(req));
    const session = req.session!;
    const targetUserId = req.params.id as string;

    if (targetUserId === session.userId) {
      return res.status(400).json(apiError("BAD_REQUEST", "You cannot remove yourself", undefined, meta()));
    }

    const targetUser = await prisma.user.findFirst({
      where: { id: targetUserId, accountId: session.accountId, deletedAt: null },
    });

    if (!targetUser) {
      return res.status(404).json(apiError("NOT_FOUND", "User not found", undefined, meta()));
    }

    if (targetUser.role === "owner") {
      return res.status(403).json(apiError("FORBIDDEN", "The account owner cannot be removed", undefined, meta()));
    }

    // Soft-delete and suspend
    await prisma.user.update({
      where: { id: targetUserId },
      data: { status: "suspended", deletedAt: new Date() },
    });

    // Revoke all sessions so the user is logged out immediately
    await revokeAllUserSessions(targetUserId);

    void logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "team.member.removed",
      resourceId: targetUserId,
      meta: { removedEmail: targetUser.email, removedRole: targetUser.role },
      ...ctx,
      severity: "warn",
      outcome: "success",
    });

    return res.json(apiSuccess({ removed: true }, meta()));
  },
);

// ---------------------------------------------------------------------------
// PATCH /team/:id/role — change a team member's role
// ---------------------------------------------------------------------------
const roleChangeSchema = z.object({
  role: z.enum(["admin", "manager", "member", "viewer"]),
});

router.patch(
  "/team/:id/role",
  requireAuth,
  requireCsrf,
  requirePermission("users:manage_roles"),
  async (req: Request, res: Response) => {
    const requestId = getRequestId(toWebRequest(req));
    const meta = () => apiMeta({ request_id: requestId });
    const ctx = auditContext(toWebRequest(req));
    const session = req.session!;
    const targetUserId = req.params.id as string;

    if (targetUserId === session.userId) {
      return res.status(400).json(apiError("BAD_REQUEST", "You cannot change your own role", undefined, meta()));
    }

    const parsed = roleChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json(
          apiError(
            "VALIDATION_ERROR",
            `Role must be one of: ${ROLES.filter((r) => r !== "owner").join(", ")}`,
            undefined,
            meta(),
          ),
        );
    }

    const targetUser = await prisma.user.findFirst({
      where: { id: targetUserId, accountId: session.accountId, deletedAt: null },
    });

    if (!targetUser) {
      return res.status(404).json(apiError("NOT_FOUND", "User not found", undefined, meta()));
    }

    // Cannot demote the only owner
    if (targetUser.role === "owner") {
      const ownerCount = await prisma.user.count({
        where: { accountId: session.accountId, role: "owner", deletedAt: null },
      });
      if (ownerCount <= 1) {
        return res.status(403).json(apiError("FORBIDDEN", "Cannot demote the only account owner", undefined, meta()));
      }
    }

    const previousRole = targetUser.role;
    await prisma.user.update({
      where: { id: targetUserId },
      data: { role: parsed.data.role },
    });

    void logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "team.member.role_changed",
      resourceId: targetUserId,
      meta: { email: targetUser.email, previousRole, newRole: parsed.data.role },
      ...ctx,
      severity: "info",
      outcome: "success",
    });

    return res.json(apiSuccess({ userId: targetUserId, role: parsed.data.role }, meta()));
  },
);

export default router;
