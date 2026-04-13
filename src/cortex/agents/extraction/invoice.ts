/**
 * Invoice Extraction agent — reads invoice PDFs / images via Claude Vision
 * and emits structured JSON the finance agents can consume.
 *
 * v6.0 of the AI-Native ERP overhaul. Triggered by `document.uploaded`
 * events whose mime type is application/pdf or image/*. The v7.0 tool
 * set will add the actual document fetch + extraction tools; for now this
 * file ships the system prompt + agent definition so the registry has a
 * handle and the processor's dispatch table can route to it.
 */

import { AUTONOMY, type CortexAgentDefinition } from "../../protocol.js";
import { registerAgent } from "../../registry.js";
import { registerEventHandler } from "../../../events/processor.js";
import { EXTRACTION_AGENT_TOOLS } from "../../tools/index.js";

export const INVOICE_EXTRACTION_SYSTEM_PROMPT = `
You are the Westbridge Invoice Extraction Agent. Extract structured data from invoice documents.

INPUT: Invoice image or PDF (passed via Claude Vision in a content block).

OUTPUT FORMAT (JSON only, no prose):
{
  "confidence": 0.0-1.0,
  "supplier": {
    "name": "string",
    "address": "string",
    "tax_id": "string | null",
    "email": "string | null",
    "bank_details": "string | null"
  },
  "invoice": {
    "number": "string",
    "date": "YYYY-MM-DD",
    "due_date": "YYYY-MM-DD | null",
    "currency": "ISO 4217 code",
    "po_reference": "string | null"
  },
  "line_items": [
    {
      "description": "string",
      "quantity": number,
      "unit_price": number,
      "tax_rate": number,
      "line_total": number
    }
  ],
  "totals": {
    "subtotal": number,
    "tax_breakdown": [{ "type": "string", "rate": number, "amount": number }],
    "tax_total": number,
    "total": number
  },
  "warnings": ["string"]
}

EXTRACTION RULES:
- Numbers MUST be JSON numbers (decimals OK), never strings.
- Dates MUST be ISO YYYY-MM-DD. If only a partial date is visible, infer from context but add a warning.
- Detect currency from the symbol or ISO code present on the invoice. Default to the supplier country's currency only if no symbol is visible.
- Identify ALL tax lines separately — VAT, sales tax, withholding, etc.
- For Caribbean invoices: look for TIN, NIS numbers, GRA / BIR registration numbers and put them in supplier.tax_id.
- If confidence < 0.85 add a warning explaining what was unclear and DO NOT auto-process; let a human review.
- If a field genuinely is not present on the invoice, use null. NEVER fabricate.
`.trim();

export const invoiceExtractionAgent: CortexAgentDefinition = {
  id: "extract.invoice",
  name: "Invoice Extraction Agent",
  description: "Extracts structured invoice data from PDFs / images via Claude Vision.",
  model: "claude-opus-4-6", // Vision + multi-language extraction warrants Opus.
  systemPrompt: INVOICE_EXTRACTION_SYSTEM_PROMPT,
  maxTokens: 4_000,
  adaptiveThinking: true,
  // v7.0 wires the extraction support tools: get_accounts (so the agent
  // can suggest the correct chart-of-accounts mapping for each line item)
  // and search_contacts (to look up whether the supplier already exists).
  // Document fetch + Vision input is provided by the route as a content
  // block on the user message rather than a tool.
  tools: EXTRACTION_AGENT_TOOLS,
  autonomyLevel: AUTONOMY.AUTONOMOUS, // Reading is read-only; the engine clamps if plan caps below.
  maxFinancialImpactUsd: 0, // Extraction does not commit money.
  maxIterations: 3,
  timeoutMs: 60_000,
  dailyTokenBudget: 200_000,
};

registerAgent(invoiceExtractionAgent);

// Register the dispatch hook so the events processor routes invoice document
// uploads to this agent. The router can also pick this agent for multi-step
// plans.
registerEventHandler("document.uploaded.invoice", invoiceExtractionAgent.id);
registerEventHandler("invoice.uploaded", invoiceExtractionAgent.id);
