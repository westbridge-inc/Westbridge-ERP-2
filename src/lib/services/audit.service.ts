import { prisma } from "../data/prisma.js";
import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import { logger } from "../logger.js";

export type AuditSeverity = "info" | "warn" | "critical";
export type AuditOutcome = "success" | "failure" | "error";

interface AuditEntry {
  accountId: string | null;
  userId?: string;
  action: string;
  resource?: string;
  resourceId?: string;
  sessionId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** JSON diff of before/after for mutations. */
  changes?: { before?: Record<string, unknown>; after?: Record<string, unknown> };
  /** Additional key/value metadata. */
  meta?: Record<string, unknown>;
  /** @deprecated use meta */
  metadata?: Record<string, unknown>;
  severity?: AuditSeverity;
  outcome?: AuditOutcome;
}

/** Redis key for the most recent audit log hash (for hash chain). */
const PREV_HASH_KEY = (accountId: string) => `audit:prevhash:${accountId}`;

async function getPrevHash(accountId: string): Promise<string> {
  try {
    const { getRedis } = await import("../redis.js");
    const redis = getRedis();
    return (await redis?.get(PREV_HASH_KEY(accountId))) ?? "GENESIS";
  } catch {
    return "GENESIS";
  }
}

async function setPrevHash(accountId: string, hash: string): Promise<void> {
  try {
    const { getRedis } = await import("../redis.js");
    const redis = getRedis();
    await redis?.set(PREV_HASH_KEY(accountId), hash, "EX", 30 * 24 * 60 * 60);
  } catch { /* non-critical */ }
}

const SENSITIVE_KEY_REGEX = /password|secret|token|key|credit|ssn/i;

/** Redact sensitive keys in metadata to avoid storing PII. */
function sanitizeMetadata(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_KEY_REGEX.test(k) ? "[REDACTED]" : v;
  }
  return out;
}

/** Derive a rough geo-location country code from IP (no external calls). */
function geoFromIp(ip: string | null | undefined): string | null {
  // Real implementation uses a local GeoIP database (e.g. geoip-lite).
  // Placeholder: return null until the package is added.
  if (!ip) return null;
  return null;
}

export async function logAudit(entry: AuditEntry): Promise<void> {
  // System events (no accountId) are only logged structurally — no DB write since accountId is required
  if (!entry.accountId) {
    logger.info("audit.system_event", {
      action: entry.action,
      severity: entry.severity ?? "info",
      outcome: entry.outcome ?? "success",
      ipAddress: entry.ipAddress,
      ...(entry.meta ?? entry.metadata ?? {}),
    });
    return;
  }
  try {
    const accountId = entry.accountId;
    const rawMeta = { ...(entry.metadata ?? {}), ...(entry.meta ?? {}) };
    const meta = sanitizeMetadata(rawMeta as Record<string, unknown>);
    const ipRedacted = typeof entry.ipAddress === "string"
      ? entry.ipAddress.replace(/\.\d+$/, ".0")
      : (entry.ipAddress ?? null);
    const userAgentHashed = typeof entry.userAgent === "string"
      ? createHash("sha256").update(entry.userAgent).digest("hex").slice(0, 16)
      : (entry.userAgent ?? null);
    const geo = geoFromIp(entry.ipAddress);
    const prevHash = await getPrevHash(accountId);

    const payload = JSON.stringify({
      accountId,
      action: entry.action,
      timestamp: new Date().toISOString(),
      prevHash,
    });
    const entryHash = createHash("sha256").update(payload).digest("hex");

    await prisma.auditLog.create({
      data: {
        accountId,
        userId: entry.userId,
        action: entry.action,
        resource: entry.resource,
        resourceId: entry.resourceId,
        ipAddress: ipRedacted,
        userAgent: userAgentHashed,
        metadata: ({
          ...meta,
          ...(entry.changes ? { changes: entry.changes } : {}),
          ...(geo ? { geo } : {}),
          ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
          _hash: entryHash,
          _prevHash: prevHash,
        } as Prisma.InputJsonValue),
        severity: entry.severity ?? "info",
        outcome: entry.outcome ?? "success",
      },
    });

    await setPrevHash(accountId, entryHash);
  } catch (err) {
    logger.error("audit_log_write_failed", {
      action: entry.action,
      error: err instanceof Error ? err.message : "unknown",
    });
  }
}

/** Helper to extract request context for audit entries. */
export function auditContext(request: Request): { ipAddress: string; userAgent: string } {
  return {
    ipAddress:
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip") ??
      "unknown",
    userAgent: request.headers.get("user-agent") ?? "unknown",
  };
}

/**
 * Fire-and-forget audit log with error visibility.
 *
 * Use this instead of `void logAudit(...)` so that failures are always
 * logged and metered — never silently swallowed.
 *
 * @example
 * void safeLogAudit({ accountId, action: "auth.login.success", ... });
 */
export function safeLogAudit(entry: Parameters<typeof logAudit>[0]): void {
  logAudit(entry).catch((e) => {
    logger.error("safeLogAudit: audit write failed", {
      action: entry.action,
      error: e instanceof Error ? e.message : String(e),
    });
  });
}

// ---------------------------------------------------------------------------
// CSV export helpers (extracted from audit.routes.ts)
// ---------------------------------------------------------------------------

export interface AuditRow {
  timestamp: Date;
  action: string;
  userId: string | null;
  ipAddress: string | null;
  severity: string;
  outcome: string;
  resource: string | null;
  resourceId: string | null;
  metadata: unknown;
}

/** CSV header row matching the export spec. */
export const CSV_HEADER =
  "timestamp,action,userId,ipAddress,severity,outcome,resource,resourceId,metadata\n";

/** Convert a single audit log row to RFC 4180 CSV. */
export function rowToCsv(row: AuditRow): string {
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [
    esc(row.timestamp.toISOString()),
    esc(row.action),
    esc(row.userId),
    esc(row.ipAddress),
    esc(row.severity),
    esc(row.outcome),
    esc(row.resource),
    esc(row.resourceId),
    esc(row.metadata ? JSON.stringify(row.metadata) : ""),
  ].join(",") + "\n";
}
