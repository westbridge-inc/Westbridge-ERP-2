const DEV_LOCAL_SESSION = "dev-local-session";
/**
 * Data layer: ERPNext API client. Pure I/O; no business logic or formatting.
 * All ERPNext communication in the app goes through this client.
 */

import { Agent } from "undici";
import { Result, ok, err } from "../utils/result.js";

// Persistent HTTP agent with keepalive — reuses TCP+TLS connections to ERPNext.
// Without this, every request pays ~50ms for TCP handshake + TLS negotiation.
// With keepalive, subsequent requests drop to ~10ms (just the query time).
const erpAgent = new Agent({
  keepAliveTimeout: 30_000, // Keep connections alive for 30s between requests
  keepAliveMaxTimeout: 60_000,
  connections: 20, // Pool size per origin
});

// Validate ERPNEXT_URL at module load in production to fail fast rather than
// silently sending credentials over plain HTTP. Skip during Next.js build phase.
const ERPNEXT_URL = (() => {
  const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";
  const url = process.env.ERPNEXT_URL;
  if (!url) {
    if (process.env.NODE_ENV === "production" && !isBuildPhase) {
      throw new Error("ERPNEXT_URL environment variable is required in production");
    }
    return "http://localhost:8080";
  }
  if (process.env.NODE_ENV === "production" && !isBuildPhase && !url.startsWith("https://")) {
    throw new Error("ERPNEXT_URL must use HTTPS in production");
  }
  return url;
})();

const ACCOUNT_HEADER = "X-Westbridge-Account-Id";

const RETRYABLE_STATUSES = new Set([502, 503, 429]);
const MAX_ATTEMPTS = 2;
const BACKOFF_BASE_MS = 300;

function isRetryable(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchErp(
  endpoint: string,
  sessionId: string | undefined,
  options?: RequestInit,
  accountId?: string,
): Promise<Result<unknown, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string>),
  };
  // In dev mode with local auth fallback, use API key/secret instead of user SID
  const apiKey = process.env.ERPNEXT_API_KEY;
  const apiSecret = process.env.ERPNEXT_API_SECRET;
  if (sessionId && sessionId !== DEV_LOCAL_SESSION) {
    headers["Cookie"] = `sid=${sessionId}`;
  } else if (apiKey && apiSecret) {
    headers["Authorization"] = `token ${apiKey}:${apiSecret}`;
  }
  if (accountId) headers[ACCOUNT_HEADER] = accountId;

  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${ERPNEXT_URL}/api${endpoint}`, {
        ...options,
        headers,
        signal: AbortSignal.timeout(5_000),
        dispatcher: erpAgent,
      } as RequestInit & { dispatcher: Agent });
      if (res.ok) {
        const data = await res.json();
        return ok(data);
      }
      // 404 from ERPNext means the doctype doesn't exist (e.g. HRMS not installed)
      // or no records — treat as empty result, not an error
      if (res.status === 404) {
        return ok({ data: [] });
      }
      lastError = "Unable to connect to your business data. Please try again.";
      if (!isRetryable(res.status)) return err(lastError);
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(BACKOFF_BASE_MS * (attempt + 1));
      }
    } catch (e) {
      lastError = "Unable to connect to your business data. Please try again.";
      const isNetworkError = e instanceof TypeError || (e instanceof DOMException && e.name === "TimeoutError");
      if (!isNetworkError || attempt === MAX_ATTEMPTS - 1) return err(lastError);
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(BACKOFF_BASE_MS * (attempt + 1));
      }
    }
  }
  return err(lastError);
}

export interface ListParams {
  limit_page_length?: string;
  limit_start?: string;
  order_by?: string;
  fields?: string;
  filters?: string;
}

/**
 * List ERP documents. When erpnextCompany is provided the results are scoped
 * to that company via a Frappe filters clause — enforcing tenant isolation.
 */
export async function erpList(
  doctype: string,
  sessionId: string,
  params?: ListParams,
  accountId?: string,
  erpnextCompany?: string | null,
): Promise<Result<unknown[], string>> {
  const queryParams: Record<string, string> = {
    limit_page_length: "20",
    order_by: "creation desc",
    ...params,
  };

  if (erpnextCompany) {
    // Merge company filter with any existing filters.
    // Wrap JSON.parse in try/catch: a malformed filters string must return a
    // clean Result error rather than an unhandled exception.
    let existingFilters: unknown[][] = [];
    if (params?.filters) {
      try {
        const parsed = JSON.parse(params.filters);
        existingFilters = Array.isArray(parsed) ? parsed : [];
      } catch {
        return err("Invalid filters parameter: must be a valid JSON array");
      }
    }
    const companyFilter: unknown[] = [doctype, "company", "=", erpnextCompany];
    const merged = [...existingFilters, companyFilter];
    queryParams.filters = JSON.stringify(merged);
  } else if (params?.filters) {
    // Validate filters JSON even when no company scope is added.
    try {
      JSON.parse(params.filters);
    } catch {
      return err("Invalid filters parameter: must be a valid JSON array");
    }
  }

  const query = new URLSearchParams(queryParams).toString();
  // encodeURIComponent(doctype) prevents path traversal/injection when doctype
  // contains URL metacharacters (e.g. slashes, question marks). ERPNext doctypes
  // with spaces (e.g. "Sales Invoice") are encoded as "Sales%20Invoice".
  const result = await fetchErp(`/resource/${encodeURIComponent(doctype)}?${query}`, sessionId, undefined, accountId);
  if (!result.ok) return err(result.error);
  const body = result.data as { data?: unknown[] };
  return ok(Array.isArray(body?.data) ? body.data : []);
}

export async function erpGet(
  doctype: string,
  name: string,
  sessionId: string,
  accountId?: string,
): Promise<Result<unknown, string>> {
  const result = await fetchErp(
    `/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
    sessionId,
    undefined,
    accountId,
  );
  if (!result.ok) return err(result.error);
  const body = result.data as { data?: unknown };
  return body?.data !== null && body?.data !== undefined ? ok(body.data) : err("Not found");
}

export async function erpCreate(
  doctype: string,
  sessionId: string,
  body: Record<string, unknown>,
  accountId?: string,
): Promise<Result<unknown, string>> {
  return fetchErp(
    `/resource/${encodeURIComponent(doctype)}`,
    sessionId,
    { method: "POST", body: JSON.stringify(body) },
    accountId,
  );
}

export async function erpUpdate(
  doctype: string,
  name: string,
  sessionId: string,
  updates: Record<string, unknown>,
  accountId?: string,
): Promise<Result<unknown, string>> {
  return fetchErp(
    `/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
    sessionId,
    { method: "PUT", body: JSON.stringify(updates) },
    accountId,
  );
}

export async function erpDelete(
  doctype: string,
  name: string,
  sessionId: string,
  accountId?: string,
): Promise<Result<unknown, string>> {
  return fetchErp(
    `/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
    sessionId,
    { method: "DELETE" },
    accountId,
  );
}
