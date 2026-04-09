import { describe, it, expect } from "vitest";
import {
  PLANS,
  MODULES,
  MODULE_BUNDLES,
  CATEGORIES,
  MODULE_IDS,
  MODULE_ROWS,
  getPlan,
  getModule,
  getBundle,
  isBundleIncludedInPlan,
  isModuleIncludedInPlan,
  getAddOnPrice,
  formatLimit,
} from "../modules.js";

describe("PLANS", () => {
  it("has 4 plans in solo→enterprise order", () => {
    expect(PLANS).toHaveLength(4);
    expect(PLANS.map((p) => p.id)).toEqual(["solo", "starter", "business", "enterprise"]);
  });

  it("plans are ordered by price ascending", () => {
    for (let i = 1; i < PLANS.length; i++) {
      expect(PLANS[i].pricePerMonth).toBeGreaterThan(PLANS[i - 1].pricePerMonth);
    }
  });

  it("annual price is less than monthly price for all plans", () => {
    for (const plan of PLANS) {
      expect(plan.annualPricePerMonth).toBeLessThan(plan.pricePerMonth);
    }
  });

  it("enterprise has unlimited users (-1)", () => {
    const enterprise = PLANS.find((p) => p.id === "enterprise")!;
    expect(enterprise.limits.users).toBe(-1);
  });

  it("all plans have non-empty features array", () => {
    for (const plan of PLANS) {
      expect(plan.features.length).toBeGreaterThan(0);
    }
  });

  it("solo costs $49.99/month", () => {
    expect(getPlan("solo").pricePerMonth).toBe(49.99);
  });

  it("starter costs $199.99/month", () => {
    expect(getPlan("starter").pricePerMonth).toBe(199.99);
  });

  it("business costs $999.99/month", () => {
    expect(getPlan("business").pricePerMonth).toBe(999.99);
  });

  it("enterprise costs $4,999.99/month", () => {
    expect(getPlan("enterprise").pricePerMonth).toBe(4999.99);
  });

  // ─── AI-native limits (designed for autonomous agent ops, not chatbot) ────

  it("solo: 500 AI ops/mo, 2M tokens/mo, $0.08 overage, L2 max autonomy", () => {
    const p = getPlan("solo");
    expect(p.limits.aiQueriesPerMonth).toBe(500);
    expect(p.limits.aiTokensPerMonth).toBe(2_000_000);
    expect(p.overageRates.perExtraAiQuery).toBe(0.08);
    expect(p.maxAutonomyLevel).toBe(2);
  });

  it("starter: 2,500 AI ops/mo, 10M tokens/mo, $0.05 overage, L3 max autonomy", () => {
    const p = getPlan("starter");
    expect(p.limits.aiQueriesPerMonth).toBe(2_500);
    expect(p.limits.aiTokensPerMonth).toBe(10_000_000);
    expect(p.overageRates.perExtraAiQuery).toBe(0.05);
    expect(p.maxAutonomyLevel).toBe(3);
  });

  it("business: 15,000 AI ops/mo, 75M tokens/mo, $0.03 overage, L4 max autonomy", () => {
    const p = getPlan("business");
    expect(p.limits.aiQueriesPerMonth).toBe(15_000);
    expect(p.limits.aiTokensPerMonth).toBe(75_000_000);
    expect(p.overageRates.perExtraAiQuery).toBe(0.03);
    expect(p.maxAutonomyLevel).toBe(4);
  });

  it("enterprise: unlimited AI ops + tokens, no overage, L4 max autonomy", () => {
    const p = getPlan("enterprise");
    expect(p.limits.aiQueriesPerMonth).toBe(-1);
    expect(p.limits.aiTokensPerMonth).toBe(-1);
    expect(p.overageRates.perExtraAiQuery).toBe(0);
    expect(p.maxAutonomyLevel).toBe(4);
  });

  it("maxAutonomyLevel is monotonic non-decreasing across plan tiers", () => {
    // Higher-tier plans never give less AI freedom than lower-tier plans.
    for (let i = 1; i < PLANS.length; i++) {
      expect(PLANS[i].maxAutonomyLevel).toBeGreaterThanOrEqual(PLANS[i - 1].maxAutonomyLevel);
    }
  });
});

