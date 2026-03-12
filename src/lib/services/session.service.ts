/**
 * Session service: create, validate, revoke. Tokens are hashed (SHA-256) before storage.
 */

import { createHash, randomBytes } from "crypto";
import { isIP } from "net";
import { prisma } from "../data/prisma.js";
import type { Result } from "../utils/result.js";
import { ok, err } from "../utils/result.js";
import { logAudit, auditContext } from "../services/audit.service.js";
import { reportSecurityEvent } from "../security-monitor.js";
import { encrypt, decrypt } from "../encryption.js";
import { getRedis } from "../redis.js";
import { logger } from "../logger.js";

const SESSION_EXPIRY_DAYS = 7;
const IDLE_TIMEOUT_MINUTES = 30;
const MAX_CONCURRENT_SESSIONS = 5;
const SESSION_CACHE_TTL_SEC = 30;
const SESSION_CACHE_PREFIX = "session:v1:";
// Index of all cache keys for a given userId — used for bulk revocation.
const SESSION_USER_INDEX_PREFIX = "session:user:";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Only trust X-Forwarded-For values that are valid IPv4 or IPv6 addresses.
// net.isIP() strictly validates RFC 3513/791 format; the previous regex
// /^[0-9a-fA-F:]+$/ accepted invalid patterns like "::::::::::".
function isValidIp(ip: string): boolean {
  return isIP(ip) !== 0;
}

function getIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return null;
  const candidate = forwarded.split(",")[0]?.trim() ?? "";
  return isValidIp(candidate) ? candidate : null;
}

function getUserAgent(request: Request): string | null {
  return request.headers.get("user-agent") ?? null;
}

function fingerprintFromRequest(request: Request): string | null {
  const ua = getUserAgent(request);
  if (!ua) return null;
  const ip = getIp(request);
  const prefix = ip ? ip.split(".").slice(0, 3).join(".") : "";
  return createHash("sha256").update(`${ua}|${prefix}`, "utf8").digest("hex");
}

export type SessionRole = "owner" | "admin" | "manager" | "member" | "viewer";

interface CachedSession {
  userId: string;
  accountId: string;
  role: string;
  erpnextSid?: string | null;
  // Security fields stored in cache so we can validate without a DB hit.
  expiresAt: number;      // Unix ms — checked against Date.now()
  lastActiveAt: number;   // Unix ms — checked for idle timeout
  fingerprint: string | null;
}

/**
 * Create a new session for the user. Returns the raw token (to set in cookie); only the hash is stored.
 * Enforces max concurrent sessions atomically in a Prisma transaction to prevent TOCTOU races
 * under concurrent logins from the same user.
 */
