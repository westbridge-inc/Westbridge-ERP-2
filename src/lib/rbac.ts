/**
 * Role-Based Access Control (RBAC) with granular permissions.
 * Supports role inheritance and custom permission sets.
 *
 * @example
 * hasPermission("manager", "invoices:write") // true
 * hasPermission("viewer",  "invoices:write") // false
 *
 * // React gate:
 * <PermissionGate permission="invoices:write">
 *   <CreateInvoiceButton />
 * </PermissionGate>
 */

import { logger } from "./logger.js";

// --- Permission definitions ---

export type Permission =
  | "invoices:read"
  | "invoices:write"
  | "invoices:delete"
  | "expenses:read"
  | "expenses:write"
  | "expenses:delete"
  | "orders:read"
  | "orders:write"
  | "orders:delete"
  | "customers:read"
  | "customers:write"
  | "customers:delete"
  | "inventory:read"
  | "inventory:write"
  | "hr:read"
  | "hr:write"
  | "accounting:read"
  | "accounting:write"
  | "analytics:read"
  | "users:read"
  | "users:invite"
  | "users:remove"
  | "users:manage_roles"
  | "settings:read"
  | "settings:write"
  | "billing:read"
  | "billing:manage"
  | "api_keys:read"
  | "api_keys:write"
  | "api_keys:delete"
  | "webhooks:read"
  | "webhooks:write"
  | "webhooks:delete"
  | "reports:read"
  | "reports:create"
  | "audit_logs:read"
  // Superuser wildcard — granted only to owner. Named "admin:*" for historical
  // reasons but admin role does NOT have this permission; only owner does.
  | "admin:*";

export type Role = "owner" | "admin" | "manager" | "member" | "viewer";

// --- Role definitions with inheritance ---

interface RoleDefinition {
  permissions: Permission[];
  inherits?: Role[];
}

const ROLE_DEFINITIONS: Record<Role, RoleDefinition> = {
  viewer: {
    permissions: [
      "invoices:read",
      "expenses:read",
      "orders:read",
      "customers:read",
      "inventory:read",
      "hr:read",
      "accounting:read",
      "analytics:read",
      "users:read",
      "settings:read",
      // NOTE: billing:read is intentionally NOT granted to viewer.
      // Billing information (plan tier, payment methods, invoices) is sensitive
      // and is restricted to manager and above.
    ],
  },
  member: {
    inherits: ["viewer"],
    permissions: ["invoices:write", "expenses:write", "orders:write", "customers:write"],
  },
  manager: {
    inherits: ["member"],
    permissions: [
      "invoices:delete",
      "expenses:delete",
      "orders:delete",
      "customers:delete",
      "inventory:write",
      "hr:write",
      "billing:read",
      "reports:read",
      "api_keys:read",
      "webhooks:read",
    ],
  },
  admin: {
    inherits: ["manager"],
    permissions: [
      "accounting:write",
      "reports:create",
      "users:invite",
      "users:remove",
      "settings:write",
      "api_keys:write",
      "api_keys:delete",
      "webhooks:write",
      "webhooks:delete",
      "audit_logs:read",
    ],
  },
  owner: {
    inherits: ["admin"],
    permissions: [
      "users:manage_roles",
      "billing:manage",
      // Superuser wildcard: owner can do anything. admin role does NOT have this.
      "admin:*",
    ],
  },
};

// --- Permission resolution (with inheritance) ---

const _resolved = new Map<Role, Set<Permission>>();

function resolvePermissions(role: Role, visited = new Set<Role>()): Set<Permission> {
  if (_resolved.has(role)) return _resolved.get(role)!;
  if (visited.has(role)) return new Set();
  visited.add(role);

  const def = ROLE_DEFINITIONS[role];
  const perms = new Set<Permission>(def.permissions);

  for (const parent of def.inherits ?? []) {
    for (const p of resolvePermissions(parent, visited)) {
      perms.add(p);
    }
  }

  _resolved.set(role, perms);
  return perms;
}

// Pre-resolve all roles at module load time.
for (const role of Object.keys(ROLE_DEFINITIONS) as Role[]) {
  resolvePermissions(role);
}

// --- Public API ---

/**
 * Check if a role has the given permission (supports wildcard admin:*).
 * Unknown role strings return false (deny by default) and are logged as a
 * warning so data integrity issues are visible in the audit trail.
 */
export function hasPermission(role: Role | string, permission: Permission): boolean {
  if (!ROLE_DEFINITIONS[role as Role]) {
    logger.warn("hasPermission: unknown role encountered — denying access", {
      role,
      permission,
    });
    return false;
  }
  const perms = resolvePermissions(role as Role);
  return perms.has("admin:*") || perms.has(permission);
}

/** Get all permissions for a role. */
export function getPermissions(role: Role): Permission[] {
  return Array.from(resolvePermissions(role));
}

/** All defined roles. */
export const ROLES: Role[] = ["owner", "admin", "manager", "member", "viewer"];
