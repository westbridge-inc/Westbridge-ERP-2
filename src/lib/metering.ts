/**
 * Usage metering: tracks billable usage per account per billing period.
 *
 * Storage: Redis hashes
 *   Key:    meter:{accountId}:{YYYY-MM}
 *   Fields: api_calls, erp_docs_created, ai_tokens_input, ai_tokens_output
 *
 * Active users are tracked in a Redis Set (deduplicated per day):
 *   Key:    meter:{accountId}:{YYYY-MM}:active_users:{YYYY-MM-DD}
 *
 * All keys expire 90 days after the end of the billing month to keep Redis lean
 * without losing data needed for invoicing.
 */

import { getRedis } from "./redis.js";
import { logger } from "./logger.js";

export type MeterMetric =
  | "api_calls"
  | "erp_docs_created"
  | "erp_docs_updated"
  | "ai_tokens_input"
  | "ai_tokens_output";

export interface UsageRecord {
  period: string; // YYYY-MM
  api_calls: number;
  erp_docs_created: number;
  ai_tokens_input: number;
  ai_tokens_output: number;
  active_users_count: number;
}

function periodKey(accountId: string, period: string): string {
  return `meter:${accountId}:${period}`;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

// Keys expire at end of period + 90 days (generous buffer for billing disputes)
function keyTtlSeconds(period: string): number {
  const [year, month] = period.split("-").map(Number);
  const endOfMonth = new Date(year!, month!, 1); // first day of *next* month
  const expiry = new Date(endOfMonth.getTime() + 90 * 24 * 60 * 60 * 1000);
  return Math.max(0, Math.floor((expiry.getTime() - Date.now()) / 1000));
}

export const meter = {
  /**
   * Increment a usage metric for the current billing period.
   * Silently no-ops if Redis is unavailable — metering must never block a request.
   */
  async increment(accountId: string, metric: MeterMetric, value = 1): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
      const key = periodKey(accountId, currentPeriod());
      await redis.hincrbyfloat(key, metric, value);
      // Refresh TTL on every increment to keep the key alive
      await redis.expire(key, keyTtlSeconds(currentPeriod()));
    } catch (e) {
      logger.warn("meter.increment failed", {
        accountId,
        metric,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Record an active user for today. Uses a Redis Set to deduplicate across
   * multiple requests — each userId is counted at most once per day.
   */
  async recordActiveUser(accountId: string, userId: string): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
      const key = `meter:${accountId}:${currentPeriod()}:active_users:${todayStr()}`;
      await redis.sadd(key, userId);
      await redis.expire(key, keyTtlSeconds(currentPeriod()));
    } catch (e) {
      logger.warn("meter.recordActiveUser failed", { accountId, error: e instanceof Error ? e.message : String(e) });
    }
  },

  /**
   * Get usage for a specific billing period (defaults to current month).
   */
  async get(accountId: string, period?: string): Promise<UsageRecord> {
    const p = period ?? currentPeriod();
    const redis = getRedis();
    const empty: UsageRecord = {
      period: p,
      api_calls: 0,
      erp_docs_created: 0,
      ai_tokens_input: 0,
      ai_tokens_output: 0,
      active_users_count: 0,
    };

    if (!redis) return empty;

    try {
      const key = periodKey(accountId, p);
      const [fields, activeUserKeys] = await Promise.all([
        redis.hgetall(key),
        redis.keys(`meter:${accountId}:${p}:active_users:*`),
      ]);

      // Tally active users across all days in the period (union of sets)
      let activeUsersCount = 0;
      if (activeUserKeys.length > 0) {
        activeUsersCount = await redis.sunionstore(`meter:${accountId}:${p}:active_users:tmp`, ...activeUserKeys);
        await redis.del(`meter:${accountId}:${p}:active_users:tmp`);
      }

      return {
        period: p,
        api_calls: Math.round(parseFloat(fields?.api_calls ?? "0")),
        erp_docs_created: Math.round(parseFloat(fields?.erp_docs_created ?? "0")),
        ai_tokens_input: Math.round(parseFloat(fields?.ai_tokens_input ?? "0")),
        ai_tokens_output: Math.round(parseFloat(fields?.ai_tokens_output ?? "0")),
        active_users_count: activeUsersCount,
      };
    } catch (e) {
      logger.warn("meter.get failed", { accountId, period: p, error: e instanceof Error ? e.message : String(e) });
      return empty;
    }
  },

  /**
   * Get usage for the last N months including the current one.
   */
  async getAll(accountId: string, months = 3): Promise<UsageRecord[]> {
    const periods: string[] = [];
    const now = new Date();
    for (let i = 0; i < months; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      periods.push(d.toISOString().slice(0, 7));
    }
    return Promise.all(periods.map((p) => this.get(accountId, p)));
  },
};

// ─── AI token cost estimation ─────────────────────────────────────────────────

// Rough estimate based on GPT-4o pricing at time of writing.
// Update when model pricing changes.
const COST_PER_1K_INPUT = 0.005;
const COST_PER_1K_OUTPUT = 0.015;

export function estimateAiCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1000) * COST_PER_1K_INPUT + (outputTokens / 1000) * COST_PER_1K_OUTPUT;
}
