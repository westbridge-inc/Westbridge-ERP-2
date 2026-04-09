/**
 * Default UsageGate implementation — wires the engine to the existing
 * Redis-backed AI quota meter (lib/ai/limits.ts) and the plan ceiling
 * defined in lib/modules.ts.
 *
 * The chat route and the events processor both pass an instance of this gate
 * to executeAgent() so the engine can:
 *   1. Clamp the agent's autonomy to the tenant's plan ceiling
 *   2. Refuse to start a run when the tenant has exhausted its quota
 *   3. Record token usage after every successful Claude API call
 *
 * Kept in its own file (rather than inside engine.ts) to preserve the
 * engine's purity — the engine has no direct DB or Redis imports, so it
 * remains unit-testable with a fake gate.
 */

import { logger } from "../lib/logger.js";
import { prisma } from "../lib/data/prisma.js";
import { getPlan, type PlanId } from "../lib/modules.js";
import { checkAiLimit, recordAiUsage } from "../lib/ai/limits.js";
import { type AutonomyLevel, type UsageGate } from "./protocol.js";

/**
 * Resolve the tenant's plan id with the same fallback chain the rest of the
 * codebase uses: Subscription.planId → Account.plan → "starter".
 *
 * Per-account lookup is unavoidable here — the gate runs per-agent-call so
 * the result must always reflect the current plan, not a stale snapshot.
 * Future optimisation: a 60-second in-memory cache keyed by accountId.
 */
async function resolvePlanId(accountId: string): Promise<PlanId> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { plan: true, subscriptions: { orderBy: { createdAt: "desc" }, take: 1, select: { planId: true } } },
  });
  // Defensive optional-chaining: tests and pre-fix accounts can lack the
  // subscriptions array entirely (the mock helpers return only `{plan, ...}`).
  // The gate must never throw on missing data — fall back to Account.plan,
  // then to "starter" as a final safety net.
  const fromSub = account?.subscriptions?.[0]?.planId?.toLowerCase();
  const fromAccount = account?.plan?.toLowerCase();
  const candidate = fromSub ?? fromAccount ?? "starter";
  // Validate the candidate is one of the known plan ids; fall back to starter
  // for any unexpected value rather than throwing — the gate must never
  // crash an agent run due to bad data.
  const known = new Set<PlanId>(["solo", "starter", "business", "enterprise"]);
  return known.has(candidate as PlanId) ? (candidate as PlanId) : "starter";
}

/**
 * The default gate. Importable as a singleton — there's no per-request
 * state, every method takes accountId so a single instance serves every
 * tenant.
 */
export const defaultUsageGate: UsageGate = {
  async clampAutonomy(accountId: string, requested: AutonomyLevel): Promise<AutonomyLevel> {
    try {
      const planId = await resolvePlanId(accountId);
      const plan = getPlan(planId);
      const ceiling = plan.maxAutonomyLevel as AutonomyLevel;
      // Take the minimum of requested and the plan's ceiling.
      return (requested < ceiling ? requested : ceiling) as AutonomyLevel;
    } catch (err) {
      // If we can't resolve the plan, fall back to the most conservative
      // autonomy level. The engine will surface this via its own logs.
      logger.warn("usage-gate: clampAutonomy failed; defaulting to L2 supervised", {
        accountId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 2 as AutonomyLevel;
    }
  },

  async checkLimit(accountId: string): Promise<{ allowed: boolean; reason?: string }> {
    const planId = await resolvePlanId(accountId);
    const result = await checkAiLimit(accountId, planId);
    return { allowed: result.allowed, reason: result.reason };
  },

  async recordUsage(accountId: string, inputTokens: number, outputTokens: number): Promise<void> {
    await recordAiUsage(accountId, inputTokens, outputTokens);
  },
};
