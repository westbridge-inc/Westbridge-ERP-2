/**
 * ERP service: business logic for list and doc operations.
 *
 * Responsibilities beyond the data layer:
 * - Input validation (empty/blank params)
 * - Doctype allowlist enforcement
 * - Tenant scoping (accountId must be present for mutating operations)
 * - Structured logging for traceability
 *
 * The data layer (erpnext.client.ts) handles pure I/O: HTTP calls, retries,
 * response parsing. This service owns the business rules.
 */

import {
  erpList,
  erpGet,
  erpCreate,
  erpUpdate,
  erpDelete,
  type ListParams,
} from "../data/erpnext.client.js";
import { ALLOWED_DOCTYPES_SET } from "../erp-constants.js";
import { logger } from "../logger.js";
import type { Result } from "../utils/result.js";

const log = logger.child({ service: "erp" });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateDoctype(doctype: string | undefined | null): Result<string, string> {
  if (!doctype?.trim()) return { ok: false, error: "doctype required" };
  if (!ALLOWED_DOCTYPES_SET.has(doctype)) {
    return { ok: false, error: `Unsupported doctype: ${doctype}` };
  }
  return { ok: true, data: doctype };
}

function requireAccountId(accountId: string | undefined, operation: string): Result<string, string> {
  if (!accountId?.trim()) {
    return { ok: false, error: `accountId required for ${operation}` };
  }
  return { ok: true, data: accountId };
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * List ERP documents. erpnextCompany scopes results to that company (row-level security).
 */
export async function list(
  doctype: string,
  sessionId: string,
  params?: ListParams,
  accountId?: string,
  erpnextCompany?: string | null,
): Promise<Result<unknown[], string>> {
  const dtCheck = validateDoctype(doctype);
  if (!dtCheck.ok) return dtCheck;

  log.debug({ doctype, accountId, hasCompanyScope: !!erpnextCompany }, "erp.list");
  return erpList(doctype, sessionId, params, accountId, erpnextCompany);
}

export async function getDoc(
  doctype: string,
  name: string,
  sessionId: string,
  accountId?: string,
): Promise<Result<unknown, string>> {
  const dtCheck = validateDoctype(doctype);
  if (!dtCheck.ok) return dtCheck;
  if (!name?.trim()) return { ok: false, error: "doctype and name required" };

  log.debug({ doctype, name, accountId }, "erp.getDoc");
  return erpGet(doctype, name, sessionId, accountId);
}

export async function createDoc(
  doctype: string,
  sessionId: string,
  body: Record<string, unknown>,
  accountId?: string,
): Promise<Result<unknown, string>> {
  const dtCheck = validateDoctype(doctype);
  if (!dtCheck.ok) return dtCheck;

  const acctCheck = requireAccountId(accountId, "createDoc");
  if (!acctCheck.ok) return acctCheck;

  log.info({ doctype, accountId }, "erp.createDoc");
  return erpCreate(doctype, sessionId, body, accountId);
}

export async function updateDoc(
  doctype: string,
  name: string,
  sessionId: string,
  updates: Record<string, unknown>,
  accountId?: string,
): Promise<Result<unknown, string>> {
  const dtCheck = validateDoctype(doctype);
  if (!dtCheck.ok) return dtCheck;
  if (!name?.trim()) return { ok: false, error: "doctype and name required" };

  const acctCheck = requireAccountId(accountId, "updateDoc");
  if (!acctCheck.ok) return acctCheck;

  log.info({ doctype, name, accountId }, "erp.updateDoc");
  return erpUpdate(doctype, name, sessionId, updates, accountId);
}

export async function deleteDoc(
  doctype: string,
  name: string,
  sessionId: string,
  accountId?: string,
): Promise<Result<unknown, string>> {
  const dtCheck = validateDoctype(doctype);
  if (!dtCheck.ok) return dtCheck;
  if (!name?.trim()) return { ok: false, error: "doctype and name required" };

  const acctCheck = requireAccountId(accountId, "deleteDoc");
  if (!acctCheck.ok) return acctCheck;

  log.info({ doctype, name, accountId }, "erp.deleteDoc");
  return erpDelete(doctype, name, sessionId, accountId);
}
