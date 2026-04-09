/**
 * Cortex event processor — drains the cortex BullMQ queue.
 *
 * For each queued event:
 *   1. Load the full row from cortex_events (the queue payload only carries
 *      the id + accountId so the queue stays small).
 *   2. Dispatch via the eventTypeDispatch table to the correct specialised
 *      agent. Phase 4 ships the dispatch table empty — Phase 6 (Specialized
 *      Agents) populates it. Until then every event flows in, gets logged,
 *      and is marked processed without triggering an agent run.
 *   3. Mark the event as processed = true with a `processedBy` tag and the
 *      execution result (or "no_handler" / "error").
 *
 * This module never throws — errors are caught + logged + recorded on the
 * event row so the worker keeps draining the queue. A poison-pill event
 * cannot wedge the system.
 */

import { prisma } from "../lib/data/prisma.js";
import { logger } from "../lib/logger.js";
import type { CortexEventJobData } from "../lib/jobs/queue.js";
import { anthropic } from "../lib/ai/claude.js";
import { executeAgent } from "../cortex/engine.js";
import { getAgent } from "../cortex/registry.js";
import { defaultUsageGate } from "../cortex/usage-gate.js";
import { randomUUID } from "crypto";

/**
 * Result of processing one event. Used by the worker to log and by the
 * test suite to assert behavior.
 */
export interface ProcessEventResult {
  status: "processed" | "no_handler" | "missing" | "already_processed" | "error";
  agentId?: string;
  error?: string;
}

/**
 * Dispatch table — event type → agent id. Empty in Phase 4. Phase 6
 * populates this with the specialised agents (router, extraction, finance,
 * etc). Kept as a Map so an agent can register itself at module load.
 */
const eventTypeDispatch = new Map<string, string>();

/** Register a specialised agent for an event type. Called from agent module imports. */
export function registerEventHandler(eventType: string, agentId: string): void {
  if (eventTypeDispatch.has(eventType)) {
    logger.warn("cortex.processor: overwriting existing event handler", {
      eventType,
      existing: eventTypeDispatch.get(eventType),
      incoming: agentId,
    });
  }
  eventTypeDispatch.set(eventType, agentId);
}

/** Look up the registered agent for an event type. Tests + the router use this. */
export function lookupEventHandler(eventType: string): string | undefined {
  return eventTypeDispatch.get(eventType);
}

/** @internal — exposed only for unit tests. */
export function _resetDispatchForTests(): void {
  eventTypeDispatch.clear();
}

/**
 * Process a single Cortex event. Always returns; never throws. The worker
 * relies on this contract — a thrown error would put the job into BullMQ's
 * failed state and trigger retries, which is wrong for events that are
 * idempotently marked processed in the DB.
 */
