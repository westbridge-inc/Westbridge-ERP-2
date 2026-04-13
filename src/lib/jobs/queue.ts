/**
 * BullMQ job queues.
 * All async work goes through these queues so it can be retried, monitored, and prioritised.
 *
 * Queue workers are started in a separate process (workers/index.ts).
 * Next.js API routes only ADD jobs to the queue; they never run the work inline.
 */
import { Queue, type ConnectionOptions } from "bullmq";
import { getRedisConfig } from "../redis.js";

const redisConfig = getRedisConfig();

// Upstash Redis includes credentials in the URL (parsed by getRedisConfig).
// REDIS_PASSWORD env var is only needed when using bare host/port config.
if (process.env.NODE_ENV === "production" && !redisConfig.password && !process.env.REDIS_PASSWORD) {
  throw new Error("Redis password is required in production (set REDIS_PASSWORD or include in REDIS_URL)");
}

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

/**
 * Cortex event processing queue. Every emitted event lands here so the
 * orchestrator can wake up, look at the event type, and dispatch to the
 * right specialist agent. v1.0 ships the queue + emitter; v2.0 adds
 * the worker that drains it.
 */
export const cortexQueue = new Queue("cortex", {
  ...DEFAULT_OPTIONS,
  defaultJobOptions: {
    ...DEFAULT_OPTIONS.defaultJobOptions,
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
  },
});

/**
 * Account provisioning queue .
 *
 * Owns the work that used to run as fire-and-forget dynamic imports from
 * billing.service.createAccount: ERPNext company + user creation, and
 * subscription record creation. Putting these on a real queue means:
 *
 *   1. The work survives a process restart mid-flight (not the case
 *      with `void import.then.catch`).
 *   2. Retries are managed by BullMQ with proper exponential backoff and
 *      attempt counting that survives restart.
 *   3. Failures land in the BullMQ dead-letter queue and can be
 *      inspected via the queue admin tooling, instead of disappearing
 *      into a Sentry breadcrumb.
 *
 * Five attempts × 5s exponential backoff gives a worst-case retry tail of
 * about 10 minutes — long enough for most ERPNext hiccups to clear, short
 * enough that the customer notices "setup incomplete" and can contact
 * support if it really has failed.
 */
export const provisioningQueue = new Queue("provisioning", {
  ...DEFAULT_OPTIONS,
  defaultJobOptions: {
    ...DEFAULT_OPTIONS.defaultJobOptions,
    attempts: 5,
    backoff: { type: "exponential", delay: 5_000 },
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
  task:
    | "sessions"
    | "audit_logs"
    | "check-trial-expiry"
    | "check-grace-period"
    | "send-trial-warnings"
    | "cleanup-expired-trials"
    // hard-delete accounts whose 30-day soft-delete grace period
    // has elapsed. Cascades through every child row via the FK relations
    // in schema.prisma; audit logs are anonymized in place beforehand.
    | "purge-deleted-accounts";
}

export interface WebhookJobData {
  endpointId: string;
  event: string;
  payload: Record<string, unknown>;
  deliveryId: string;
}

/**
 * Cortex event payload — minimal pointer back to the persisted event row.
 * The worker pulls the full row from the DB rather than re-serialising the
 * data here so the queue stays small.
 */
export interface CortexEventJobData {
  eventId: string;
  accountId: string;
  type: string;
  traceId: string;
}

/**
 * Provisioning job payload . Discriminated by `task` so a single
 * worker can handle both ERPNext setup and subscription-record creation
 * for a fresh signup.
 */
export type ProvisioningJobData =
  | { task: "erpnext"; accountId: string }
  | { task: "subscription"; accountId: string; plan: string };

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
      waiting,
      limit: MAX_EMAIL_QUEUE_DEPTH,
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
      waiting,
      limit: MAX_REPORT_QUEUE_DEPTH,
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

  // Trial system jobs
  await cleanupQueue.add("check-trial-expiry", { task: "check-trial-expiry" } satisfies CleanupJobData, {
    repeat: { every: 60 * 60 * 1000 }, // hourly
  });
  await cleanupQueue.add("check-grace-period", { task: "check-grace-period" } satisfies CleanupJobData, {
    repeat: { every: 60 * 60 * 1000 }, // hourly
  });
  await cleanupQueue.add("send-trial-warnings", { task: "send-trial-warnings" } satisfies CleanupJobData, {
    repeat: { every: 24 * 60 * 60 * 1000 }, // daily at midnight
  });
  await cleanupQueue.add("cleanup-expired-trials", { task: "cleanup-expired-trials" } satisfies CleanupJobData, {
    repeat: { every: 7 * 24 * 60 * 60 * 1000 }, // weekly
  });

  // Daily account purge worker. Hard-deletes accounts whose 30-day
  // soft-delete grace period has elapsed. The Privacy Policy promises
  // production purge within 30 days, so this MUST run at least daily.
  await cleanupQueue.add(
    "purge-deleted-accounts",
    { task: "purge-deleted-accounts" } satisfies CleanupJobData,
    { repeat: { every: 24 * 60 * 60 * 1000 } }, // daily
  );
}

/**
 * Enqueue an ERPNext provisioning job for a newly-created account .
 *
 * Replaces the previous `void import("./provisioning.service.js").then(...)`
 * fire-and-forget pattern in billing.service. The work now survives a
 * process restart and gets BullMQ-managed retries instead of an in-memory
 * `for` loop that gets killed on shutdown.
 *
 * Caller is signup / Paddle webhook handler. Both are unauthenticated
 * cross-tenant entry points; do NOT add any tenant pinning here.
 */
export async function enqueueProvisioning(accountId: string): Promise<void> {
  await provisioningQueue.add("erpnext", { task: "erpnext", accountId } satisfies ProvisioningJobData, {
    jobId: `provisioning:erpnext:${accountId}`, // de-dupe — multiple webhook deliveries shouldn't double-provision
  });
}

/**
 * Enqueue a subscription record creation job for a newly-paid account .
 *
 * Same justification as enqueueProvisioning — replaces a fire-and-forget
 * dynamic import that wouldn't survive a restart.
 */
export async function enqueueSubscriptionCreate(accountId: string, plan: string): Promise<void> {
  await provisioningQueue.add("subscription", { task: "subscription", accountId, plan } satisfies ProvisioningJobData, {
    jobId: `provisioning:subscription:${accountId}`, // de-dupe
  });
}
