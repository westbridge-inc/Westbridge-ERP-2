/**
 * Cortex Engine — agentic loop with autonomy gating + audit logging.
 *
 * Why a manual loop instead of the SDK's `client.beta.messages.toolRunner`:
 * the tool runner is great for simple agents but it does not give us the
 * hooks we need to (a) check each tool against the running autonomy level
 * before executing, (b) compute and gate financial impact per call, (c)
 * stop mid-loop and persist a CortexApprovalRequest, and (d) emit per-tool
 * audit log entries with our own trace correlation. We trade ~50 lines of
 * code for full control over the safety boundary.
 *
 * The loop:
 *   1. Call Anthropic with the agent's system prompt + the running messages.
 *   2. If the model returns plain text → done, return success.
 *   3. If the model returns tool_use blocks → execute each tool through the
 *      safety checks, append the results back into the messages, loop again.
 *   4. If any tool requires approval → halt, return needs_approval with the
 *      pending action serialised so the API can persist it.
 *   5. Hard cap iterations + wall clock so a runaway agent always terminates.
 *
 * The engine NEVER instantiates the Anthropic client itself — it accepts one
 * via dependency injection. This keeps the engine unit-testable with a fake
 * client and prevents the engine module from crashing at import time when
 * ANTHROPIC_API_KEY is unset.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import {
  AUTONOMY,
  type CortexAgentDefinition,
  type CortexExecutionResult,
  type CortexToolCallRecord,
  type CortexToolContext,
  type CortexToolDefinition,
  type UsageGate,
} from "./protocol.js";

// Per-million-token rates for cost computation. Mirrors the table in the
// Claude API skill — kept in sync manually because the SDK does not expose
// pricing programmatically.
const MODEL_PRICING: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  "claude-opus-4-6": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },
};

function costFor(model: string, inputTokens: number, outputTokens: number): number {
  const rates = MODEL_PRICING[model] ?? MODEL_PRICING["claude-sonnet-4-6"]!;
  return (inputTokens / 1_000_000) * rates.inputPerMillion + (outputTokens / 1_000_000) * rates.outputPerMillion;
}

/**
 * Estimate the financial impact of a tool call from its arguments.
 *
 * This is a heuristic — the goal is to catch obvious mistakes (a payment
 * tool called with $50,000 input) before the engine commits to running it.
 * Tools that have no monetary footprint return 0; tools that handle money
 * should put a top-level `amount` / `total` / `value` field in the input
 * schema so the engine can read it without any tool-specific knowledge.
 */
function estimateFinancialImpactUsd(input: unknown): number {
  if (!input || typeof input !== "object") return 0;
  const obj = input as Record<string, unknown>;
  for (const key of ["amount", "total", "value", "grand_total", "amount_usd"]) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (typeof v === "string") {
      const parsed = parseFloat(v);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return 0;
}

/** Convert our CortexToolDefinition[] to Anthropic.Tool[] for the SDK call. */
function toClaudeTools(tools: CortexToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
  }));
}

/** Extract the assistant text from a Claude response, joining all text blocks. */
function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export interface ExecuteAgentParams {
  /** Anthropic client. Pass `null` to error gracefully when API key is unset. */
  client: Anthropic | null;
  /** The agent to run. Resolved from the registry by the caller. */
  agent: CortexAgentDefinition;
  /** Conversation history + the new user turn. The engine appends assistant + tool turns to this list. */
  messages: Anthropic.MessageParam[];
  /** Tool context. Passed verbatim to every tool handler. */
  ctx: CortexToolContext;
  /**
   * Optional usage gate. When provided, the engine clamps autonomy to the
   * tenant plan's max, refuses to start if the tenant has no quota left, and
   * records token usage after every Claude API call. When omitted (legacy
   * test fixtures + the existing chat route that pre-checks externally),
   * the engine runs with no quota enforcement of its own.
   *
   * Spec mandate: "the AI query counter must increment in the engine, not
   * just in the chat endpoint" — the gate is the canonical hook.
   */
  usageGate?: UsageGate;
}

/**
 * Run an agentic loop. Returns a CortexExecutionResult that the caller is
 * responsible for persisting (CortexExecutionLog) and acting on (the API
 * route returns it; the worker queues approvals).
 */
