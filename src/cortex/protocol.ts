/**
 * Cortex Protocol — type definitions shared between the engine, agents, and tools.
 *
 * The Cortex is the AI-native kernel that layers an event-driven multi-agent
 * system on top of the existing Westbridge Prisma + BullMQ stack. This file
 * is intentionally type-only so it can be imported from anywhere (routes,
 * services, workers) without dragging in the Anthropic SDK at module load.
 */

// We import the runtime prisma export so the context type matches the
// extended client (with soft-delete + RLS extensions) rather than the bare
// PrismaClient class. Using `typeof prisma` is the canonical way to keep
// the type accurate when the client has extensions applied.
import type { prisma } from "../lib/data/prisma.js";
type CortexPrisma = typeof prisma;

// ─── Autonomy levels ──────────────────────────────────────────────────────────
//
// Every agent runs at one of these levels. The engine refuses to execute a
// tool that has `requiresApproval: true` if the running autonomy level is < 3,
// instead returning a `needs_approval` result that the API surfaces as a
// pending CortexApprovalRequest.

export type AutonomyLevel = 0 | 1 | 2 | 3 | 4;

export const AUTONOMY = {
  /** Manual — human does everything. The agent never executes; it only suggests. */
  MANUAL: 0 as AutonomyLevel,
  /** Assisted — AI proposes, human executes. Used for high-risk ops. */
  ASSISTED: 1 as AutonomyLevel,
  /** Supervised — AI executes, human reviews after the fact. Used for medium-risk ops. */
  SUPERVISED: 2 as AutonomyLevel,
  /** Autonomous — AI executes, only flags exceptions. Default for routine ops. */
  AUTONOMOUS: 3 as AutonomyLevel,
  /** Self-optimizing — AI executes and improves its own thresholds over time. */
  SELF_OPTIMIZING: 4 as AutonomyLevel,
} as const;

// ─── Tool context ─────────────────────────────────────────────────────────────
//
// Every tool execution receives a context object that pins the call to a
// specific tenant + user + trace. The engine constructs this once per agent
// run and passes the same instance to every tool the agent invokes, so a
// tool can never accidentally bleed across tenants.

export interface CortexToolContext {
  /** The tenant boundary. Always set, always derived from a validated session. */
  accountId: string;
  /** The end-user who triggered the run, if any (null for cron / event-driven runs). */
  userId: string | null;
  /** The agent making the call. Used for audit logging. */
  agentId: string;
  /** A UUID that ties together every tool call, log entry, and approval request from this run. */
  traceId: string;
  /** The autonomy level the agent is running at. Tools enforce their own gates against this. */
  autonomyLevel: AutonomyLevel;
  /**
   * The ERPNext company name for tenant-scoped doctype queries. Mirrors the
   * pattern used by src/lib/ai/tools.ts in the legacy /api/ai/chat. May be
   * null for accounts whose ERPNext provisioning has not completed.
   */
  erpnextCompany: string | null;
  /**
   * The ERPNext session id, if any. Tools that hit ERPNext through the
   * existing erpnext.client need this to authenticate. Falls back to API key
   * auth when not provided.
   */
  erpnextSid: string | null;
  /** Shared Prisma client (the extended runtime instance, not the bare class). Tools NEVER instantiate their own. */
  prisma: CortexPrisma;
}

// ─── Agent definition ─────────────────────────────────────────────────────────
//
// An agent is a (prompt, tool set, autonomy, model) bundle. The registry
// stores these by id. The engine looks one up, builds the system prompt, and
// runs the agentic loop using the Anthropic SDK's Tool Runner.

export interface CortexAgentDefinition {
  id: string;
  name: string;
  description: string;

  // Model + sampling
  model: string; // e.g. "claude-opus-4-6"
  systemPrompt: string;
  maxTokens: number;
  /** Use adaptive thinking on Opus 4.6 / Sonnet 4.6. Set false to disable. */
  adaptiveThinking: boolean;

  // Tool set
  tools: CortexToolDefinition[];

  // Safety + autonomy
  /** Default level the engine runs this agent at. Can be overridden per-call. */
  autonomyLevel: AutonomyLevel;
  /** Maximum financial impact (in account base currency, normalized to USD) the agent can authorize alone. */
  maxFinancialImpactUsd: number;
  /** Hard cap on the number of agentic loop iterations. */
  maxIterations: number;

  // Limits
  /** Per-call timeout in milliseconds. */
  timeoutMs: number;
  /** Per-tenant per-day token budget. Enforced by the engine + meter. */
  dailyTokenBudget: number;
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export interface CortexToolDefinition {
  /** Stable name. Lowercase snake_case. Surfaces directly to the model. */
  name: string;
  /** Plain-English description. Used by the model to decide when to call. Keep it specific. */
  description: string;
  /** JSON Schema (subset) describing the tool's input. Use Zod via betaZodTool when constructing. */
  inputSchema: Record<string, unknown>;
  /** Implementation. Throws on validation failure. Returns plain JSON-serializable data. */
  handler: (input: unknown, ctx: CortexToolContext) => Promise<unknown>;
  /** True if this tool mutates state. Used to decide whether to enforce financial-impact gates. */
  sideEffects: boolean;
  /** True if this tool always requires human approval regardless of agent autonomy. */
  requiresApproval: boolean;
  /** True if the tool's effect can be undone (deleting a draft, marking a flag). False blocks rollback. */
  reversible: boolean;
  /** Hard cap on calls per agent run. Prevents loops. */
  maxCallsPerRun: number;
}

// ─── Execution result ─────────────────────────────────────────────────────────

export type CortexExecutionStatus = "success" | "needs_approval" | "failed" | "timeout";

export interface CortexToolCallRecord {
  tool: string;
  input: unknown;
  output?: unknown;
  error?: string;
  success: boolean;
  durationMs: number;
}

export interface CortexExecutionResult {
  status: CortexExecutionStatus;
  /** The agent's final textual output, if any. */
  output: string;
  /** The trace id for cross-system correlation. */
  traceId: string;
  /** The agent that ran. */
  agentId: string;
  /** Token usage broken out for the meter. */
  inputTokens: number;
  outputTokens: number;
  /** Cost in USD computed from per-model rates. */
  costUsd: number;
  /** Wall-clock latency end-to-end. */
  latencyMs: number;
  /** Number of agentic loop iterations executed. */
  iterations: number;
  /** All tool calls executed during this run. */
  toolCalls: CortexToolCallRecord[];
  /** Set when status is "needs_approval" — the queued action waiting for a human. */
  pendingAction?: {
    toolName: string;
    input: unknown;
    reason: string;
  };
  /** Set when status is "failed" or "timeout". */
  errorMessage?: string;
}

// ─── Conversation persistence shape ───────────────────────────────────────────
//
// Stored in CortexConversation.messages as JSON. Mirrors Anthropic.MessageParam[]
// shape but kept structural so we don't import the SDK from the protocol file.

export interface CortexStoredMessage {
  role: "user" | "assistant";
  content: unknown; // Anthropic.MessageParam.content — string or content blocks
  createdAt: string; // ISO timestamp
}
