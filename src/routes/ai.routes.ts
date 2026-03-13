/**
 * AI routes
 *
 * POST /ai/chat  — send a message to the AI assistant
 * GET  /ai/usage — get AI usage stats for the current account
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import { anthropic, AI_MODELS } from "../lib/ai/claude.js";
import { ERP_TOOLS, executeTool } from "../lib/ai/tools.js";
import { buildSystemPrompt, type AiModule } from "../lib/ai/context.js";
import { checkAiLimit, recordAiUsage, getAiUsage } from "../lib/ai/limits.js";
import { validateSession } from "../lib/services/session.service.js";
import { checkTieredRateLimit, rateLimitHeaders } from "../lib/api/rate-limit-tiers.js";
import { validateCsrf, CSRF_COOKIE_NAME } from "../lib/csrf.js";
import { getRedis } from "../lib/redis.js";
import { prisma } from "../lib/data/prisma.js";
import { COOKIE } from "../lib/constants.js";
import { toWebRequest } from "../middleware/auth.js";
import { getPlan, type PlanId } from "../lib/modules.js";
import type Anthropic from "@anthropic-ai/sdk";

const router = Router();

const chatSchema = z.object({
  message: z.string().min(1).max(4000),
  module: z.enum(["finance", "crm", "inventory", "hr", "manufacturing", "projects", "biztools", "general"]).default("general"),
  conversationId: z.string().uuid().optional(),
});

async function getHistory(id: string): Promise<Anthropic.MessageParam[]> {
  const client = getRedis();
  if (!client) return [];
  const raw = await client.get(`ai:conv:${id}`);
  return raw ? (JSON.parse(raw) as Anthropic.MessageParam[]) : [];
}

async function saveHistory(id: string, messages: Anthropic.MessageParam[]): Promise<void> {
  const client = getRedis();
  if (!client) return;
  await client.set(`ai:conv:${id}`, JSON.stringify(messages.slice(-20)), "EX", 3600);
}

// ---------------------------------------------------------------------------
// POST /ai/chat — send a message to the AI assistant
// ---------------------------------------------------------------------------
router.post("/ai/chat", async (req: Request, res: Response) => {
  // Degrade gracefully when the API key is not configured
  if (!anthropic) {
    return res.status(200).json({
      data: {
        reply: "AI is not configured on this plan yet.",
        conversationId: null,
        usage: { queries: 0, remaining: null },
      },
    });
  }

  const token = req.cookies?.[COOKIE.SESSION_NAME];
  if (!token) {
    return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
  }

  // CSRF validation — AI chat is a state-mutating endpoint
  const csrfCookie = req.cookies[CSRF_COOKIE_NAME];
  const csrfHeader = req.headers["x-csrf-token"] as string ?? req.headers["X-CSRF-Token"] as string;
  if (!validateCsrf(csrfHeader, csrfCookie)) {
    return res.status(403).json({ error: { code: "FORBIDDEN", message: "Invalid or missing CSRF token" } });
  }

  const sessionResult = await validateSession(token, toWebRequest(req));
  if (!sessionResult.ok) {
    return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
  }
  const session = sessionResult.data;

  const rateLimit = await checkTieredRateLimit(session.userId, "authenticated", "/api/ai/chat");
  if (!rateLimit.allowed) {
    return res
      .status(429)
      .set(rateLimitHeaders(rateLimit) as Record<string, string>)
      .json({ error: { code: "RATE_LIMITED", message: "Too many AI requests. Try again shortly." } });
  }

  // Load account for plan + company info
  const account = await prisma.account.findUnique({
    where: { id: session.accountId },
    select: { plan: true, companyName: true, erpnextCompany: true },
  });
  if (!account) {
    return res.status(404).json({ error: { code: "NOT_FOUND" } });
  }

  // Normalise plan to known PlanId
  const rawPlan = account.plan.toLowerCase();
  const planId: PlanId =
    rawPlan === "enterprise" ? "enterprise" :
    rawPlan === "business" ? "business" :
    "starter";

  // Plan AI quota check
  const limitCheck = await checkAiLimit(session.accountId, planId);
  if (!limitCheck.allowed) {
    return res.status(402).json({
      error: { code: "AI_LIMIT_REACHED", message: limitCheck.reason },
      usage: limitCheck.usage,
    });
  }

  const body = req.body;
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "INVALID_REQUEST" } });
  }

  const { message, module: rawModule, conversationId = crypto.randomUUID() } = parsed.data;
  const history = await getHistory(conversationId);

  // Load user name for system prompt
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { name: true },
  });

  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: message },
  ];

  // Validate module against known allowlist at runtime — TypeScript casts do not exist
  // at runtime, so an attacker could send an arbitrary string without this check.
  const VALID_AI_MODULES: readonly AiModule[] = ["finance", "crm", "inventory", "hr", "manufacturing", "projects", "biztools", "general"];
  const moduleContext: AiModule = (VALID_AI_MODULES as readonly string[]).includes(rawModule)
    ? (rawModule as AiModule)
    : "general";

  const system = buildSystemPrompt({
    companyName: account.companyName,
    planId,
    userName: user?.name ?? "User",
    userRole: session.role,
    currentDate: new Date().toISOString().slice(0, 10),
    moduleContext,
  });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalResponse: Anthropic.Message | null = null;
  const currentMessages = [...messages];

  // Agentic loop — max 5 rounds of tool use
  for (let round = 0; round < 5; round++) {
    const response = await anthropic.messages.create({
      model: AI_MODELS.chat,
      max_tokens: 4096,
      system,
      tools: ERP_TOOLS,
      messages: currentMessages,
    });

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;
    finalResponse = response;

    if (response.stop_reason === "end_turn") break;

    if (response.stop_reason === "tool_use") {
      const toolBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      currentMessages.push({ role: "assistant", content: response.content });

      const toolResults = await Promise.all(
        toolBlocks.map(async (tb) => ({
          type: "tool_result" as const,
          tool_use_id: tb.id,
          content: await executeTool(
            tb.name,
            tb.input,
            session.erpnextSid ?? "",
            session.accountId,
            account.erpnextCompany ?? null
          ),
        }))
      );
      currentMessages.push({ role: "user", content: toolResults });
    }
  }

  await recordAiUsage(session.accountId, totalInputTokens, totalOutputTokens);

  const textBlock = finalResponse?.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  const reply = textBlock?.text ?? "I couldn't generate a response. Please try again.";

  await saveHistory(conversationId, [
    ...messages,
    { role: "assistant", content: reply },
  ]);

  return res.json({
    data: {
      reply,
      conversationId,
      usage: {
        queries: limitCheck.usage.queries + 1,
        remaining: limitCheck.remaining.queries !== null ? limitCheck.remaining.queries - 1 : null,
      },
    },
  });
});

// ---------------------------------------------------------------------------
// GET /ai/usage — get AI usage stats for the current account
// ---------------------------------------------------------------------------
router.get("/ai/usage", async (req: Request, res: Response) => {
  const token = req.cookies?.[COOKIE.SESSION_NAME];
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sessionResult = await validateSession(token, toWebRequest(req));
  if (!sessionResult.ok) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const session = sessionResult.data;

  const account = await prisma.account.findUnique({
    where: { id: session.accountId },
    select: { plan: true },
  });
  if (!account) {
    return res.status(404).json({ error: "Not found" });
  }

  const rawPlan = account.plan.toLowerCase();
  const planId: PlanId =
    rawPlan === "enterprise" ? "enterprise" :
    rawPlan === "business" ? "business" :
    "starter";

  const usage = await getAiUsage(session.accountId);
  const plan = getPlan(planId);
  const { aiQueriesPerMonth, aiTokensPerMonth } = plan.limits;

  return res.json({
    data: {
      plan: plan.name,
      period: new Date().toISOString().slice(0, 7),
      ai: {
        queries: {
          used: usage.queries,
          limit: aiQueriesPerMonth === -1 ? null : aiQueriesPerMonth,
          unlimited: aiQueriesPerMonth === -1,
          overageRate: plan.overageRates.perExtraAiQuery,
        },
        tokens: {
          used: usage.tokens,
          limit: aiTokensPerMonth === -1 ? null : aiTokensPerMonth,
          unlimited: aiTokensPerMonth === -1,
        },
      },
    },
  });
});

export default router;