export async function processCortexEvent(jobData: CortexEventJobData): Promise<ProcessEventResult> {
  const { eventId, accountId, type, traceId } = jobData;

  // ── 1. Load the full row ───────────────────────────────────────────────
  const event = await prisma.cortexEvent.findUnique({ where: { id: eventId } });

  if (!event) {
    logger.warn("cortex.processor: event not found", { eventId, accountId, type, traceId });
    return { status: "missing" };
  }

  // Idempotency: if some other worker already handled this event, drop it
  // silently. BullMQ's at-least-once delivery means we can see duplicates.
  if (event.processed) {
    return { status: "already_processed" };
  }

  // ── 2. Dispatch ────────────────────────────────────────────────────────
  const agentId = eventTypeDispatch.get(type);

  if (!agentId) {
    // No registered handler — Phase 4 ships with an empty dispatch table,
    // so this is the expected path until Phase 6 wires up specialists.
    // We still mark the event processed so it does not get re-queued.
    await markProcessed(eventId, "no_handler", { reason: "No agent registered for this event type" });
    return { status: "no_handler" };
  }

  // ── 3. Run the agent (Phase 6) ─────────────────────────────────────────
  // Resolve the agent definition from the registry. If the dispatch table
  // points at an unknown id (mis-registration, deploy skew), fall through
  // to the no_handler branch rather than crashing the worker.
  const agent = getAgent(agentId);
  if (!agent) {
    logger.warn("cortex.processor: dispatch table points at unregistered agent", {
      eventId,
      eventType: type,
      agentId,
    });
    await markProcessed(eventId, "no_handler", { reason: `Agent ${agentId} is not registered` });
    return { status: "no_handler" };
  }

  if (!anthropic) {
    // ANTHROPIC_API_KEY missing — mark processed with an error so the event
    // is not re-queued, and let ops fix the deploy. We don't fail the job
    // because retries will not help.
    await markProcessed(eventId, agentId, { error: "ANTHROPIC_API_KEY not configured" });
    return { status: "error", agentId, error: "ANTHROPIC_API_KEY not configured" };
  }

  // Build the message that triggers the specialist. We hand the event
  // payload as a JSON-formatted user turn so the agent can inspect the full
  // structured data without us needing to know which fields it cares about.
  const triggerMessage = JSON.stringify({
    eventType: event.eventType,
    source: event.source,
    triggeredAt: event.createdAt,
    data: event.data,
  });

  try {
    const result = await executeAgent({
      client: anthropic,
      agent,
      messages: [{ role: "user", content: triggerMessage }],
      ctx: {
        accountId,
        userId: event.userId,
        agentId: agent.id,
        traceId: traceId ?? randomUUID(),
        autonomyLevel: agent.autonomyLevel,
        // Event-driven runs do not have an active session, so the ERPNext
        // bridging context falls back to the per-account API key auth path
        // that erpnext.client.ts already handles.
        erpnextCompany: null,
        erpnextSid: null,
        prisma,
      },
      usageGate: defaultUsageGate,
    });

    // Persist the execution log row so the activity feed shows this run.
    // Best-effort: a failure here is logged but doesn't requeue the job.
    await persistExecutionLog(accountId, agent.id, traceId ?? "", eventId, result).catch((err) =>
      logger.warn("cortex.processor: persistExecutionLog failed", {
        eventId,
        agentId: agent.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    await markProcessed(eventId, agent.id, {
      status: result.status,
      output: result.output.slice(0, 2_000),
      iterations: result.iterations,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
    });

    return { status: "processed", agentId: agent.id };
  } catch (err) {
    // executeAgent shouldn't throw — it returns a CortexExecutionResult on
    // any error path. But if it does, we still want to mark the event
    // processed (with the error captured) so the job doesn't loop forever.
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error("cortex.processor: executeAgent threw unexpectedly", {
      eventId,
      agentId: agent.id,
      error: errorMessage,
    });
    await markProcessed(eventId, agent.id, { error: errorMessage });
    return { status: "error", agentId: agent.id, error: errorMessage };
  }
}

/**
 * Persist a CortexExecutionLog row for an event-driven agent run. Mirrors
 * the shape the chat route writes so the activity feed can render both
 * sources uniformly.
 */
async function persistExecutionLog(
  accountId: string,
  agentId: string,
  traceId: string,
  triggerEventId: string,
  result: import("../cortex/protocol.js").CortexExecutionResult,
): Promise<void> {
  await prisma.cortexExecutionLog.create({
    data: {
      accountId,
      agentId,
      traceId,
      triggerEventId,
      status: result.status,
      model: "", // The engine doesn't expose the resolved model name; future improvement.
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      iterations: result.iterations,
      toolCallCount: result.toolCalls.length,
      toolCallErrors: result.toolCalls.filter((c) => !c.success).length,
      output: result.output.slice(0, 8_000),
      errorMessage: result.errorMessage ?? null,
    },
  });
}

async function markProcessed(eventId: string, processedBy: string, result: Record<string, unknown>): Promise<void> {
  try {
    await prisma.cortexEvent.update({
      where: { id: eventId },
      data: {
        processed: true,
        processedAt: new Date(),
        processedBy,
        result,
      },
    });
  } catch (err) {
    // Even the markProcessed call is non-fatal — if the DB write fails the
    // event will get re-queued by BullMQ and we'll try again. Log so ops
    // can see the loop.
    logger.error("cortex.processor: markProcessed failed", {
      eventId,
      processedBy,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
