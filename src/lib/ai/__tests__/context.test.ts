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

  it("includes domain tool names in capabilities", () => {
    const prompt = buildSystemPrompt({
      companyName: "Co",
      planId: "starter",
      userName: "U",
      userRole: "member",
      currentDate: "2026-01-01",
      moduleContext: "general",
    });

    expect(prompt).toContain("get_revenue_summary");
    expect(prompt).toContain("get_overdue_invoices");
    expect(prompt).toContain("get_cash_flow");
    expect(prompt).toContain("get_pipeline_summary");
    expect(prompt).toContain("get_top_customers");
    expect(prompt).toContain("get_low_stock_items");
    expect(prompt).toContain("get_stock_value");
    expect(prompt).toContain("get_employee_summary");
  });

  it("includes module-specific tool guidance for finance", () => {
    const prompt = buildSystemPrompt({
      companyName: "Co",
      planId: "starter",
      userName: "U",
      userRole: "member",
      currentDate: "2026-01-01",
      moduleContext: "finance",
    });

    expect(prompt).toContain("PREFERRED TOOLS FOR THIS MODULE");
    expect(prompt).toContain("get_revenue_summary");
    expect(prompt).toContain("get_overdue_invoices");
    expect(prompt).toContain("get_cash_flow");
  });

  it("includes module-specific tool guidance for crm", () => {
    const prompt = buildSystemPrompt({
      companyName: "Co",
      planId: "starter",
      userName: "U",
      userRole: "member",
      currentDate: "2026-01-01",
      moduleContext: "crm",
    });

    expect(prompt).toContain("get_pipeline_summary");
    expect(prompt).toContain("get_top_customers");
  });

  it("includes module-specific tool guidance for inventory", () => {
    const prompt = buildSystemPrompt({
      companyName: "Co",
      planId: "starter",
      userName: "U",
      userRole: "member",
      currentDate: "2026-01-01",
      moduleContext: "inventory",
    });

    expect(prompt).toContain("get_low_stock_items");
    expect(prompt).toContain("get_stock_value");
  });

  it("includes module-specific tool guidance for hr", () => {
    const prompt = buildSystemPrompt({
      companyName: "Co",
      planId: "starter",
      userName: "U",
      userRole: "member",
      currentDate: "2026-01-01",
      moduleContext: "hr",
    });

    expect(prompt).toContain("get_employee_summary");
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
