/**
 * Event emitter — the seam between existing business logic and the Cortex.
 *
 * Every meaningful state change in the application calls `emitEvent`. The
 * emitter does two things atomically (from the caller's perspective):
 *
 *   1. Writes a row to `cortex_events` so the activity log captures the
 *      event regardless of whether the queue is healthy.
 *   2. Adds a `process-event` job to the cortex BullMQ queue so a worker
 *      can wake the orchestrator and route the event to the right agent.
 *
 * If the queue is down (Redis offline, queue disabled), step 1 still
 * succeeds — the event is in the DB and a backfill worker can replay it
 * later. We never block a user-facing mutation on event emission, so all
 * errors are caught + logged, never thrown.
 *
 * Tenant isolation: every event MUST include an accountId. The DB foreign
 * key enforces this; the function signature surfaces it as a required
 * parameter so callers can't forget.
 *
 * v1.0 scope: the emitter is wired up but the orchestrator + cortex
 * worker are not yet running, so events flow into the table for the
 * activity log without triggering any agent runs. v2.0 adds the worker
 * + router and turns the events into agent invocations.
 */

import { randomUUID } from "crypto";
import { prisma } from "../lib/data/prisma.js";
import { logger } from "../lib/logger.js";
import { cortexQueue } from "../lib/jobs/queue.js";

export interface EmitEventParams {
  /** The tenant boundary. Required. Foreign key into accounts. */
  accountId: string;
  /**
   * Event type — dot-namespaced. e.g. "invoice.created", "payment.received",
   * "document.uploaded". Use a stable verb-after-noun shape so the router
   * can pattern-match easily.
   */
  type: string;
  /** Where the event came from. */
  source: "user.action" | "api.webhook" | "email.inbound" | "agent.action" | "system.cron";
  /** Arbitrary JSON payload. Tools or agents that handle this event will inspect it. */
  data: Record<string, unknown>;
  /** The user that triggered the event, if any. Null for cron / system events. */
  userId?: string;
  /** The agent that triggered the event, if any. Set for agent.action source. */
  agentId?: string;
  /** Trace correlation. If omitted, a fresh UUID is generated and returned. */
  traceId?: string;
}

export interface EmitEventResult {
  /** The persisted event id. */
  eventId: string;
  /** The trace id used (either passed in or freshly generated). */
  traceId: string;
  /** True if the event was successfully queued for processing. False if Redis was unavailable. */
  queued: boolean;
}

/**
 * Emit a Cortex event. Always returns; never throws. Failure to queue is
 * logged at warn level so it surfaces in monitoring without breaking the
 * caller's mutation.
 */
export async function emitEvent(params: EmitEventParams): Promise<EmitEventResult> {
  const traceId = params.traceId ?? randomUUID();

  // Step 1: persist to the immutable event log.
  let eventId: string;
  try {
    const row = await prisma.cortexEvent.create({
      data: {
        accountId: params.accountId,
        eventType: params.type,
        source: params.source,
        data: params.data,
        userId: params.userId,
        agentId: params.agentId,
        traceId,
        processed: false,
      },
      select: { id: true },
    });
    eventId = row.id;
  } catch (err) {
    // Persistence failure is the one error worth logging at error level —
    // it means the event was lost. Callers do not need to know; we never
    // re-throw because the originating mutation has already succeeded by
    // the time emitEvent runs.
    logger.error("Cortex emitEvent: failed to persist event", {
      accountId: params.accountId,
      type: params.type,
      source: params.source,
      traceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { eventId: "", traceId, queued: false };
  }

  // Step 2: queue for orchestrator processing. Best-effort — if BullMQ /
  // Redis is unavailable, the event sits in the DB and a backfill worker
  // can pick it up later via `cortex_events WHERE processed = false`.
  try {
    await cortexQueue.add(
      "process-event",
      {
        eventId,
        accountId: params.accountId,
        type: params.type,
        traceId,
      },
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        // Higher priority for human-initiated events vs cron-driven events
        // so the queue does not starve interactive flows behind batch work.
        priority: priorityFor(params.source),
      },
    );
    return { eventId, traceId, queued: true };
  } catch (err) {
    logger.warn("Cortex emitEvent: persisted event but failed to queue", {
      eventId,
      accountId: params.accountId,
      type: params.type,
      traceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { eventId, traceId, queued: false };
  }
}

/**
 * Map source → BullMQ priority. Lower numbers = higher priority. The
 * BullMQ default is 0 (highest); we keep user actions at 1 so a future
 * "critical" tier can pre-empt them.
 */
function priorityFor(source: EmitEventParams["source"]): number {
  switch (source) {
    case "user.action":
      return 1;
    case "api.webhook":
      return 2;
    case "email.inbound":
      return 3;
    case "agent.action":
      return 4;
    case "system.cron":
      return 5;
  }
}
