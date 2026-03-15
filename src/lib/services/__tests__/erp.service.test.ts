import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../data/erpnext.client.js", () => ({
  erpList: vi.fn(),
  erpGet: vi.fn(),
  erpCreate: vi.fn(),
  erpUpdate: vi.fn(),
  erpDelete: vi.fn(),
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

    it("delegates to erpList", async () => {
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

    it("delegates to erpGet", async () => {
      vi.mocked(erpGet).mockResolvedValue({ ok: true, data: { name: "INV-001" } });
      const r = await getDoc("Sales Invoice", "INV-001", "sid", "acc1");
      expect(r.ok).toBe(true);
      expect(erpGet).toHaveBeenCalled();
    });
  });

  describe("createDoc", () => {
    it("returns error for empty doctype", async () => {
      const r = await createDoc("", "sid", {});
      expect(r.ok).toBe(false);
    });

    it("delegates to erpCreate", async () => {
      vi.mocked(erpCreate).mockResolvedValue({ ok: true, data: { name: "INV-002" } });
      const r = await createDoc("Sales Invoice", "sid", { customer: "test" }, "acc1");
      expect(r.ok).toBe(true);
    });
  });

  describe("updateDoc", () => {
    it("returns error for empty doctype or name", async () => {
      expect((await updateDoc("", "name", "sid", {})).ok).toBe(false);
      expect((await updateDoc("SI", "", "sid", {})).ok).toBe(false);
    });

    it("delegates to erpUpdate", async () => {
      vi.mocked(erpUpdate).mockResolvedValue({ ok: true, data: {} });
      const r = await updateDoc("SI", "INV-001", "sid", { status: "Paid" }, "acc1");
      expect(r.ok).toBe(true);
    });
  });

  describe("deleteDoc", () => {
    it("returns error for empty doctype or name", async () => {
      expect((await deleteDoc("", "name", "sid")).ok).toBe(false);
      expect((await deleteDoc("SI", "", "sid")).ok).toBe(false);
    });

    it("delegates to erpDelete", async () => {
      vi.mocked(erpDelete).mockResolvedValue({ ok: true, data: {} });
      const r = await deleteDoc("SI", "INV-001", "sid", "acc1");
      expect(r.ok).toBe(true);
    });
  });
});
