import { describe, it, expect } from "vitest";
import { FLAGS_CONFIG } from "../flags.config.js";

describe("flags.config", () => {
  it("exports a FLAGS_CONFIG object", () => {
    expect(FLAGS_CONFIG).toBeDefined();
    expect(typeof FLAGS_CONFIG).toBe("object");
  });

  it("contains all expected feature flags", () => {
    expect(FLAGS_CONFIG).toHaveProperty("new_dashboard_nav");
    expect(FLAGS_CONFIG).toHaveProperty("realtime_notifications");
    expect(FLAGS_CONFIG).toHaveProperty("advanced_analytics");
    expect(FLAGS_CONFIG).toHaveProperty("webhook_delivery");
    expect(FLAGS_CONFIG).toHaveProperty("api_key_scopes");
  });

  it("each flag has required fields: key, defaultValue, description, rules", () => {
    for (const [name, flag] of Object.entries(FLAGS_CONFIG)) {
      expect(flag.key).toBe(name);
      expect(typeof flag.defaultValue).toBe("boolean");
      expect(typeof flag.description).toBe("string");
      expect(flag.description.length).toBeGreaterThan(0);
      expect(Array.isArray(flag.rules)).toBe(true);
    }
  });

  it("new_dashboard_nav defaults to false", () => {
    expect(FLAGS_CONFIG.new_dashboard_nav.defaultValue).toBe(false);
  });

  it("new_dashboard_nav enables in dev environment", () => {
    const rule = FLAGS_CONFIG.new_dashboard_nav.rules[0];
    expect(rule).toBeDefined();
    expect(rule.condition).toBe("environment");
    expect(rule.operator).toBe("equals");
    expect(rule.value).toBe("dev");
    expect(rule.flagValue).toBe(true);
  });

  it("realtime_notifications defaults to false with no rules", () => {
    expect(FLAGS_CONFIG.realtime_notifications.defaultValue).toBe(false);
    expect(FLAGS_CONFIG.realtime_notifications.rules).toHaveLength(0);
  });

  it("advanced_analytics has percentage rollout rule", () => {
    const rule = FLAGS_CONFIG.advanced_analytics.rules[0];
    expect(rule).toBeDefined();
    expect(rule.condition).toBe("percentage");
    expect(rule.operator).toBe("percentage_rollout");
    expect(rule.value).toBe(20);
    expect(rule.flagValue).toBe(true);
  });

  it("webhook_delivery defaults to false with no rules", () => {
    expect(FLAGS_CONFIG.webhook_delivery.defaultValue).toBe(false);
    expect(FLAGS_CONFIG.webhook_delivery.rules).toHaveLength(0);
  });

  it("api_key_scopes enables in dev environment", () => {
    const rule = FLAGS_CONFIG.api_key_scopes.rules[0];
    expect(rule).toBeDefined();
    expect(rule.condition).toBe("environment");
    expect(rule.value).toBe("dev");
    expect(rule.flagValue).toBe(true);
  });

  it("all flag keys match their object keys", () => {
    for (const [name, flag] of Object.entries(FLAGS_CONFIG)) {
      expect(flag.key).toBe(name);
    }
  });

  it("all flags have boolean default values", () => {
    for (const flag of Object.values(FLAGS_CONFIG)) {
      expect(typeof flag.defaultValue).toBe("boolean");
    }
  });
});