export async function createSession(
  userId: string,
  request: Request,
  erpnextSid?: string | null
): Promise<Result<{ token: string; expiresAt: Date }, string>> {
  const raw = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  const fingerprint = fingerprintFromRequest(request);

  try {
    // Run the session count check and creation inside a serialized transaction
    // to prevent a TOCTOU race where two concurrent logins both see count < 5
    // and both proceed to create a session, exceeding the limit.
    await prisma.$transaction(async (tx) => {
      const now = new Date();
      const activeSessions = await tx.session.findMany({
        where: { userId, expiresAt: { gt: now } },
        orderBy: { lastActiveAt: "asc" },
      });

      if (activeSessions.length >= MAX_CONCURRENT_SESSIONS) {
        const oldest = activeSessions[0];
        // Delete the oldest session and remove it from Redis cache.
        await tx.session.delete({ where: { id: oldest.id } }).catch((e: unknown) => logger.warn("createSession: failed to delete oldest session", { error: e instanceof Error ? e.message : String(e) }));
        // Best-effort Redis cleanup outside transaction (non-critical).
        setImmediate(() => {
          getRedis()?.del(`${SESSION_CACHE_PREFIX}${oldest.token}`).catch((e: unknown) => logger.error("createSession: Redis cache eviction failed", { error: e instanceof Error ? e.message : String(e) }));
        });
      }

      const encryptedSid = erpnextSid ? encrypt(erpnextSid) : undefined;
      await tx.session.create({
        data: {
          userId,
          token: tokenHash,
          erpnextSid: encryptedSid,
          ipAddress: getIp(request),
          userAgent: getUserAgent(request),
          fingerprint: fingerprint ?? undefined,
          expiresAt,
        },
      });
    });

    // Register this token hash in the user's session index in Redis so
    // revokeAllUserSessions can flush all cache entries atomically.
    const redis = getRedis();
    if (redis) {
      const indexKey = `${SESSION_USER_INDEX_PREFIX}${userId}`;
      await redis
        .pipeline()
        .sadd(indexKey, `${SESSION_CACHE_PREFIX}${tokenHash}`)
        // Keep index alive for slightly longer than the session itself.
        .expire(indexKey, SESSION_EXPIRY_DAYS * 24 * 60 * 60 + 60)
        .exec()
        .catch((e: unknown) => logger.error("createSession: Redis user index update failed", { userId, error: e instanceof Error ? e.message : String(e) }));
    }

    // Audit oldest-session eviction after the transaction commits.
    const user = await prisma.user.findUnique({ where: { id: userId }, include: { account: true } }).catch((e: unknown) => { logger.error("createSession: failed to load user for audit", { userId, error: e instanceof Error ? e.message : String(e) }); return null; });
    if (user) {
      const ctx = auditContext(request);
      void logAudit({
        accountId: user.accountId,
        userId: user.id,
        action: "auth.session.created",
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        severity: "info",
        outcome: "success",
      });
    }

    return ok({ token: raw, expiresAt });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Failed to create session");
  }
}

/**
 * Validate session token. Returns userId, accountId, role; optionally erpnextSid for ERP proxy.
 *
 * Redis cache path: stores security-critical fields (expiresAt, lastActiveAt, fingerprint)
 * so they can be validated without a DB round-trip. This ensures the cache never bypasses
 * expiry, idle-timeout, or fingerprint checks.
 */
