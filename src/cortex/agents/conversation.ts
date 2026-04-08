/**
 * Conversation agent — the user-facing Bridge AI.
 *
 * Phase 1 of the AI-Native ERP overhaul. This is the agent that answers
 * chat messages from /api/cortex/chat. It uses Opus 4.6 with adaptive
 * thinking, the existing ERP tool set, and runs at AUTONOMOUS by default
 * because the user is in the loop on every turn.
 *
 * Future phases add specialised agents (extract.invoice, finance.reconcile,
 * supply.reorder, ...) — those are registered the same way: build a
 * CortexAgentDefinition, call registerAgent() once at module load.
 */

import { AUTONOMY, type CortexAgentDefinition } from "../protocol.js";
import { registerAgent } from "../registry.js";
import { CORTEX_ERP_TOOLS } from "../tools/erp.js";
import { buildConversationSystemPrompt } from "../prompts/conversation.js";

/**
 * Build a fresh definition for the conversation agent given a session
 * context. The system prompt is per-call because it includes the user's
 * name and current date, but everything else is constant.
 *
 * The static definition (without context) is registered with the registry
 * for discovery; the per-call version is built fresh inside the route.
 */
export function buildConversationAgent(systemPrompt: string): CortexAgentDefinition {
  return {
    id: "conversation",
    name: "Bridge AI Conversation",
    description:
      "User-facing Bridge AI. Answers questions, queries data, drafts documents, all confirmed before execution.",
    model: "claude-opus-4-6",
    systemPrompt,
    maxTokens: 16_000,
    adaptiveThinking: true,
    tools: CORTEX_ERP_TOOLS,
    autonomyLevel: AUTONOMY.AUTONOMOUS,
    // Phase 1: $10K cap on side-effecting tools. Above this, the engine
    // halts and persists a CortexApprovalRequest. The user-facing agent
    // generally is not asked to move money — most conversation traffic is
    // queries — but this protects against prompt injection or accidents.
    maxFinancialImpactUsd: 10_000,
    maxIterations: 10,
    timeoutMs: 60_000,
    // 100K tokens / day / tenant for Phase 1 — the meter enforces this.
    dailyTokenBudget: 100_000,
  };
}

// Register a stub for discovery. The route builds a fresh definition with
// the per-call system prompt before invoking the engine.
registerAgent(
  buildConversationAgent("[Conversation system prompt is built per-call from buildConversationSystemPrompt(ctx).]"),
);

// Re-export the prompt builder so the route only needs one import.
export { buildConversationSystemPrompt };
