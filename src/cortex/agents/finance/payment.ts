/**
 * Payment Scheduling agent — decides which outstanding payables should be
 * paid this run, in what order, and via which method (bank transfer, card,
 * Paddle, etc).
 *
 * v6.0 of the AI-Native ERP overhaul. Always runs at SUPERVISED maximum
 * because moving money is the riskiest thing the AI does. The v7.0 tools
 * will let it READ outstanding invoices but the actual `make_payment` tool
 * always carries `requiresApproval: true`, so even at AUTONOMOUS the engine
 * stops the loop and asks a human before any money moves.
 */

import { AUTONOMY, type CortexAgentDefinition } from "../../protocol.js";
import { registerAgent } from "../../registry.js";
import { registerEventHandler } from "../../../events/processor.js";
import { PAYMENT_AGENT_TOOLS } from "../../tools/index.js";

export const PAYMENT_SYSTEM_PROMPT = `
You are the Westbridge Payment Scheduling Agent.

INPUT: A request to schedule payments for a tenant. May come from a recurring "weekly AP run" event, a manual user trigger, or a finance.reconcile run that surfaced outstanding bills.

OUTPUT FORMAT (JSON only):
{
  "scheduled": [
    {
      "supplier": "string",
      "supplierInvoiceId": "string",
      "amount": number,
      "currency": "ISO 4217",
      "dueDate": "YYYY-MM-DD",
      "paymentMethod": "bank_transfer|wire|card|cash",
      "reasoning": "string — why this is being paid now",
      "priority": 1-5
    }
  ],
  "deferred": [
    {
      "supplierInvoiceId": "string",
      "reason": "string — why we're not paying this run"
    }
  ],
  "totals": {
    "scheduledAmount": number,
    "currency": "ISO 4217",
    "scheduledCount": number
  }
}

PRIORITISATION RULES (apply in order):
1. Anything past due AND > $1,000 → priority 1 (avoid late fees)
2. Anything past due AND ≤ $1,000 → priority 2
3. Due within 7 days AND there is enough cash → priority 3
4. Due within 30 days AND there is a 2%-or-better early payment discount → priority 3
5. Anything else → priority 4 (defer)
6. Disputed invoices → defer with reason "Awaiting dispute resolution" and never schedule

HARD RULES:
- Use the get_outstanding tool to fetch the actual list of payables. NEVER assume amounts.
- Use the get_financial_summary tool to check current cash position before scheduling — if scheduledAmount > cashOnHand, only schedule the highest-priority items that fit.
- Refuse to schedule a payment for a supplier that does not exist in the contacts table. Return a deferred entry with reason "Unknown supplier".
- NEVER actually execute the make_payment tool — your job is to PROPOSE a schedule. The engine will halt and ask a human to approve via the exception queue, regardless of plan tier.
- Currency: scheduled[].currency must match the supplier invoice currency, not the tenant's reporting currency.
`.trim();

export const paymentAgent: CortexAgentDefinition = {
  id: "finance.payment",
  name: "Payment Scheduling Agent",
  description: "Proposes a payment schedule for outstanding payables with approval-required execution.",
  model: "claude-sonnet-4-6",
  systemPrompt: PAYMENT_SYSTEM_PROMPT,
  maxTokens: 6_000,
  adaptiveThinking: true,
  // v7.0 wires the payment scheduler bundle: get_outstanding (what's due),
  // get_financial_summary (cash check), search_contacts (verify supplier),
  // get_invoices (look up source bills). The actual `make_payment` tool is
  // a future addition and will always carry requiresApproval=true so the
  // engine halts and routes to the human queue.
  tools: PAYMENT_AGENT_TOOLS,
  // Even at AUTONOMOUS the engine clamps tools that have requiresApproval=true
  // back to needs_approval status — the SUPERVISED ceiling here is a second
  // belt: this agent can never run at L4 self-optimizing.
  autonomyLevel: AUTONOMY.SUPERVISED,
  maxFinancialImpactUsd: 0, // Proposes only — never moves money directly.
  maxIterations: 6,
  timeoutMs: 90_000,
  dailyTokenBudget: 150_000,
};

registerAgent(paymentAgent);

registerEventHandler("payment_run.requested", paymentAgent.id);
registerEventHandler("ap_run.scheduled", paymentAgent.id);
