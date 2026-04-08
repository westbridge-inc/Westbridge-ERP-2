/**
 * Cortex ERP tool wrapper tests — verifies that the legacy ERP_TOOLS are
 * adapted into Cortex tool definitions with correct side-effect / approval
 * classifications. The handlers themselves are not exercised here (that's
 * the legacy executeTool's responsibility); we only validate the wiring.
 */

import { describe, it, expect } from "vitest";
import { CORTEX_ERP_TOOLS } from "../tools/erp.js";

describe("CORTEX_ERP_TOOLS", () => {
  it("includes all 6 legacy ERP tools", () => {
    const names = CORTEX_ERP_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual([
      "create_record",
      "delete_record",
      "get_record",
      "get_summary",
      "list_records",
      "update_record",
    ]);
  });

  it("read-only tools are sideEffects=false and never need approval", () => {
    for (const name of ["list_records", "get_record", "get_summary"]) {
      const tool = CORTEX_ERP_TOOLS.find((t) => t.name === name);
      expect(tool, `expected to find ${name}`).toBeDefined();
      expect(tool!.sideEffects).toBe(false);
      expect(tool!.requiresApproval).toBe(false);
      expect(tool!.reversible).toBe(true);
    }
  });

  it("create_record and update_record are side-effecting but auto-allowed (user confirms via prompt)", () => {
    for (const name of ["create_record", "update_record"]) {
      const tool = CORTEX_ERP_TOOLS.find((t) => t.name === name);
      expect(tool, `expected to find ${name}`).toBeDefined();
      expect(tool!.sideEffects).toBe(true);
      expect(tool!.requiresApproval).toBe(false); // confirmed by the model in-conversation
      expect(tool!.reversible).toBe(false);
    }
  });

  it("delete_record always requires approval", () => {
    const tool = CORTEX_ERP_TOOLS.find((t) => t.name === "delete_record");
    expect(tool).toBeDefined();
    expect(tool!.sideEffects).toBe(true);
    expect(tool!.requiresApproval).toBe(true);
    expect(tool!.maxCallsPerRun).toBe(1);
  });

  it("read tools have higher per-run call caps than write tools", () => {
    const list = CORTEX_ERP_TOOLS.find((t) => t.name === "list_records")!;
    const create = CORTEX_ERP_TOOLS.find((t) => t.name === "create_record")!;
    expect(list.maxCallsPerRun).toBeGreaterThan(create.maxCallsPerRun);
  });

  it("every tool has a non-empty description and an inputSchema", () => {
    for (const tool of CORTEX_ERP_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.inputSchema).toBe("object");
    }
  });
});
