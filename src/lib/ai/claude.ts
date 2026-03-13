import Anthropic from "@anthropic-ai/sdk";
import { getPlan, type PlanId } from "../modules.js";

// Export null when ANTHROPIC_API_KEY is absent so callers can degrade gracefully
// instead of throwing at construction time.
export const anthropic: Anthropic | null = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Use Sonnet for interactive chat (fast, cost-efficient)
// Use Opus for deep batch analysis (insights, anomaly detection)
export const AI_MODELS = {
  chat:     "claude-sonnet-4-5",
  analysis: "claude-opus-4-5",
} as const;

export type AiModel = typeof AI_MODELS[keyof typeof AI_MODELS];

export function hasUnlimitedAi(planId: PlanId): boolean {
  return getPlan(planId).limits.aiQueriesPerMonth === -1;
}

export function isAiConfigured(): boolean {
  return anthropic !== null;
}
