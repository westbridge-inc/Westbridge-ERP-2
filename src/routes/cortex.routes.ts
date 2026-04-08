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
import { checkAiLimit, recordAiUsage } from "../lib/ai/limits.js";
import { validateSession } from "../lib/services/session.service.js";
import { checkTieredRateLimit, rateLimitHeaders } from "../lib/api/rate-limit-tiers.js";
import { validateCsrf, CSRF_COOKIE_NAME } from "../lib/csrf.js";
import { prisma } from "../lib/data/prisma.js";
import { COOKIE } from "../lib/constants.js";
import { toWebRequest, requireAuth } from "../middleware/auth.js";
import { apiSuccess, apiError } from "../types/api.js";
import { getPlan, type PlanId } from "../lib/modules.js";
import { logger } from "../lib/logger.js";
import { executeAgent } from "../cortex/engine.js";
import { buildConversationAgent, buildConversationSystemPrompt } from "../cortex/agents/conversation.js";
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

  // ── Plan AI quota check (reuses the existing meter) ──
  const limitCheck = await checkAiLimit(session.accountId, planId);
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
      client: anthropic,
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
  // any DB hiccup does not block the user.
  void persistRunArtefacts({
    accountId: session.accountId,
    conversationId: conversation.id,
    storedMessages,
    newUserTurn,
    result,
    agentId: agent.id,
    traceId,
  });
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

    // 3. Record token usage to the meter for billing + quota
    if (args.result.inputTokens > 0 || args.result.outputTokens > 0) {
      await recordAiUsage(args.accountId, args.result.inputTokens, args.result.outputTokens);
    }

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

export default router;