export async function validateSession(
  token: string,
  request?: Request
): Promise<Result<{ userId: string; accountId: string; role: SessionRole; erpnextSid?: string | null }, string>> {
  if (!token?.trim()) return err("Missing token");
  const tokenHash = hashToken(token);

  const now = new Date();
  const nowMs = now.getTime();
  const idleTimeoutMs = IDLE_TIMEOUT_MINUTES * 60 * 1000;

  try {
    const cacheKey = `${SESSION_CACHE_PREFIX}${tokenHash}`;
    const redis = getRedis();
    if (redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached) as CachedSession;

          // Validate expiry from cached value — do not skip even on cache hits.
          if (parsed.expiresAt <= nowMs) {
            // Session expired: delete from DB and cache, return error.
            void prisma.session.deleteMany({ where: { token: tokenHash } }).catch((e: unknown) => logger.error("validateSession: DB cleanup failed (expiry)", { error: e instanceof Error ? e.message : String(e) }));
            await redis.del(cacheKey).catch((e: unknown) => logger.error("validateSession: Redis cleanup failed (expiry)", { error: e instanceof Error ? e.message : String(e) }));
            return err("Session expired");
          }

          // Validate idle timeout from cached lastActiveAt.
          if (nowMs - parsed.lastActiveAt > idleTimeoutMs) {
            void prisma.session.deleteMany({ where: { token: tokenHash } }).catch((e: unknown) => logger.error("validateSession: DB cleanup failed (idle)", { error: e instanceof Error ? e.message : String(e) }));
            await redis.del(cacheKey).catch((e: unknown) => logger.error("validateSession: Redis cleanup failed (idle)", { error: e instanceof Error ? e.message : String(e) }));
            return err("Session expired");
          }

          // Validate fingerprint from cached value.
          if (parsed.fingerprint != null && request != null) {
            const currentFingerprint = fingerprintFromRequest(request);
            if (currentFingerprint == null || currentFingerprint !== parsed.fingerprint) {
              const ctx = auditContext(request);
              reportSecurityEvent({
                type: "session_hijack",
                userId: parsed.userId,
                accountId: parsed.accountId,
                ipAddress: ctx.ipAddress,
                details: "Session fingerprint mismatch (cache hit path)",
              });
              await redis.del(cacheKey).catch((e: unknown) => logger.error("validateSession: Redis del failed (fingerprint)", { error: e instanceof Error ? e.message : String(e) }));
              return err("Invalid session");
            }
          }

          const role = (["owner", "admin", "manager", "member", "viewer"].includes(parsed.role)
            ? parsed.role
            : "member") as SessionRole;

          // Update cached lastActiveAt to prevent premature idle timeout on cache hits.
          const cachedLastActiveMs = parsed.lastActiveAt;
          if (nowMs - cachedLastActiveMs > 60_000) {
            parsed.lastActiveAt = nowMs;
            redis.set(cacheKey, JSON.stringify(parsed), "EX", SESSION_CACHE_TTL_SEC).catch(() => {});
            // Lazy DB update — fire and forget
            void prisma.session.updateMany({ where: { token: tokenHash }, data: { lastActiveAt: now } }).catch(() => {});
          }

          return ok({
            userId: parsed.userId,
            accountId: parsed.accountId,
            role,
            erpnextSid: parsed.erpnextSid ? (() => { try { return decrypt(parsed.erpnextSid!); } catch { return undefined; } })() : undefined,
          });
        }
      } catch (redisErr) {
        // Cache read error — fall through to DB, but log so ops can detect Redis issues.
        logger.warn("validateSession: Redis cache read failed, falling back to DB", {
          error: redisErr instanceof Error ? redisErr.message : String(redisErr),
        });
      }
    }

    const session = await prisma.session.findUnique({
      where: { token: tokenHash },
      include: { user: { include: { account: true } } },
    });
    if (!session) {
      return err("Invalid session");
    }

    if (session.expiresAt <= now) {
      if (request) {
        const ctx = auditContext(request);
        void logAudit({
          accountId: session.user.accountId,
          userId: session.userId,
          action: "auth.session.expired",
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          severity: "info",
          outcome: "failure",
        });
      }
      await prisma.session.delete({ where: { id: session.id } }).catch((e: unknown) => logger.warn("validateSession: DB delete failed (expiry)", { error: e instanceof Error ? e.message : String(e) }));
      return err("Session expired");
    }

    const idleCutoff = new Date(nowMs - idleTimeoutMs);
    const lastActive = session.lastActiveAt ?? session.createdAt;
    if (lastActive < idleCutoff) {
      if (request) {
        const ctx = auditContext(request);
        void logAudit({
          accountId: session.user.accountId,
          userId: session.userId,
          action: "auth.session.idle_timeout",
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          severity: "info",
          outcome: "failure",
        });
      }
      await prisma.session.delete({ where: { id: session.id } }).catch((e: unknown) => logger.warn("validateSession: DB delete failed (idle)", { error: e instanceof Error ? e.message : String(e) }));
      return err("Session expired");
    }

    if (session.fingerprint != null && request != null) {
      const currentFingerprint = fingerprintFromRequest(request);
      if (currentFingerprint == null || currentFingerprint !== session.fingerprint) {
        const ctx = auditContext(request);
        reportSecurityEvent({
          type: "session_hijack",
          userId: session.userId,
          accountId: session.user.accountId,
          ipAddress: ctx.ipAddress,
          details: "Session fingerprint mismatch (User-Agent)",
        });
        return err("Invalid session");
      }
    }

    const ACTIVE_UPDATE_INTERVAL_MS = 60_000;
    const lastActiveTs = session.lastActiveAt ?? session.createdAt;
    const shouldUpdate = nowMs - lastActiveTs.getTime() > ACTIVE_UPDATE_INTERVAL_MS;
    if (shouldUpdate) {
      // Wrap in its own try/catch so a DB write failure does not deny a valid session.
      await prisma.session.update({
        where: { id: session.id },
        data: { lastActiveAt: now },
      }).catch((e: unknown) => {
        logger.warn("Failed to update session lastActiveAt", {
          sessionId: session.id,
          error: e instanceof Error ? e.message : String(e),
        });
      });
    }

    const role = (["owner", "admin", "manager", "member", "viewer"].includes(session.user.role)
      ? session.user.role
      : "member") as SessionRole;
    const erpnextSid = session.erpnextSid
      ? (() => {
          try {
            return decrypt(session.erpnextSid!);
          } catch (decryptErr) {
            logger.warn("ERPNext SID decryption failed — user will need to re-authenticate with ERPNext", {
              sessionId: session.id,
              userId: session.userId,
              error: decryptErr instanceof Error ? decryptErr.message : String(decryptErr),
            });
            return undefined;
          }
        })()
      : undefined;
    const result = { userId: session.userId, accountId: session.user.accountId, role, erpnextSid };

    // Cache the result with all security fields so the cache path can fully validate.
    if (redis) {
      const cached: CachedSession = {
        ...result,
        // Encrypt SID before caching — never store plaintext credentials in Redis
        erpnextSid: result.erpnextSid ? encrypt(result.erpnextSid) : null,
        expiresAt: session.expiresAt.getTime(),
        lastActiveAt: (shouldUpdate ? now : lastActiveTs).getTime(),
        fingerprint: session.fingerprint ?? null,
      };
      redis.set(cacheKey, JSON.stringify(cached), "EX", SESSION_CACHE_TTL_SEC).catch((e: unknown) => logger.error("validateSession: Redis cache write failed", { error: e instanceof Error ? e.message : String(e) }));
    }

    return ok(result);
  } catch (e) {
    return err(e instanceof Error ? e.message : "Session validation failed");
  }
}

