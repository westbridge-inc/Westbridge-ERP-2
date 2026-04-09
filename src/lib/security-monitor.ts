import { logger } from "./logger.js";
import * as Sentry from "@sentry/node";

export type SecurityEventType =
  | "brute_force"
  | "session_hijack"
  | "csrf_attack"
  | "unauthorized_access"
  // tenant_mismatch: a worker job's accountId did not match the persisted
  // row's accountId. Indicates queue poisoning, replay, or a race against
  // a recycled identifier. Always pages on-call.
  | "tenant_mismatch";

export interface SecurityEvent {
  type: SecurityEventType;
  userId?: string;
  accountId?: string;
  ipAddress?: string;
  details: string;
  /** Optional structured payload (request id, mismatched ids, etc.). */
  metadata?: Record<string, unknown>;
}

export function reportSecurityEvent(event: SecurityEvent): void {
  logger.error("security_event", {
    type: event.type,
    userId: event.userId,
    accountId: event.accountId,
    ipAddress: event.ipAddress,
    details: event.details,
    metadata: event.metadata,
    timestamp: new Date().toISOString(),
  });

  Sentry.captureMessage(`Security Event: ${event.type}`, {
    level: "error",
    tags: { security_event: event.type },
    extra: {
      userId: event.userId,
      accountId: event.accountId,
      ipAddress: event.ipAddress,
      details: event.details,
      metadata: event.metadata,
    },
  });
}