describe("MODULE_BUNDLES", () => {
  it("has 7 bundles", () => {
    expect(MODULE_BUNDLES).toHaveLength(7);
  });

  it("each bundle has a unique id", () => {
    const ids = MODULE_BUNDLES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("each bundle references valid module ids", () => {
    for (const bundle of MODULE_BUNDLES) {
      for (const modId of bundle.moduleIds) {
        expect(MODULE_IDS).toContain(modId);
      }
    }
  });

  it("each bundle has AI features", () => {
    for (const bundle of MODULE_BUNDLES) {
      expect(bundle.aiFeatures.length).toBeGreaterThan(0);
    }
  });
});

describe("MODULES", () => {
  it("has at least 30 modules", () => {
    expect(MODULES.length).toBeGreaterThanOrEqual(30);
  });

  it("each module has a unique id", () => {
    const ids = MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every module belongs to a valid bundle", () => {
    const bundleIds = MODULE_BUNDLES.map((b) => b.id);
    for (const mod of MODULES) {
      expect(bundleIds).toContain(mod.bundleId);
    }
  });

  it("every module has a category from CATEGORIES", () => {
    for (const mod of MODULES) {
      expect(CATEGORIES as readonly string[]).toContain(mod.category);
    }
  });
});

describe("getPlan", () => {
  it("returns the correct plan by id", () => {
    expect(getPlan("starter").name).toBe("Starter");
  });

  it("throws for unknown plan", () => {
    expect(() => getPlan("platinum" as any)).toThrow("Unknown plan");
  });
});

describe("getModule", () => {
  it("returns a module by id", () => {
    expect(getModule("general-ledger")?.name).toBe("General Ledger");
  });

  it("returns undefined for unknown id", () => {
    expect(getModule("nonexistent")).toBeUndefined();
  });
});

describe("getBundle", () => {
  it("returns a bundle by id", () => {
    expect(getBundle("finance")?.name).toBe("Finance & Accounting");
  });

  it("returns undefined for unknown id", () => {
    expect(getBundle("nonexistent")).toBeUndefined();
  });
});

describe("isBundleIncludedInPlan", () => {
  it("finance is included in starter", () => {
    expect(isBundleIncludedInPlan("finance", "starter")).toBe(true);
  });

  it("manufacturing is NOT included in starter", () => {
    expect(isBundleIncludedInPlan("manufacturing", "starter")).toBe(false);
  });

  it("all bundles are included in enterprise", () => {
    for (const bundle of MODULE_BUNDLES) {
      expect(isBundleIncludedInPlan(bundle.id, "enterprise")).toBe(true);
    }
  });
});

describe("isModuleIncludedInPlan", () => {
  it("general-ledger is in starter (finance bundle)", () => {
    expect(isModuleIncludedInPlan("general-ledger", "starter")).toBe(true);
  });

  it("production-planning is NOT in starter", () => {
    expect(isModuleIncludedInPlan("production-planning", "starter")).toBe(false);
  });

  it("returns false for unknown module id", () => {
    expect(isModuleIncludedInPlan("nonexistent", "enterprise")).toBe(false);
  });
});

describe("getAddOnPrice", () => {
  it("returns null if module is already included", () => {
    expect(getAddOnPrice("general-ledger", "starter")).toBeNull();
  });

  it("returns bundle price for add-on module", () => {
    const price = getAddOnPrice("production-planning", "starter");
    expect(price).toBeGreaterThan(0);
  });

  it("returns null for unknown module", () => {
    expect(getAddOnPrice("nonexistent", "starter")).toBeNull();
  });
});

describe("formatLimit", () => {
  it("returns 'Unlimited' for -1", () => {
    expect(formatLimit(-1)).toBe("Unlimited");
  });

  it("formats number with locale string", () => {
    expect(formatLimit(1000)).toBe("1,000");
  });

  it("appends unit when provided", () => {
    expect(formatLimit(50, "GB")).toBe("50 GB");
  });
});

describe("MODULE_ROWS", () => {
  it("has same length as MODULES", () => {
    expect(MODULE_ROWS).toHaveLength(MODULES.length);
  });

  it("each row has category, module, moduleId, bundleId", () => {
    for (const row of MODULE_ROWS) {
      expect(row.category).toBeDefined();
      expect(row.module).toBeDefined();
      expect(row.moduleId).toBeDefined();
      expect(row.bundleId).toBeDefined();
    }
  });
});
