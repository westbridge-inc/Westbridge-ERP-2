/**
 * Cortex routes
 *
 * POST /cortex/chat — streaming chat with the Bridge AI conversation agent
 * GET  /cortex/conversations — list the user's persistent conversations
 * GET  /cortex/conversations/:id — fetch a single conversation's history
 * GET  /cortex/activity — recent execution log entries (audit trail)
 *
 * Phase 1 of the AI-Native ERP overhaul. These routes layer the Cortex on
 * top of the existing /api/ai/chat endpoint without breaking it. The legacy
 * route stays in place for the existing AIChatPanel widget; new clients use
 * /cortex/chat with a streaming SSE response.
 *
 * Key differences from /api/ai/chat:
 *   - Conversation history persisted in CortexConversation (not Redis-only)
 *   - Streaming SSE response with text chunks + tool-use events
 *   - Trace ID returned for activity log lookups
 *   - CortexExecutionLog row written for every run
 *   - Approval queue: large/destructive ops halt and queue a CortexApprovalRequest
 *
 * What is reused from the existing AI surface:
 *   - The Anthropic client + key handling from src/lib/ai/claude.ts
 *   - The 6 ERP tools from src/lib/ai/tools.ts (wrapped as Cortex tools)
 *   - The AI quota check from src/lib/ai/limits.ts
 *   - The auth + CSRF + rate limiting middleware
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import { anthropic } from "../lib/ai/claude.js";
import { validateSession } from "../lib/services/session.service.js";
import { checkTieredRateLimit, rateLimitHeaders } from "../lib/api/rate-limit-tiers.js";
import { validateCsrf, CSRF_COOKIE_NAME } from "../lib/csrf.js";
import { prisma } from "../lib/data/prisma.js";
import { COOKIE } from "../lib/constants.js";
import { toWebRequest, requireAuth, requireCsrf, runWithTenantContext } from "../middleware/auth.js";
import { apiSuccess, apiError } from "../types/api.js";
import { getPlan, type PlanId } from "../lib/modules.js";
import { logger } from "../lib/logger.js";
import { executeAgent } from "../cortex/engine.js";
import { defaultUsageGate } from "../cortex/usage-gate.js";
import { buildConversationAgent, buildConversationSystemPrompt } from "../cortex/agents/conversation.js";
// Side-effect import: registers every Cortex agent (router, extract.invoice,
// finance.{reconcile,journal,payment}, comms.notification) and wires their
// event handlers into the events processor dispatch table. Without this
// import the dispatch table is empty and the events worker does nothing.
import "../cortex/agents/index.js";
import type { CortexStoredMessage } from "../cortex/protocol.js";
import { emitEvent } from "../events/emitter.js";

const router = Router();

// ─── Schema ────────────────────────────────────────────────────────────────

const chatSchema = z.object({
  message: z.string().min(1).max(4_000),
  conversationId: z.string().cuid().optional(),
});

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Coerce the raw plan string from the DB into a known PlanId. */
function normalizePlan(rawPlan: string): PlanId {
  const lower = rawPlan.toLowerCase();
  if (lower === "enterprise") return "enterprise";
  if (lower === "business") return "business";
  if (lower === "starter") return "starter";
  return "starter";
}

/**
 * Cap the persisted message history to avoid unbounded row growth. Each
 * Anthropic.MessageParam can carry tool blocks so the JSON column would
 * grow fast otherwise. Older turns drop off the front; the system prompt
 * is rebuilt fresh per turn so context is not lost beyond raw history.
 */
const MAX_PERSISTED_TURNS = 30;
function capHistory(messages: CortexStoredMessage[]): CortexStoredMessage[] {
  if (messages.length <= MAX_PERSISTED_TURNS) return messages;
  return messages.slice(messages.length - MAX_PERSISTED_TURNS);
}

/** Convert stored history to the Anthropic SDK shape for replay. */
function toClaudeMessages(stored: CortexStoredMessage[]): Anthropic.MessageParam[] {
  return stored.map((m) => ({
    role: m.role,
    // The content shape was originally typed by Anthropic.MessageParam so
    // it's safe to pass through. We accept `unknown` in storage to keep
    // the protocol module SDK-free.
    content: m.content as Anthropic.MessageParam["content"],
  }));
}

