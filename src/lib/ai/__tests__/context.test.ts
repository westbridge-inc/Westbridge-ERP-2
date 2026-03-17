import { describe, it, expect } from "vitest";
import { buildSystemPrompt, type AiModule } from "../context.js";

describe("buildSystemPrompt", () => {
  it("builds a system prompt with company context", () => {
    const prompt = buildSystemPrompt({
      companyName: "Acme Corp",
      planId: "business",
      userName: "John",
      userRole: "admin",
      currentDate: "2026-03-17",
      moduleContext: "finance",
    });

    expect(prompt).toContain("Acme Corp");
    expect(prompt).toContain("John");
    expect(prompt).toContain("admin");
    expect(prompt).toContain("business");
    expect(prompt).toContain("2026-03-17");
    expect(prompt).toContain("Finance & Accounting");
  });

  it("uses general module context", () => {
    const prompt = buildSystemPrompt({
      companyName: "Test Co",
      planId: "starter",
      userName: "Jane",
      userRole: "member",
      currentDate: "2026-01-01",
      moduleContext: "general",
    });

    expect(prompt).toContain("all ERP modules");
  });

  it.each(["finance", "crm", "inventory", "hr", "manufacturing", "projects", "biztools", "general"] as AiModule[])(
    "handles module %s",
    (mod) => {
      const prompt = buildSystemPrompt({
        companyName: "Co",
        planId: "starter",
        userName: "U",
        userRole: "member",
        currentDate: "2026-01-01",
        moduleContext: mod,
      });
      expect(prompt).toBeTruthy();
    },
  );
});
