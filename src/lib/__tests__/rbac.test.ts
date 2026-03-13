/**
 * RBAC unit tests — tests hasPermission, role inheritance, and default-deny behaviour.
 */
import { describe, it, expect } from "vitest";
import { hasPermission, getPermissions, ROLES, type Role } from "../rbac.js";

describe("RBAC — hasPermission", () => {
  // ── viewer (base role) ──────────────────────────────────────────────────

  it("viewer can read invoices", () => {
    expect(hasPermission("viewer", "invoices:read")).toBe(true);
  });

  it("viewer cannot write invoices", () => {
    expect(hasPermission("viewer", "invoices:write")).toBe(false);
  });

  it("viewer cannot delete invoices", () => {
    expect(hasPermission("viewer", "invoices:delete")).toBe(false);
  });

  it("viewer cannot read billing", () => {
    expect(hasPermission("viewer", "billing:read")).toBe(false);
  });

  it("viewer cannot access audit logs", () => {
    expect(hasPermission("viewer", "audit_logs:read")).toBe(false);
  });

  // ── member (inherits viewer) ────────────────────────────────────────────

  it("member can write invoices (own permission)", () => {
    expect(hasPermission("member", "invoices:write")).toBe(true);
  });

  it("member inherits viewer's read permissions", () => {
    expect(hasPermission("member", "invoices:read")).toBe(true);
    expect(hasPermission("member", "expenses:read")).toBe(true);
  });

  it("member cannot delete invoices", () => {
    expect(hasPermission("member", "invoices:delete")).toBe(false);
  });

  // ── manager (inherits member → viewer) ──────────────────────────────────

  it("manager can delete invoices", () => {
    expect(hasPermission("manager", "invoices:delete")).toBe(true);
  });

  it("manager can read billing", () => {
    expect(hasPermission("manager", "billing:read")).toBe(true);
  });

  it("manager cannot manage billing", () => {
    expect(hasPermission("manager", "billing:manage")).toBe(false);
  });

  it("manager cannot write payroll", () => {
    expect(hasPermission("manager", "payroll:write")).toBe(false);
  });

  it("manager can read payroll", () => {
    expect(hasPermission("manager", "payroll:read")).toBe(true);
  });

  // ── admin (inherits manager → member → viewer) ─────────────────────────

  it("admin can write payroll", () => {
    expect(hasPermission("admin", "payroll:write")).toBe(true);
  });

  it("admin can invite users", () => {
    expect(hasPermission("admin", "users:invite")).toBe(true);
  });

  it("admin can read audit logs", () => {
    expect(hasPermission("admin", "audit_logs:read")).toBe(true);
  });

  it("admin cannot manage roles (owner-only)", () => {
    expect(hasPermission("admin", "users:manage_roles")).toBe(false);
  });

  it("admin cannot manage billing (owner-only)", () => {
    expect(hasPermission("admin", "billing:manage")).toBe(false);
  });

  it("admin does NOT have admin:* wildcard", () => {
    expect(hasPermission("admin", "admin:*")).toBe(false);
  });

  // ── owner (inherits admin → full chain) ─────────────────────────────────

  it("owner has admin:* wildcard", () => {
    expect(hasPermission("owner", "admin:*")).toBe(true);
  });

  it("owner can manage roles", () => {
    expect(hasPermission("owner", "users:manage_roles")).toBe(true);
  });

  it("owner can manage billing", () => {
    expect(hasPermission("owner", "billing:manage")).toBe(true);
  });

  it("owner inherits all lower-level permissions", () => {
    expect(hasPermission("owner", "invoices:read")).toBe(true);
    expect(hasPermission("owner", "invoices:write")).toBe(true);
    expect(hasPermission("owner", "invoices:delete")).toBe(true);
    expect(hasPermission("owner", "payroll:write")).toBe(true);
    expect(hasPermission("owner", "audit_logs:read")).toBe(true);
  });

  // ── wildcard bypass ─────────────────────────────────────────────────────

  it("owner's admin:* grants access to any permission", () => {
    // admin:* should bypass the explicit permission check
    expect(hasPermission("owner", "webhooks:delete")).toBe(true);
    expect(hasPermission("owner", "api_keys:delete")).toBe(true);
  });

  // ── default-deny for unknown roles ──────────────────────────────────────

  it("unknown role is denied by default", () => {
    expect(hasPermission("hacker" as Role, "invoices:read")).toBe(false);
  });

  it("empty string role is denied", () => {
    expect(hasPermission("" as Role, "invoices:read")).toBe(false);
  });
});

describe("RBAC — getPermissions", () => {
  it("returns all viewer permissions", () => {
    const perms = getPermissions("viewer");
    expect(perms).toContain("invoices:read");
    expect(perms).not.toContain("invoices:write");
  });

  it("member permissions include inherited viewer permissions", () => {
    const perms = getPermissions("member");
    expect(perms).toContain("invoices:read"); // inherited
    expect(perms).toContain("invoices:write"); // own
  });

  it("owner permissions include admin:*", () => {
    const perms = getPermissions("owner");
    expect(perms).toContain("admin:*");
  });
});

describe("RBAC — role hierarchy is strict", () => {
  it("each role has more permissions than its child", () => {
    const hierarchy: Role[] = ["viewer", "member", "manager", "admin", "owner"];
    for (let i = 1; i < hierarchy.length; i++) {
      const childPerms = getPermissions(hierarchy[i - 1]);
      const parentPerms = getPermissions(hierarchy[i]);
      expect(parentPerms.length).toBeGreaterThan(childPerms.length);
      // Every child permission should exist in the parent
      for (const perm of childPerms) {
        expect(parentPerms).toContain(perm);
      }
    }
  });

  it("ROLES constant lists all 5 roles", () => {
    expect(ROLES).toHaveLength(5);
    expect(ROLES).toContain("owner");
    expect(ROLES).toContain("viewer");
  });
});
