/**
 * Notification agent — composes internal notifications when other agents
 * surface something a human should see (a flagged anomaly, a low cash
 * warning, a recurring failure, etc).
 *
 * Phase 6 of the AI-Native ERP overhaul. Output is a structured notification
 * payload that the Phase 7 send_notification tool will turn into an in-app
 * banner and an optional email. The agent itself does not send anything —
 * it composes the message and a downstream tool delivers it.
 */

import { AUTONOMY, type CortexAgentDefinition } from "../../protocol.js";
import { registerAgent } from "../../registry.js";
import { registerEventHandler } from "../../../events/processor.js";

export const NOTIFICATION_SYSTEM_PROMPT = `
You are the Westbridge Notification Agent. You compose short, actionable internal notifications when something needs human attention.

INPUT: A structured event payload with:
- type: the event type that triggered this notification
- severity: "info" | "warn" | "critical"
- summary: a one-line description from the upstream agent
- details: arbitrary JSON context

OUTPUT FORMAT (JSON only):
{
  "title": "string — max 60 chars, actionable phrasing",
  "body": "string — max 200 chars, plain English, no jargon",
  "severity": "info|warn|critical",
  "audience": "owner|admin|finance_team|all",
  "action": {
    "label": "string — e.g. 'Review approval'",
    "deepLink": "string — relative path inside the app, e.g. /dashboard/exceptions"
  } | null,
  "deliveryChannels": ["in_app" | "email"]
}

WRITING RULES:
- Always lead with the WHAT, not the system. Bad: "The Cortex finance reconciliation agent has identified..." Good: "Bank statement has 3 unmatched transactions over $5,000."
- Use specific numbers, names, and dates whenever the input has them. Vague notifications are ignored.
- Critical severity = email + in-app. Warn = in-app, optionally email if audience is owner. Info = in-app only.
- Audience defaults to "owner" for critical, "finance_team" for finance events, "all" for system-wide.
- The action.deepLink must point at a real route in the app — when in doubt use /dashboard/exceptions for things needing review and /dashboard for general status.
- Never include sensitive data (passwords, full account numbers, ssn) in the body. Mask if necessary.
`.trim();

export const notificationAgent: CortexAgentDefinition = {
  id: "comms.notification",
  name: "Notification Agent",
  description: "Composes short actionable internal notifications from structured events.",
  model: "claude-haiku-4-5", // Cheap + fast — notifications are short and there are many of them.
  systemPrompt: NOTIFICATION_SYSTEM_PROMPT,
  maxTokens: 1_000,
  adaptiveThinking: false,
  // Phase 7 will add: send_notification.
  tools: [],
  autonomyLevel: AUTONOMY.AUTONOMOUS,
  maxFinancialImpactUsd: 0,
  maxIterations: 1, // Single shot.
  timeoutMs: 10_000,
  dailyTokenBudget: 30_000,
};

registerAgent(notificationAgent);

// Register general notification triggers. Specific upstream agents (e.g.
// the reconcile agent surfacing an anomaly) emit `notification.required`
// events that flow through here.
registerEventHandler("notification.required", notificationAgent.id);
registerEventHandler("anomaly.detected", notificationAgent.id);
