/**
 * Feature flag system.
 * - Flags stored in Redis as JSON; falls back to defaults when Redis is unavailable.
 * - Percentage rollouts are deterministic via HMAC hash of (userId + flagKey).
 * - All evaluations are logged for analytics.
 */
import { createHmac } from "crypto";
import { getRedis } from "./redis.js";
import { logger } from "./logger.js";
import { FLAGS_CONFIG } from "./flags.config.js";
import type { FlagValue, FlagRule, FeatureFlag, FlagContext } from "./feature-flags.types.js";
import { publish } from "./realtime.js";

// ─── Re-export types from shared file ────────────────────────────────────────

export type {
  FlagValue,
  RuleCondition,
  RuleOperator,
  FlagRule,
  FeatureFlag,
  FlagContext,
} from "./feature-flags.types.js";

// ─── Redis helpers ────────────────────────────────────────────────────────────

const FLAG_PREFIX = "flags:";

async function getStoredFlag(key: string): Promise<FeatureFlag | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(`${FLAG_PREFIX}${key}`);
    if (!raw) return null;
    return JSON.parse(raw) as FeatureFlag;
  } catch {
    return null;
  }
}

export async function setFlag(flag: FeatureFlag): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis unavailable");
  await redis.set(`${FLAG_PREFIX}${flag.key}`, JSON.stringify(flag));
  await publish("*", {
    type: "flag.updated",
    payload: { key: flag.key },
    timestamp: new Date().toISOString(),
  });
}

export async function getAllFlags(): Promise<FeatureFlag[]> {
  const redis = getRedis();
  if (!redis) return Object.values(FLAGS_CONFIG);
  try {
    // Use SCAN instead of KEYS to avoid blocking Redis on large keyspaces
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [nextCursor, batch] = await redis.scan(cursor, "MATCH", `${FLAG_PREFIX}*`, "COUNT", 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== "0");
    if (keys.length === 0) return Object.values(FLAGS_CONFIG);
    const values = await redis.mget(...keys);
    return values
      .filter((v: string | null): v is string => v !== null)
      .map((v: string) => JSON.parse(v) as FeatureFlag);
  } catch {
    return Object.values(FLAGS_CONFIG);
  }
}

// ─── Deterministic percentage rollout ────────────────────────────────────────

function percentileForUser(userId: string, flagKey: string): number {
  const hmac = createHmac("sha256", flagKey).update(userId).digest("hex");
  const int = parseInt(hmac.slice(0, 8), 16);
  return (int / 0xffffffff) * 100;
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

function evaluateRule(rule: FlagRule, ctx: FlagContext): FlagValue | undefined {
  const { condition, operator, value, flagValue } = rule;

  if (condition === "environment" && operator === "equals") {
    const env = ctx.environment ?? process.env.DEPLOY_STAGE ?? "dev";
    return env === value ? flagValue : undefined;
  }

  if (condition === "user_id" && operator === "equals" && ctx.userId === value) {
    return flagValue;
  }

  if (condition === "user_id" && operator === "in" && ctx.userId) {
    return (value as string[]).includes(ctx.userId) ? flagValue : undefined;
  }

  if (condition === "account_id" && operator === "equals" && ctx.accountId === value) {
    return flagValue;
  }

  if (condition === "account_id" && operator === "in" && ctx.accountId) {
    return (value as string[]).includes(ctx.accountId) ? flagValue : undefined;
  }

  if (condition === "email_domain" && operator === "contains" && ctx.email) {
    const domain = ctx.email.split("@")[1] ?? "";
    return domain === value ? flagValue : undefined;
  }

  if (condition === "percentage" && operator === "percentage_rollout" && ctx.userId) {
    const pct = percentileForUser(ctx.userId, flagValue.toString());
    return pct < (value as number) ? flagValue : undefined;
  }

  return undefined;
}

/**
 * Evaluate a feature flag for a given context.
 * Falls back to the in-code default when Redis is unavailable.
 */
export async function getFlag(key: string, ctx: FlagContext = {}): Promise<FlagValue> {
  const configFlag = FLAGS_CONFIG[key];
  const stored = await getStoredFlag(key);
  const flag = stored ?? configFlag;

  if (!flag) {
    logger.warn("Unknown feature flag", { key, ctx });
    return false;
  }

  for (const rule of flag.rules) {
    const result = evaluateRule(rule, ctx);
    if (result !== undefined) {
      logger.debug("Flag evaluated", { key, value: result, rule: rule.condition, userId: ctx.userId });
      return result;
    }
  }

  logger.debug("Flag defaulted", { key, value: flag.defaultValue, userId: ctx.userId });
  return flag.defaultValue;
}
