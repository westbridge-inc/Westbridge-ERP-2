/**
 * Source of truth for all feature flag definitions.
 * Add new flags here before using getFlag or useFeatureFlag.
 *
 * This object is imported by lib/feature-flags.ts as the in-code fallback.
 */
import type { FeatureFlag } from "./feature-flags.types.js";

export const FLAGS_CONFIG: Record<string, FeatureFlag> = {
  new_dashboard_nav: {
    key: "new_dashboard_nav",
    defaultValue: false,
    description: "New sidebar navigation design",
    rules: [{ condition: "environment", operator: "equals", value: "dev", flagValue: true }],
  },

  realtime_notifications: {
    key: "realtime_notifications",
    defaultValue: false,
    description: "Enable SSE-based real-time notifications",
    rules: [],
  },

  advanced_analytics: {
    key: "advanced_analytics",
    defaultValue: false,
    description: "Advanced analytics module with charting",
    rules: [{ condition: "percentage", operator: "percentage_rollout", value: 20, flagValue: true }],
  },

  webhook_delivery: {
    key: "webhook_delivery",
    defaultValue: false,
    description: "Customer-configurable outgoing webhooks",
    rules: [],
  },

  api_key_scopes: {
    key: "api_key_scopes",
    defaultValue: false,
    description: "Scoped API keys with granular permissions",
    rules: [{ condition: "environment", operator: "equals", value: "dev", flagValue: true }],
  },
} as const;
