/**
 * erp.service tests
 *
 * Mocks (1 — external boundary only):
 *   1. erpnext.client — external ERPNext HTTP API
 *
 * Internal modules running for real:
 *   - logger (suppressed in test)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../data/erpnext.client.js", () => ({
  erpList: vi.fn(),
  erpGet: vi.fn(),
  erpCreate: vi.fn(),
  erpUpdate: vi.fn(),
  erpDelete: vi.fn(),
}));

// Logger: suppress output to avoid noisy test runs
vi.mock("../../logger.js", () => ({
  logger: {
    // Top-level methods (used by callers that don't go through .child)
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// Mock the events emitter so createDoc's fire-and-forget emitEvent call
// (added in v4.0 of the AI-Native overhaul) does not try to write to a
// real cortex_events table. Without this mock, emitEvent's prisma.create
// call rejects (no DB) and the catch handler ends up as an unhandled
// rejection which CI's strict-mode vitest treats as a job failure.
vi.mock("../../../events/emitter.js", () => ({
  emitEvent: vi.fn().mockResolvedValue({ eventId: "evt_test", traceId: "trace_test", queued: true }),
}));

import { list, getDoc, createDoc, updateDoc, deleteDoc } from "../erp.service.js";
import { erpList, erpGet, erpCreate, erpUpdate, erpDelete } from "../../data/erpnext.client.js";

describe("erp.service", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("list", () => {
    it("returns error for empty doctype", async () => {
      const r = await list("", "sid");
      expect(r.ok).toBe(false);
    });

    it("returns error for whitespace-only doctype", async () => {
      const r = await list("   ", "sid");
      expect(r.ok).toBe(false);
    });

    it("returns error for unsupported doctype", async () => {
      const r = await list("Hacker Table", "sid");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("Invalid or unsupported document type");
    });

    it("delegates to erpList for allowed doctype", async () => {
      vi.mocked(erpList).mockResolvedValue({ ok: true, data: [{ name: "INV-001" }] });
      const r = await list("Sales Invoice", "sid", undefined, "acc1", "MyCompany");
      expect(r.ok).toBe(true);
      expect(erpList).toHaveBeenCalledWith("Sales Invoice", "sid", undefined, "acc1", "MyCompany");
    });
  });

  describe("getDoc", () => {
    it("returns error for empty doctype", async () => {
      const r = await getDoc("", "name", "sid");
      expect(r.ok).toBe(false);
    });

    it("returns error for empty name", async () => {
      const r = await getDoc("Sales Invoice", "", "sid");
      expect(r.ok).toBe(false);
    });

    it("returns error for unsupported doctype", async () => {
      const r = await getDoc("Evil Type", "name", "sid");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("Invalid or unsupported document type");
    });

    it("delegates to erpGet", async () => {
      vi.mocked(erpGet).mockResolvedValue({ ok: true, data: { name: "INV-001" } });
      const r = await getDoc("Sales Invoice", "INV-001", "sid", "acc1");
      expect(r.ok).toBe(true);
      expect(erpGet).toHaveBeenCalled();
    });
  });

  describe("createDoc", () => {
    it("returns error for empty doctype", async () => {
      const r = await createDoc("", "sid", {}, "acc1");
      expect(r.ok).toBe(false);
    });

    it("returns error for unsupported doctype", async () => {
      const r = await createDoc("Bad Type", "sid", {}, "acc1");
      expect(r.ok).toBe(false);
    });

    it("returns error when accountId is missing", async () => {
      const r = await createDoc("Sales Invoice", "sid", {});
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("Account information is required");
    });

    it("delegates to erpCreate with valid inputs", async () => {
      vi.mocked(erpCreate).mockResolvedValue({ ok: true, data: { name: "INV-002" } });
      const r = await createDoc("Sales Invoice", "sid", { customer: "test" }, "acc1");
      expect(r.ok).toBe(true);
    });
  });

  describe("updateDoc", () => {
    it("returns error for empty doctype or name", async () => {
      expect((await updateDoc("", "name", "sid", {}, "acc1")).ok).toBe(false);
      expect((await updateDoc("Sales Invoice", "", "sid", {}, "acc1")).ok).toBe(false);
    });

    it("returns error for unsupported doctype", async () => {
      const r = await updateDoc("Nope", "name", "sid", {}, "acc1");
      expect(r.ok).toBe(false);
    });

    it("returns error when accountId is missing", async () => {
      const r = await updateDoc("Sales Invoice", "INV-001", "sid", {});
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("Account information is required");
    });

    it("delegates to erpUpdate with valid inputs", async () => {
      vi.mocked(erpUpdate).mockResolvedValue({ ok: true, data: {} });
      const r = await updateDoc("Sales Invoice", "INV-001", "sid", { status: "Paid" }, "acc1");
      expect(r.ok).toBe(true);
    });
  });

  describe("deleteDoc", () => {
    it("returns error for empty doctype or name", async () => {
      expect((await deleteDoc("", "name", "sid", "acc1")).ok).toBe(false);
      expect((await deleteDoc("Sales Invoice", "", "sid", "acc1")).ok).toBe(false);
    });

    it("returns error for unsupported doctype", async () => {
      const r = await deleteDoc("Nope", "name", "sid", "acc1");
      expect(r.ok).toBe(false);
    });

    it("returns error when accountId is missing", async () => {
      const r = await deleteDoc("Sales Invoice", "INV-001", "sid");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("Account information is required");
    });

    it("delegates to erpDelete with valid inputs", async () => {
      vi.mocked(erpDelete).mockResolvedValue({ ok: true, data: {} });
      const r = await deleteDoc("Sales Invoice", "INV-001", "sid", "acc1");
      expect(r.ok).toBe(true);
    });
  });
});