/** Write SSE event helper. Express + node res supports this directly. */
function sseWrite(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ─── POST /cortex/chat ─────────────────────────────────────────────────────

router.post("/cortex/chat", async (req: Request, res: Response) => {
  // Defer-fail when the API key is missing so the route returns a clean
  // 503 instead of a TypeScript runtime error from the engine.
  if (!anthropic) {
    return res.status(503).json(apiError("AI_NOT_CONFIGURED", "Cortex is not available on this deployment yet."));
  }

  // ── Auth ──
  const token = req.cookies?.[COOKIE.SESSION_NAME];
  if (!token) {
    return res.status(401).json(apiError("UNAUTHORIZED", "Authentication required"));
  }

  // ── CSRF ──
  const csrfCookie = req.cookies[CSRF_COOKIE_NAME];
  const csrfHeader = (req.headers["x-csrf-token"] as string) ?? (req.headers["X-CSRF-Token"] as string);
  if (!validateCsrf(csrfHeader, csrfCookie)) {
    return res.status(403).json(apiError("FORBIDDEN", "Invalid or missing CSRF token"));
  }

  // ── Session validation ──
  const sessionResult = await validateSession(token, toWebRequest(req));
  if (!sessionResult.ok) {
    return res.status(401).json(apiError("UNAUTHORIZED", "Session expired or invalid"));
  }
  const session = sessionResult.data;

  // Phase 3: this handler bypasses requireAuth (it does manual session
  // validation because it streams via SSE), so the tenant context isn't
  // pinned automatically. Capture a non-null `ai` reference for the
  // closure (TS narrowing on `anthropic` doesn't survive the wrap), then
  // run the rest of the handler under the tenant pin so every prisma
  // call below is RLS-bound to session.accountId.
  const ai = anthropic;
  return runWithTenantContext(session.accountId, async () => {
    // ── Rate limit ──
    const rateLimit = await checkTieredRateLimit(session.userId, "authenticated", "/api/cortex/chat");
    if (!rateLimit.allowed) {
      return res
        .status(429)
        .set(rateLimitHeaders(rateLimit) as Record<string, string>)
        .json(apiError("RATE_LIMITED", "Too many AI requests. Try again shortly."));
    }

    // ── Parse body ──
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(apiError("INVALID_REQUEST", "message is required (max 4000 chars)"));
    }
    const { message, conversationId: requestedConvId } = parsed.data;

    // ── Account + plan ──
    const account = await prisma.account.findUnique({
      where: { id: session.accountId },
      select: { plan: true, companyName: true, erpnextCompany: true },
    });
    if (!account) {
      return res.status(404).json(apiError("NOT_FOUND", "Account not found"));
    }
    const planId = normalizePlan(account.plan);

    // Pre-check the AI quota BEFORE flushing SSE headers so we can return a
    // proper 402 status code on the wire (the SSE stream is always 200 once
    // headers flush). The engine ALSO runs this check via its usageGate as
    // defence-in-depth for autonomous code paths that bypass this route — the
    // double-check is a single Redis read so the cost is negligible.
    const limitCheck = await defaultUsageGate.checkLimit(session.accountId);
    if (!limitCheck.allowed) {
      return res
        .status(402)
        .json(apiError("AI_LIMIT_REACHED", limitCheck.reason ?? "AI usage limit reached for this billing period"));
    }

    // ── Load or create the persistent conversation ──
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { name: true },
    });

    let conversation;
    if (requestedConvId) {
      conversation = await prisma.cortexConversation.findFirst({
        where: { id: requestedConvId, accountId: session.accountId, userId: session.userId },
      });
    }
    if (!conversation) {
      conversation = await prisma.cortexConversation.create({
        data: {
          accountId: session.accountId,
          userId: session.userId,
          title: message.slice(0, 80),
          messages: [],
          lastAgentId: "conversation",
        },
      });
    }

    // ── Build the running message list ──
    const storedMessages = (conversation.messages as unknown as CortexStoredMessage[]) ?? [];
    const claudeHistory = toClaudeMessages(storedMessages);
    const newUserTurn: Anthropic.MessageParam = { role: "user", content: message };
    const runningMessages: Anthropic.MessageParam[] = [...claudeHistory, newUserTurn];

    // ── Build the per-call agent definition ──
    const systemPrompt = buildConversationSystemPrompt({
      companyName: account.companyName,
      planName: getPlan(planId).name,
      userName: user?.name ?? "User",
      userRole: session.role,
      currentDate: new Date().toISOString().slice(0, 10),
    });
    const agent = buildConversationAgent(systemPrompt);

    // ── Open the SSE stream ──
    const traceId = randomUUID();
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable nginx proxy buffering
    res.flushHeaders?.();

    // Send the trace + conversation IDs immediately so the client can
    // correlate this stream with the activity log + persistent history.
    sseWrite(res, "start", {
      traceId,
      conversationId: conversation.id,
      agentId: agent.id,
    });

    // ── Run the agent ──
    let result;
    try {
      result = await executeAgent({
        client: ai,
        agent,
        messages: runningMessages,
        ctx: {
          accountId: session.accountId,
          userId: session.userId,
          agentId: agent.id,
          traceId,
          autonomyLevel: agent.autonomyLevel,
          erpnextCompany: account.erpnextCompany,
          erpnextSid: session.erpnextSid ?? null,
          prisma,
        },
        // The gate clamps autonomy to plan ceiling, refuses runs when the
        // tenant is over quota, and records token usage per iteration.
        usageGate: defaultUsageGate,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error("Cortex /chat: engine threw", {
        accountId: session.accountId,
        traceId,
        error: errorMessage,
      });
      sseWrite(res, "error", { code: "ENGINE_ERROR", message: errorMessage });
      res.end();
      return;
    }

    // ── Stream the result back ──
    // Phase 1: we run the agent to completion server-side then emit the full
    // text + structured metadata as SSE events. Phase 2 will switch to true
    // streaming via client.messages.stream() so users see tokens as they
    // arrive — that requires the engine to expose iteration callbacks, which
    // is a more invasive change. The wire format is forward-compatible.
    if (result.toolCalls.length > 0) {
      for (const call of result.toolCalls) {
        sseWrite(res, "tool_use", {
          tool: call.tool,
          success: call.success,
          durationMs: call.durationMs,
          ...(call.error ? { error: call.error } : {}),
        });
      }
    }

    if (result.status === "needs_approval" && result.pendingAction) {
      // Persist the approval request so a human can act on it later.
      const approval = await prisma.cortexApprovalRequest.create({
        data: {
          accountId: session.accountId,
          title: `Approve: ${result.pendingAction.toolName}`,
          description: result.pendingAction.reason,
          approvalType: result.pendingAction.toolName,
          priority: "normal",
          agentId: agent.id,
          traceId,
          aiRecommendation: result.output || null,
          aiReasoning: result.pendingAction.reason,
          pendingAction: {
            toolName: result.pendingAction.toolName,
            input: result.pendingAction.input,
          },
          approverRoles: ["owner", "admin"],
        },
        select: { id: true },
      });
      sseWrite(res, "needs_approval", {
        approvalRequestId: approval.id,
        reason: result.pendingAction.reason,
      });
    }

    sseWrite(res, "delta", { text: result.output });
    sseWrite(res, "done", {
      traceId,
      conversationId: conversation.id,
      status: result.status,
      iterations: result.iterations,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: Number(result.costUsd.toFixed(6)),
      latencyMs: result.latencyMs,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    });
    res.end();

    // ── Persist execution log + conversation update + meter ──
    // These all run after the response has been streamed to the client so
    // any DB hiccup does not block the user. The fire-and-forget call
    // inherits the AsyncLocalStorage context, so the persist writes are
    // also RLS-pinned to the current tenant.
    void persistRunArtefacts({
      accountId: session.accountId,
      conversationId: conversation.id,
      storedMessages,
      newUserTurn,
      result,
      agentId: agent.id,
      traceId,
    });
  }); // close runWithTenantContext callback
});

