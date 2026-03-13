import { getRedis } from "../redis.js";
import { getPlan, type PlanId } from "../modules.js";
import { logger } from "../logger.js";

// Redis key: ai:usage:{accountId}:{YYYY-MM}
function usageKey(accountId: string): string {
  const month = new Date().toISOString().slice(0, 7);
  return `ai:usage:${accountId}:${month}`;
}

export interface AiUsage {
  queries: number;
  tokens: number;
}

export async function getAiUsage(accountId: string): Promise<AiUsage> {
  const client = getRedis();
  if (!client) return { queries: 0, tokens: 0 };
  const key = usageKey(accountId);
  const [queries, tokens] = await Promise.all([
    client.hget(key, "queries"),
    client.hget(key, "tokens"),
  ]);
  return {
    queries: parseInt(queries ?? "0", 10),
    tokens: parseInt(tokens ?? "0", 10),
  };
}

export interface AiLimitCheck {
  allowed: boolean;
  reason?: string;
  usage: AiUsage;
  remaining: { queries: number | null; tokens: number | null };
}

export async function checkAiLimit(
  accountId: string,
  planId: PlanId
): Promise<AiLimitCheck> {
  const plan = getPlan(planId);
  const { aiQueriesPerMonth, aiTokensPerMonth } = plan.limits;

  // Enterprise — unlimited
  if (aiQueriesPerMonth === -1) {
    const usage = await getAiUsage(accountId);
    return { allowed: true, usage, remaining: { queries: null, tokens: null } };
  }

  const usage = await getAiUsage(accountId);

  if (usage.queries >= aiQueriesPerMonth) {
    const overage = usage.queries - aiQueriesPerMonth;
    logger.warn("ai.limit.queries_exceeded", { accountId, planId, usage, limit: aiQueriesPerMonth });
    return {
      allowed: false,
      reason: `Monthly AI query limit reached (${aiQueriesPerMonth} queries). ${overage} overage queries at $${plan.overageRates.perExtraAiQuery}/query will be billed, or upgrade your plan.`,
      usage,
      remaining: { queries: 0, tokens: aiTokensPerMonth - usage.tokens },
    };
  }

  if (aiTokensPerMonth !== -1 && usage.tokens >= aiTokensPerMonth) {
    return {
      allowed: false,
      reason: "Monthly AI token limit reached. Upgrade to continue using AI features.",
      usage,
      remaining: { queries: aiQueriesPerMonth - usage.queries, tokens: 0 },
    };
  }

  return {
    allowed: true,
    usage,
    remaining: {
      queries: aiQueriesPerMonth - usage.queries,
      tokens: aiTokensPerMonth === -1 ? null : aiTokensPerMonth - usage.tokens,
    },
  };
}

export async function recordAiUsage(
  accountId: string,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  const client = getRedis();
  if (!client) return;
  const key = usageKey(accountId);
  const total = inputTokens + outputTokens;
  await Promise.all([
    client.hincrby(key, "queries", 1),
    client.hincrby(key, "tokens", total),
    client.expire(key, 60 * 60 * 24 * 35), // keep 35 days
  ]);
}
