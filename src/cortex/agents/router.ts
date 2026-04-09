/**
 * Router agent — analyses incoming business events and decides which
 * specialised agent (or sequence of agents) should handle them.
 *
 * Phase 6 of the AI-Native ERP overhaul. Most events have a one-to-one
 * mapping to a specialist agent (sales_invoice.created → finance.journal),
 * but some events need a multi-step plan (invoice.uploaded → extract.invoice
 * → finance.journal → comms.notification). The router emits a JSON plan
 * that the processor walks step-by-step.
 *
 * The router runs at SUPERVISED so its output (a JSON plan) is always
 * inspectable; the actual side effects come from the agents the plan names.
 *
 * Tools: NONE. The router is purely a planner. It cannot touch the database.
 */

import { AUTONOMY, type CortexAgentDefinition } from "../protocol.js";
import { registerAgent } from "../registry.js";

export const ROUTER_SYSTEM_PROMPT = `
You are the Westbridge Cortex Router. Analyze incoming business events and create execution plans.

RESPOND WITH JSON ONLY. No prose, no apologies, no code fences. Just the JSON object.

AVAILABLE AGENTS:
- extract.invoice — Read invoices from PDFs / images via Claude Vision
- finance.reconcile — Match bank transactions to ledger entries
- finance.journal — Create journal entries from structured data
- finance.payment — Schedule and execute payments to vendors
- comms.notification — Send internal notifications to users

AUTONOMY RULES (the engine clamps these against the tenant's plan ceiling):
L1 (human approves): payroll execution, tax filing, transactions > $50,000
L2 (human reviews): invoices > $10,000, new vendors, first-time operations for this tenant
L3 (autonomous): bank reconciliation under $10K, matched invoices, payment reminders
L4 (self-optimizing): forecasting, anomaly detection threshold tuning

OUTPUT FORMAT:
{
  "reasoning": "string — one-sentence explanation of why these steps were chosen",
  "priority": "low|medium|high|critical",
  "steps": [
    {
      "order": 1,
      "agentId": "string — must be one of the AVAILABLE AGENTS above",
      "input": { ... },
      "autonomyLevel": 3,
      "dependsOn": [],
      "onFailure": "skip|retry|abort|escalate"
    }
  ],
  "requiresNotification": false,
  "notificationMessage": "string — only set when requiresNotification is true"
}

If no agent can handle this event, return {"reasoning": "no handler", "priority": "low", "steps": [], "requiresNotification": false}.
`.trim();

export const routerAgent: CortexAgentDefinition = {
  id: "router",
  name: "Cortex Router",
  description: "Plans which specialised agent(s) should handle each incoming business event.",
  model: "claude-haiku-4-5", // Cheap + fast — the router is just classifying events.
  systemPrompt: ROUTER_SYSTEM_PROMPT,
  maxTokens: 2_000,
  // Adaptive thinking is not useful for classification — the router should
  // respond fast. Reserve thinking budget for the downstream specialists.
  adaptiveThinking: false,
  tools: [],
  autonomyLevel: AUTONOMY.SUPERVISED,
  maxFinancialImpactUsd: 0, // The router never moves money — its output is a plan.
  maxIterations: 1, // Single shot — no looping.
  timeoutMs: 15_000,
  dailyTokenBudget: 50_000,
};

registerAgent(routerAgent);
