/**
 * Event emitter tests — verify the emitter:
 *   1. Persists events to cortex_events
 *   2. Queues a process-event job on success
 *   3. Returns the trace id (generated if not supplied)
 *   4. Never throws on persistence failure
 *   5. Returns queued=false but eventId=set when only the queue fails
 *   6. Sets priority correctly per source
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    cortexEvent: {
      create: vi.fn(),
    },
  },
}));

vi.mock("../../lib/jobs/queue.js", () => ({
  cortexQueue: {
    add: vi.fn(),
  },
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { emitEvent } from "../emitter.js";
import { prisma } from "../../lib/data/prisma.js";
import { cortexQueue } from "../../lib/jobs/queue.js";

describe("emitEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists the event and queues the job on the happy path", async () => {
    (prisma.cortexEvent.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "evt_1" });
    (cortexQueue.add as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const result = await emitEvent({
      accountId: "acc_1",
      type: "invoice.created",
      source: "user.action",
      data: { invoiceId: "INV-001" },
      userId: "usr_1",
    });

    expect(result.eventId).toBe("evt_1");
    expect(result.traceId).toBeDefined();
    expect(result.queued).toBe(true);
    expect(prisma.cortexEvent.create).toHaveBeenCalledOnce();
    expect(cortexQueue.add).toHaveBeenCalledOnce();
  });

  it("uses the supplied trace id when provided", async () => {
    (prisma.cortexEvent.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "evt_2" });
    (cortexQueue.add as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const result = await emitEvent({
      accountId: "acc_1",
      type: "payment.received",
      source: "api.webhook",
      data: {},
      traceId: "trace_passed_in",
    });

    expect(result.traceId).toBe("trace_passed_in");
  });

  it("generates a fresh trace id when none is supplied", async () => {
    (prisma.cortexEvent.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "evt_3" });
    (cortexQueue.add as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const result = await emitEvent({
      accountId: "acc_1",
      type: "test.event",
      source: "system.cron",
      data: {},
    });

    // UUID v4 shape
    expect(result.traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("returns queued=false when the queue throws but persistence succeeds", async () => {
    (prisma.cortexEvent.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "evt_4" });
    (cortexQueue.add as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Redis down"));

    const result = await emitEvent({
      accountId: "acc_1",
      type: "test.event",
      source: "user.action",
      data: {},
    });

    expect(result.eventId).toBe("evt_4");
    expect(result.queued).toBe(false);
  });

  it("returns eventId=empty + queued=false when persistence throws (never re-throws)", async () => {
    (prisma.cortexEvent.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));

    const result = await emitEvent({
      accountId: "acc_1",
      type: "test.event",
      source: "user.action",
      data: {},
    });

    expect(result.eventId).toBe("");
    expect(result.queued).toBe(false);
    // Job should NOT be added because the event was never persisted
    expect(cortexQueue.add).not.toHaveBeenCalled();
  });

  it("assigns lower priority numbers to user actions than system cron", async () => {
    (prisma.cortexEvent.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "evt_5" });
    (cortexQueue.add as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await emitEvent({ accountId: "a", type: "x", source: "user.action", data: {} });
    await emitEvent({ accountId: "a", type: "x", source: "system.cron", data: {} });

    const calls = (cortexQueue.add as ReturnType<typeof vi.fn>).mock.calls;
    const userActionPriority = (calls[0]?.[2] as { priority: number }).priority;
    const cronPriority = (calls[1]?.[2] as { priority: number }).priority;
    expect(userActionPriority).toBeLessThan(cronPriority);
  });
});
