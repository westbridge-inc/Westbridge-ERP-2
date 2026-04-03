/**
 * BullMQ job queues.
 * All async work goes through these queues so it can be retried, monitored, and prioritised.
 *
 * Queue workers are started in a separate process (workers/index.ts).
 * Next.js API routes only ADD jobs to the queue; they never run the work inline.
 */
import { Queue, type ConnectionOptions } from "bullmq";
import { getRedisConfig } from "../redis.js";

const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";
if (
  process.env.NODE_ENV === "production" &&
  !isBuildPhase &&
  !process.env.REDIS_PASSWORD
) {
  throw new Error("REDIS_PASSWORD is required in production");
}

const redisConfig = getRedisConfig();
const connection: ConnectionOptions = {
  host: redisConfig.host,
  port: redisConfig.port,
  password: redisConfig.password ?? process.env.REDIS_PASSWORD,
};

// Future: consider @bull-board/api behind /admin/queues for queue visibility.
// For now failed jobs are inspectable in Redis directly.

const DEFAULT_OPTIONS = {
  defaultJobOptions: {
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
  connection,
};

// ─── Queue definitions ────────────────────────────────────────────────────────

/** Transactional emails — invite, password reset, account activated. */
export const emailQueue = new Queue("email", DEFAULT_OPTIONS);

/** ERPNext document sync — per-document or full reconciliation. */
export const erpSyncQueue = new Queue("erp-sync", {
  ...DEFAULT_OPTIONS,
  defaultJobOptions: {
    ...DEFAULT_OPTIONS.defaultJobOptions,
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  },
});

/** Async report generation for large datasets. */
export const reportsQueue = new Queue("reports", {
  ...DEFAULT_OPTIONS,
  defaultJobOptions: {
    ...DEFAULT_OPTIONS.defaultJobOptions,
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  },
});

/** Scheduled cleanup tasks (sessions, audit logs). */
export const cleanupQueue = new Queue("cleanup", DEFAULT_OPTIONS);

/** Incoming webhook processing with retry. */
export const webhooksQueue = new Queue("webhooks", {
  ...DEFAULT_OPTIONS,
  defaultJobOptions: {
    ...DEFAULT_OPTIONS.defaultJobOptions,
    attempts: 5,
    backoff: { type: "exponential", delay: 60_000 },
  },
});

// ─── Job type payloads ────────────────────────────────────────────────────────

export interface EmailJobData {
  to: string;
  subject: string;
  html: string;
  from?: string;
}

export interface ErpSyncJobData {
  accountId: string;
  doctype: string;
  name: string;
  erpnextSessionId: string;
}

export interface ReportJobData {
  accountId: string;
  reportType: string;
  params: Record<string, unknown>;
  requestedBy: string;
}

export interface CleanupJobData {
  task: "sessions" | "audit_logs";
}

export interface WebhookJobData {
  endpointId: string;
  event: string;
  payload: Record<string, unknown>;
  deliveryId: string;
}

// ─── Queue helpers ────────────────────────────────────────────────────────────

/** Add an email job to the queue (preferred over sending inline). */
export async function enqueueEmail(data: EmailJobData): Promise<void> {
  // Guard against runaway queue growth: if the email queue is already deeply
  // backlogged, reject rather than making the backlog worse. The threshold of
  // 10,000 gives meaningful headroom while still protecting Redis memory.
  const MAX_EMAIL_QUEUE_DEPTH = 10_000;
  const waiting = await emailQueue.getWaitingCount();
  if (waiting > MAX_EMAIL_QUEUE_DEPTH) {
    const { logger } = await import("../logger.js");
    logger.error("enqueueEmail: queue depth exceeded — rejecting new job", {
      waiting, limit: MAX_EMAIL_QUEUE_DEPTH,
    });
    throw new Error("Email service temporarily unavailable — queue capacity reached");
  }
  await emailQueue.add("send", data, {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
  });
}

/** Add a report generation job to the queue. Returns the job ID for status polling. */
export async function enqueueReport(data: ReportJobData): Promise<string> {
  const MAX_REPORT_QUEUE_DEPTH = 500;
  const waiting = await reportsQueue.getWaitingCount();
  if (waiting > MAX_REPORT_QUEUE_DEPTH) {
    const { logger } = await import("../logger.js");
    logger.error("enqueueReport: queue depth exceeded — rejecting new job", {
      waiting, limit: MAX_REPORT_QUEUE_DEPTH,
    });
    throw new Error("Report service temporarily unavailable — queue capacity reached");
  }
  const job = await reportsQueue.add(`report.${data.reportType}`, data);
  return job.id ?? crypto.randomUUID();
}

/** Schedule the hourly session cleanup job. */
export async function scheduleCleanupJobs(): Promise<void> {
  await cleanupQueue.add("cleanup.sessions", { task: "sessions" } satisfies CleanupJobData, {
    repeat: { every: 60 * 60 * 1000 }, // hourly
  });
  await cleanupQueue.add("cleanup.audit_logs", { task: "audit_logs" } satisfies CleanupJobData, {
    repeat: { every: 24 * 60 * 60 * 1000 }, // daily
  });
}
