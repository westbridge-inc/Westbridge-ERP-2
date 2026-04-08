/**
 * Cortex ERP tools — wraps the existing src/lib/ai/tools.ts handlers in the
 * Cortex tool protocol.
 *
 * The legacy /api/ai/chat route uses ERP_TOOLS directly with the Anthropic
 * SDK. We do NOT want to fork those tools — they already enforce tenant
 * isolation, doctype allowlisting, and ERPNext company scoping. Instead we
 * adapt them to the CortexToolDefinition shape so the engine can pass them
 * the typed CortexToolContext.
 *
 * The wrapper is intentionally thin: every call delegates to executeTool()
 * with the context's accountId / erpnextCompany / erpnextSid pulled out.
 * Side-effect flags are derived from the tool name — read-only tools
 * (`list_records`, `get_record`, `get_summary`) get sideEffects=false and
 * higher per-run call caps; mutating tools (`create_record`, `update_record`,
 * `delete_record`) get sideEffects=true and require approval below
 * autonomous level.
 */

import { ERP_TOOLS, executeTool } from "../../lib/ai/tools.js";
import type { CortexToolContext, CortexToolDefinition } from "../protocol.js";

/** Build a Cortex tool definition that delegates to the legacy executeTool. */
function wrapErpTool(
  legacyTool: (typeof ERP_TOOLS)[number],
  opts: {
    sideEffects: boolean;
    requiresApproval: boolean;
    reversible: boolean;
    maxCallsPerRun: number;
  },
): CortexToolDefinition {
  return {
    name: legacyTool.name,
    description: legacyTool.description ?? "",
    inputSchema: legacyTool.input_schema as Record<string, unknown>,
    sideEffects: opts.sideEffects,
    requiresApproval: opts.requiresApproval,
    reversible: opts.reversible,
    maxCallsPerRun: opts.maxCallsPerRun,
    handler: async (input: unknown, ctx: CortexToolContext): Promise<string> => {
      // executeTool returns a string (already JSON-serialised or an error
      // message). We pass it through unchanged so the engine can hand it
      // straight back to the model as a tool_result.
      return executeTool(legacyTool.name, input, ctx.erpnextSid ?? "", ctx.accountId, ctx.erpnextCompany);
    },
  };
}

/**
 * The full set of ERP tools available to the conversation agent. Mirrors
 * ERP_TOOLS one-for-one but classified by side-effect status so the engine
 * can gate mutating calls behind approval / autonomy checks.
 */
export const CORTEX_ERP_TOOLS: CortexToolDefinition[] = ERP_TOOLS.map((legacy) => {
  switch (legacy.name) {
    case "list_records":
      return wrapErpTool(legacy, {
        sideEffects: false,
        requiresApproval: false,
        reversible: true,
        maxCallsPerRun: 10,
      });
    case "get_record":
      return wrapErpTool(legacy, {
        sideEffects: false,
        requiresApproval: false,
        reversible: true,
        maxCallsPerRun: 10,
      });
    case "get_summary":
      return wrapErpTool(legacy, {
        sideEffects: false,
        requiresApproval: false,
        reversible: true,
        maxCallsPerRun: 5,
      });
    case "create_record":
      return wrapErpTool(legacy, {
        sideEffects: true,
        // Phase 1: creating new docs is allowed without explicit approval
        // for the user-facing conversation agent — the model is required by
        // its system prompt to confirm with the user first. Future agents
        // (cron-driven, event-driven) will run at lower autonomy and the
        // approval gate will fire automatically.
        requiresApproval: false,
        reversible: false,
        maxCallsPerRun: 3,
      });
    case "update_record":
      return wrapErpTool(legacy, {
        sideEffects: true,
        requiresApproval: false,
        reversible: false,
        maxCallsPerRun: 3,
      });
    case "delete_record":
      return wrapErpTool(legacy, {
        sideEffects: true,
        // Deletes always require approval — even from a high-autonomy agent
        // the engine will halt and queue a CortexApprovalRequest unless the
        // caller explicitly raised the autonomy level.
        requiresApproval: true,
        reversible: false,
        maxCallsPerRun: 1,
      });
    default:
      // Defensive fallback — any new tool added to ERP_TOOLS without a
      // classification here defaults to read-only with conservative caps.
      return wrapErpTool(legacy, {
        sideEffects: false,
        requiresApproval: false,
        reversible: true,
        maxCallsPerRun: 5,
      });
  }
});