interface PersistArgs {
  accountId: string;
  conversationId: string;
  storedMessages: CortexStoredMessage[];
  newUserTurn: Anthropic.MessageParam;
  result: Awaited<ReturnType<typeof executeAgent>>;
  agentId: string;
  traceId: string;
}

async function persistRunArtefacts(args: PersistArgs): Promise<void> {
  try {
    // 1. Append the new turn + assistant reply to the conversation
    const updatedHistory = capHistory([
      ...args.storedMessages,
      {
        role: "user",
        content: args.newUserTurn.content,
        createdAt: new Date().toISOString(),
      },
      {
        role: "assistant",
        content: args.result.output,
        createdAt: new Date().toISOString(),
      },
    ]);
    await prisma.cortexConversation.update({
      where: { id: args.conversationId },
      data: {
        messages: updatedHistory as unknown as object,
        lastAgentId: args.agentId,
        lastTraceId: args.traceId,
      },
    });

    // 2. Write the execution log row
    await prisma.cortexExecutionLog.create({
      data: {
        accountId: args.accountId,
        agentId: args.agentId,
        traceId: args.traceId,
        status: args.result.status,
        model: "claude-opus-4-6",
        inputTokens: args.result.inputTokens,
        outputTokens: args.result.outputTokens,
        costUsd: args.result.costUsd,
        latencyMs: args.result.latencyMs,
        iterations: args.result.iterations,
        toolCallCount: args.result.toolCalls.length,
        toolCallErrors: args.result.toolCalls.filter((c) => !c.success).length,
        output: args.result.output.slice(0, 8_000),
        errorMessage: args.result.errorMessage ?? null,
      },
    });

    // 3. Token usage was already recorded by the engine via the usageGate
    //    on every iteration — we no longer double-count from the route.

    // 4. Emit a Cortex event so the activity feed sees this run
    await emitEvent({
      accountId: args.accountId,
      type: "cortex.chat.completed",
      source: "user.action",
      data: {
        agentId: args.agentId,
        status: args.result.status,
        inputTokens: args.result.inputTokens,
        outputTokens: args.result.outputTokens,
        toolCalls: args.result.toolCalls.length,
      },
      traceId: args.traceId,
    });
  } catch (err) {
    logger.error("Cortex /chat: failed to persist run artefacts", {
      accountId: args.accountId,
      traceId: args.traceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── GET /cortex/conversations ─────────────────────────────────────────────

router.get("/cortex/conversations", requireAuth, async (req: Request, res: Response) => {
  const session = req.session!;
  const conversations = await prisma.cortexConversation.findMany({
    where: { accountId: session.accountId, userId: session.userId, archived: false },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: {
      id: true,
      title: true,
      lastAgentId: true,
      lastTraceId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return res.json(apiSuccess({ conversations }));
});

// ─── GET /cortex/conversations/:id ─────────────────────────────────────────

router.get("/cortex/conversations/:id", requireAuth, async (req: Request, res: Response) => {
  const session = req.session!;
  const conv = await prisma.cortexConversation.findFirst({
    where: {
      id: String(req.params.id),
      accountId: session.accountId,
      userId: session.userId,
    },
  });
  if (!conv) return res.status(404).json(apiError("NOT_FOUND", "Conversation not found"));
  return res.json(apiSuccess({ conversation: conv }));
});

// ─── GET /cortex/activity ──────────────────────────────────────────────────

router.get("/cortex/activity", requireAuth, async (req: Request, res: Response) => {
  const session = req.session!;
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
  const logs = await prisma.cortexExecutionLog.findMany({
    where: { accountId: session.accountId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      agentId: true,
      traceId: true,
      status: true,
      model: true,
      inputTokens: true,
      outputTokens: true,
      costUsd: true,
      latencyMs: true,
      iterations: true,
      toolCallCount: true,
      toolCallErrors: true,
      createdAt: true,
    },
  });
  return res.json(apiSuccess({ activity: logs }));
});

// ─── GET /cortex/exceptions ────────────────────────────────────────────────
//
// The exception queue: pending CortexApprovalRequest rows that need a human
// to approve or reject before the AI can complete the action it proposed.
// Filtered to the calling tenant; ordered by priority then age so urgent
// items surface first.

router.get("/cortex/exceptions", requireAuth, async (req: Request, res: Response) => {
  const session = req.session!;
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
  // Optional status filter — defaults to "pending" because that is the
  // common case (the dashboard shows what needs human attention now).
  const statusFilter = String(req.query.status ?? "pending");
  const status = ["pending", "approved", "rejected", "expired"].includes(statusFilter) ? statusFilter : "pending";

  const exceptions = await prisma.cortexApprovalRequest.findMany({
    where: { accountId: session.accountId, status },
    // BullMQ-style priority ordering: critical → high → normal → low.
    // Prisma can't sort by a free-text field's logical priority natively,
    // so we sort by createdAt and let the dashboard apply visual priority.
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    take: limit,
    select: {
      id: true,
      title: true,
      description: true,
      approvalType: true,
      priority: true,
      status: true,
      agentId: true,
      traceId: true,
      aiRecommendation: true,
      aiReasoning: true,
      aiConfidence: true,
      pendingAction: true,
      relatedDocType: true,
      relatedDocId: true,
      expiresAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return res.json(apiSuccess({ exceptions, count: exceptions.length, status }));
});

// ─── POST /cortex/approve/:id ──────────────────────────────────────────────
//
// Mark an approval request as approved. The pendingAction stays on the row
// so a worker (or the next agent run that opens this trace) can execute it
// using the captured tool input. We do NOT execute the action here — the
// route is the human signal, the worker is the executor. This split keeps
// the API response fast and lets execution happen with the same usageGate
// + safety checks the original agent run used.

const approveSchema = z.object({
  comment: z.string().max(1_000).optional(),
});

router.post("/cortex/approve/:id", requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const session = req.session!;
  const parsed = approveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(apiError("VALIDATION", "Invalid approve body"));
  }

  // Atomic update: only flip status if it's currently pending. Two reviewers
  // racing to click approve cannot both succeed.
  const updated = await prisma.cortexApprovalRequest.updateMany({
    where: {
      id: String(req.params.id),
      accountId: session.accountId,
      status: "pending",
    },
    data: {
      status: "approved",
      approvedBy: session.userId,
      approvedAt: new Date(),
    },
  });

  if (updated.count === 0) {
    // Either the row doesn't exist, isn't on this tenant, or is already
    // resolved. Return 404 either way to avoid leaking row existence.
    return res.status(404).json(apiError("NOT_FOUND", "Approval request not found, expired, or already resolved"));
  }

  // Emit a Cortex event so the activity log + downstream workers see the
  // approval. The event payload carries the approval id so a worker can
  // load the row and execute the pendingAction.
  await emitEvent({
    accountId: session.accountId,
    type: "cortex.approval.approved",
    source: "user.action",
    data: { approvalId: String(req.params.id), comment: parsed.data.comment ?? null },
    userId: session.userId,
  });

  return res.json(apiSuccess({ approved: true }));
});

// ─── POST /cortex/reject/:id ───────────────────────────────────────────────

const rejectSchema = z.object({
  reason: z.string().min(1).max(1_000),
});

router.post("/cortex/reject/:id", requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const session = req.session!;
  const parsed = rejectSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(apiError("VALIDATION", "Reject requires a non-empty reason explaining why"));
  }

  const updated = await prisma.cortexApprovalRequest.updateMany({
    where: {
      id: String(req.params.id),
      accountId: session.accountId,
      status: "pending",
    },
    data: {
      status: "rejected",
      rejectedBy: session.userId,
      rejectedAt: new Date(),
      rejectionReason: parsed.data.reason,
    },
  });

  if (updated.count === 0) {
    return res.status(404).json(apiError("NOT_FOUND", "Approval request not found, expired, or already resolved"));
  }

  await emitEvent({
    accountId: session.accountId,
    type: "cortex.approval.rejected",
    source: "user.action",
    data: { approvalId: String(req.params.id), reason: parsed.data.reason },
    userId: session.userId,
  });

  return res.json(apiSuccess({ rejected: true }));
});

// ─── GET /cortex/briefing ──────────────────────────────────────────────────
//
// Daily briefing: a structured summary of what the AI did in the last 24
// hours plus what currently needs human attention. The dashboard renders
// this on the home screen so a user opening the app first thing in the
// morning sees state-of-the-business at a glance.
//
// Phase 5 ships a structured aggregate built from the existing tables.
// Phase 9 (future) wires this through a dedicated briefing agent that
// turns the aggregate into prose using Claude.

router.get("/cortex/briefing", requireAuth, async (req: Request, res: Response) => {
  const session = req.session!;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Run the four aggregate queries in parallel — none depend on each other.
  const [executions, pendingApprovals, recentExceptions, recentEvents] = await Promise.all([
    prisma.cortexExecutionLog.aggregate({
      where: { accountId: session.accountId, createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, costUsd: true },
    }),
    prisma.cortexApprovalRequest.count({
      where: { accountId: session.accountId, status: "pending" },
    }),
    prisma.cortexApprovalRequest.findMany({
      where: { accountId: session.accountId, status: "pending" },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: 5,
      select: {
        id: true,
        title: true,
        priority: true,
        agentId: true,
        createdAt: true,
      },
    }),
    prisma.cortexEvent.findMany({
      where: { accountId: session.accountId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        eventType: true,
        source: true,
        processed: true,
        processedBy: true,
        createdAt: true,
      },
    }),
  ]);

  return res.json(
    apiSuccess({
      windowHours: 24,
      generatedAt: new Date().toISOString(),
      activity: {
        runs: executions._count._all,
        inputTokens: executions._sum.inputTokens ?? 0,
        outputTokens: executions._sum.outputTokens ?? 0,
        costUsd: executions._sum.costUsd ?? 0,
      },
      attention: {
        pendingApprovals,
        topExceptions: recentExceptions,
      },
      recentEvents,
    }),
  );
});

// ─── POST /cortex/feedback ─────────────────────────────────────────────────
//
// Capture human ratings, comments, and corrections on AI decisions. Writes
// to CortexFeedback (added in Phase 2). The learning pipeline later promotes
// corrections into per-tenant CortexMemory rules; for now we just persist
// the feedback so it accumulates.

const feedbackSchema = z.object({
  // Trace id of the agent run being graded — links this feedback to a
  // specific CortexExecutionLog row.
  traceId: z.string().min(1).max(200),
  // The agent that produced the output. Useful for per-agent satisfaction
  // metrics so we know which agents need tuning.
  agentId: z.string().min(1).max(100),
  // The original AI output the user is grading. Pass-through JSON so we
  // preserve tool call shapes alongside textual replies.
  originalOutput: z.unknown(),
  // What kind of feedback this is. Drives downstream processing:
  //   - rating       → star rating, no other action
  //   - thumbs_up    → positive signal, no further action
  //   - thumbs_down  → negative signal, no correction supplied
  //   - correction   → user supplied a corrected output, learning pipeline
  //                    will turn it into a CortexMemory rule
  feedbackType: z.enum(["rating", "thumbs_up", "thumbs_down", "correction"]),
  rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().max(2_000).optional(),
  correctedOutput: z.unknown().optional(),
});

router.post("/cortex/feedback", requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const session = req.session!;
  const parsed = feedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(apiError("VALIDATION", "Invalid feedback body"));
  }
  const data = parsed.data;

  // Domain rule: rating type requires the rating field; correction type
  // requires the correctedOutput field. Enforce here rather than in Zod so
  // the error message is clearer than a refinement failure.
  if (data.feedbackType === "rating" && data.rating === undefined) {
    return res.status(400).json(apiError("VALIDATION", "feedbackType=rating requires a rating field (1-5)"));
  }
  if (data.feedbackType === "correction" && data.correctedOutput === undefined) {
    return res.status(400).json(apiError("VALIDATION", "feedbackType=correction requires a correctedOutput field"));
  }

  // originalOutput is unknown JSON — Prisma's Json type accepts it but the
  // Prisma client typings reject `unknown`. The cast is local and audited
  // here rather than spread through the schema definition.
  const feedback = await prisma.cortexFeedback.create({
    data: {
      accountId: session.accountId,
      agentId: data.agentId,
      traceId: data.traceId,
      originalOutput: data.originalOutput as never,
      feedbackType: data.feedbackType,
      correctedOutput: data.correctedOutput as never,
      rating: data.rating ?? null,
      comment: data.comment ?? null,
      userId: session.userId,
      appliedToMemory: false,
    },
    select: { id: true, createdAt: true },
  });

  // Emit a Cortex event so the learning worker can pick up corrections and
  // promote them into CortexMemory. Phase 6 wires the worker; for now the
  // event flows in and is no-op'd by the empty dispatch table.
  await emitEvent({
    accountId: session.accountId,
    type: "cortex.feedback.captured",
    source: "user.action",
    data: {
      feedbackId: feedback.id,
      agentId: data.agentId,
      feedbackType: data.feedbackType,
      traceId: data.traceId,
    },
    userId: session.userId,
  });

  return res.json(apiSuccess({ feedbackId: feedback.id, createdAt: feedback.createdAt }));
});

export default router;