export async function executeAgent(params: ExecuteAgentParams): Promise<CortexExecutionResult> {
  const { client, agent, messages, ctx, usageGate } = params;
  const startTime = Date.now();
  const toolCalls: CortexToolCallRecord[] = [];
  const toolCallCountByName = new Map<string, number>();
  let totalInput = 0;
  let totalOutput = 0;
  let iterations = 0;
  // Effective autonomy used for the run — starts at the requested value and
  // gets clamped down by the usage gate if the tenant's plan caps it lower.
  let effectiveAutonomy: typeof ctx.autonomyLevel = ctx.autonomyLevel;

  // Hard fail when the SDK is not configured. The route is responsible for
  // detecting this and returning a graceful 503; we just throw so the route
  // can map it to a user-facing message.
  if (!client) {
    return {
      status: "failed",
      output: "",
      traceId: ctx.traceId,
      agentId: agent.id,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: Date.now() - startTime,
      iterations: 0,
      toolCalls: [],
      errorMessage: "ANTHROPIC_API_KEY is not configured",
    };
  }

  // ── Usage gate (autonomy clamp + quota check) ──
  // Both run BEFORE the first API call so a tenant who's out of quota never
  // burns Claude tokens, and a Solo-plan tenant can never run a Business-tier
  // autonomy level even if the agent definition asks for it.
  if (usageGate) {
    try {
      const clamped = await usageGate.clampAutonomy(ctx.accountId, ctx.autonomyLevel);
      if (clamped !== ctx.autonomyLevel) {
        logger.info("Cortex engine: autonomy clamped by plan ceiling", {
          agentId: agent.id,
          accountId: ctx.accountId,
          requested: ctx.autonomyLevel,
          clamped,
        });
      }
      effectiveAutonomy = clamped;

      const limit = await usageGate.checkLimit(ctx.accountId);
      if (!limit.allowed) {
        return {
          status: "failed",
          output: "",
          traceId: ctx.traceId,
          agentId: agent.id,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          latencyMs: Date.now() - startTime,
          iterations: 0,
          toolCalls: [],
          errorMessage: limit.reason ?? "AI usage limit reached for this billing period",
        };
      }
    } catch (err) {
      // The gate itself failed (Redis down, DB hiccup). Fail closed: better
      // to refuse a single agent run than silently bypass the quota system.
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error("Cortex engine: usage gate failed; refusing run", {
        agentId: agent.id,
        accountId: ctx.accountId,
        error: errorMessage,
      });
      return {
        status: "failed",
        output: "",
        traceId: ctx.traceId,
        agentId: agent.id,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: Date.now() - startTime,
        iterations: 0,
        toolCalls: [],
        errorMessage: "AI usage gate is unavailable; please retry shortly",
      };
    }
  }

  // Wall-clock guard. The agent timeout is enforced via AbortSignal.timeout
  // so each underlying HTTP call inherits the same deadline.
  const deadline = AbortSignal.timeout(agent.timeoutMs);

  const claudeTools = toClaudeTools(agent.tools);
  const runningMessages: Anthropic.MessageParam[] = [...messages];

  // Tools see the EFFECTIVE autonomy, not the requested one. This way a tool
  // that gates its own behavior on `ctx.autonomyLevel` (e.g. a write-tool that
  // refuses to commit at < SUPERVISED) gets the post-clamp value, not the
  // pre-clamp value the agent definition asked for.
  const toolCtx: CortexToolContext = { ...ctx, autonomyLevel: effectiveAutonomy };

  let lastMessage: Anthropic.Message | null = null;

  // ── AGENTIC LOOP ──
  while (iterations < agent.maxIterations) {
    iterations++;

    if (deadline.aborted) {
      return {
        status: "timeout",
        output: lastMessage ? extractText(lastMessage) : "",
        traceId: ctx.traceId,
        agentId: agent.id,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        costUsd: costFor(agent.model, totalInput, totalOutput),
        latencyMs: Date.now() - startTime,
        iterations,
        toolCalls,
        errorMessage: `Agent exceeded ${agent.timeoutMs}ms timeout`,
      };
    }

    // Build the request. Adaptive thinking is opt-in per agent because not
    // every agent benefits — routine reconciliation does NOT need it,
    // financial-analytics does. The SDK rejects `thinking` on older models,
    // so the agent definition is the source of truth.
//
    // Use the explicit non-streaming params type so TypeScript narrows the
    // return value to Message (not Stream). This module is the agentic
    // foundation; streaming happens one layer up in the API route via the
    // Conversation table + SSE chunks of the captured execution result.
    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model: agent.model,
      max_tokens: agent.maxTokens,
      system: agent.systemPrompt,
      messages: runningMessages,
      tools: claudeTools.length > 0 ? claudeTools : undefined,
      ...(agent.adaptiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
    };

    let response: Anthropic.Message;
    try {
      response = await client.messages.create(request);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error("Cortex engine: Anthropic API call failed", {
        agentId: agent.id,
        traceId: ctx.traceId,
        accountId: ctx.accountId,
        iteration: iterations,
        error: errorMessage,
      });
      return {
        status: "failed",
        output: lastMessage ? extractText(lastMessage) : "",
        traceId: ctx.traceId,
        agentId: agent.id,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        costUsd: costFor(agent.model, totalInput, totalOutput),
        latencyMs: Date.now() - startTime,
        iterations,
        toolCalls,
        errorMessage,
      };
    }

    lastMessage = response;
    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;

    // Record usage AFTER the API call succeeded — even if the agent later
    // hits the iteration cap or a tool error, we still bill for the tokens
    // we actually consumed. recordUsage is best-effort: a bookkeeping
    // failure must NOT block the response to the user.
    if (usageGate) {
      try {
        await usageGate.recordUsage(ctx.accountId, response.usage.input_tokens, response.usage.output_tokens);
      } catch (err) {
        logger.warn("Cortex engine: usageGate.recordUsage failed; continuing", {
          agentId: agent.id,
          accountId: ctx.accountId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // No tool calls → the agent is done thinking, return the text.
    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      return {
        status: "success",
        output: extractText(response),
        traceId: ctx.traceId,
        agentId: agent.id,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        costUsd: costFor(agent.model, totalInput, totalOutput),
        latencyMs: Date.now() - startTime,
        iterations,
        toolCalls,
      };
    }

    // Append the assistant turn (with tool_use blocks) BEFORE we run the
    // tools — Claude requires this exact ordering on the next request.
    runningMessages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUses) {
      const toolDef = agent.tools.find((t) => t.name === toolUse.name);

      if (!toolDef) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Error: unknown tool "${toolUse.name}". Available tools: ${agent.tools.map((t) => t.name).join(", ")}`,
          is_error: true,
        });
        toolCalls.push({
          tool: toolUse.name,
          input: toolUse.input,
          error: "unknown tool",
          success: false,
          durationMs: 0,
        });
        continue;
      }

      // Per-run call cap — prevents an agent from looping the same tool
      // forever and burning through the daily token budget.
      const calledSoFar = toolCallCountByName.get(toolDef.name) ?? 0;
      if (calledSoFar >= toolDef.maxCallsPerRun) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Error: tool "${toolDef.name}" exceeded its per-run call cap of ${toolDef.maxCallsPerRun}. Stop calling this tool and respond to the user.`,
          is_error: true,
        });
        toolCalls.push({
          tool: toolDef.name,
          input: toolUse.input,
          error: "per-run cap exceeded",
          success: false,
          durationMs: 0,
        });
        continue;
      }
      toolCallCountByName.set(toolDef.name, calledSoFar + 1);

      // Approval gate — refuse to execute if the tool requires approval and
      // the EFFECTIVE autonomy (after plan clamp) is below autonomous level.
      // Using effectiveAutonomy here is what makes Solo-plan tenants safe:
      // even if the agent definition asks for AUTONOMOUS, the plan clamp
      // pulls it down to SUPERVISED so any side-effecting tool needs approval.
      if (toolDef.requiresApproval && effectiveAutonomy < AUTONOMY.AUTONOMOUS) {
        return {
          status: "needs_approval",
          output: extractText(response),
          traceId: ctx.traceId,
          agentId: agent.id,
          inputTokens: totalInput,
          outputTokens: totalOutput,
          costUsd: costFor(agent.model, totalInput, totalOutput),
          latencyMs: Date.now() - startTime,
          iterations,
          toolCalls,
          pendingAction: {
            toolName: toolDef.name,
            input: toolUse.input,
            reason: `Tool "${toolDef.name}" requires human approval (effective autonomy ${effectiveAutonomy} < ${AUTONOMY.AUTONOMOUS}).`,
          },
        };
      }

      // Financial impact gate — only enforced for side-effecting tools.
      if (toolDef.sideEffects) {
        const impact = estimateFinancialImpactUsd(toolUse.input);
        if (impact > agent.maxFinancialImpactUsd) {
          return {
            status: "needs_approval",
            output: extractText(response),
            traceId: ctx.traceId,
            agentId: agent.id,
            inputTokens: totalInput,
            outputTokens: totalOutput,
            costUsd: costFor(agent.model, totalInput, totalOutput),
            latencyMs: Date.now() - startTime,
            iterations,
            toolCalls,
            pendingAction: {
              toolName: toolDef.name,
              input: toolUse.input,
              reason: `Estimated impact $${impact} exceeds agent limit $${agent.maxFinancialImpactUsd}.`,
            },
          };
        }
      }

      // Execute the tool. Catch every error so the model can recover with a
      // tool_result error block instead of crashing the loop.
      const toolStart = Date.now();
      try {
        const result = await toolDef.handler(toolUse.input, toolCtx);
        const durationMs = Date.now() - toolStart;
        toolCalls.push({
          tool: toolDef.name,
          input: toolUse.input,
          output: result,
          success: true,
          durationMs,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - toolStart;
        toolCalls.push({
          tool: toolDef.name,
          input: toolUse.input,
          error: message,
          success: false,
          durationMs,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Error: ${message}`,
          is_error: true,
        });
      }
    }

    runningMessages.push({ role: "user", content: toolResults });
  }

  // Hit the iteration cap. Return whatever text the last assistant turn had
  // so the user is not left staring at a blank reply.
  return {
    status: "failed",
    output: lastMessage ? extractText(lastMessage) : "",
    traceId: ctx.traceId,
    agentId: agent.id,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    costUsd: costFor(agent.model, totalInput, totalOutput),
    latencyMs: Date.now() - startTime,
    iterations,
    toolCalls,
    errorMessage: `Agent exceeded ${agent.maxIterations}-iteration cap without finishing`,
  };
}

// Test-only export so the unit suite can verify the cost table without
// reaching into the module scope.
export const __testing__ = { costFor, estimateFinancialImpactUsd };