export async function deleteExpiredSessions(): Promise<void> {
  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch((e: unknown) => logger.error("deleteExpiredSessions: DB delete failed", { error: e instanceof Error ? e.message : String(e) }));
}

/**
 * Revoke a session by token (e.g. on logout).
 * Pass audit context to emit a structured audit log entry for the revocation.
 */
export async function revokeSession(
  token: string,
  audit?: { userId: string; accountId: string; reason?: string; request?: Request }
): Promise<Result<{ revoked: boolean }, string>> {
  if (!token?.trim()) return ok({ revoked: false });
  const tokenHash = hashToken(token);
  try {
    const deleted = await prisma.session.deleteMany({ where: { token: tokenHash } });
    const cacheKey = `${SESSION_CACHE_PREFIX}${tokenHash}`;
    getRedis()?.del(cacheKey).catch((e: unknown) => logger.error("revokeSession: Redis del failed", { error: e instanceof Error ? e.message : String(e) }));
    if (audit && deleted.count > 0) {
      const ctx = audit.request ? auditContext(audit.request) : { ipAddress: null, userAgent: null };
      void logAudit({
        accountId: audit.accountId,
        userId: audit.userId,
        action: "auth.session.revoked",
        metadata: { reason: audit.reason ?? "logout" },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        severity: "info",
        outcome: "success",
      });
    }
    return ok({ revoked: deleted.count > 0 });
  } catch {
    return ok({ revoked: false });
  }
}

/**
 * Revoke all sessions for a user (e.g. password change, security action).
 * Immediately flushes all Redis cache entries for this user via the session
 * user index, so revoked sessions cannot authenticate during the 5s cache TTL.
 */
export async function revokeAllUserSessions(userId: string): Promise<Result<{ count: number }, string>> {
  try {
    const result = await prisma.session.deleteMany({ where: { userId } });

    // Flush all Redis cache entries for this user immediately.
    const redis = getRedis();
    if (redis) {
      const indexKey = `${SESSION_USER_INDEX_PREFIX}${userId}`;
      try {
        const cacheKeys = await redis.smembers(indexKey);
        if (cacheKeys.length > 0) {
          const pipeline = redis.pipeline();
          for (const key of cacheKeys) pipeline.del(key);
          pipeline.del(indexKey);
          await pipeline.exec();
        } else {
          await redis.del(indexKey).catch((e: unknown) => logger.error("revokeAllUserSessions: Redis del indexKey failed", { userId, error: e instanceof Error ? e.message : String(e) }));
        }
      } catch {
        // Non-fatal: DB sessions are already deleted. Cache entries will expire.
        logger.warn("revokeAllUserSessions: failed to flush Redis cache", { userId });
      }
    }

    return ok({ count: result.count });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Failed to revoke sessions");
  }
}
