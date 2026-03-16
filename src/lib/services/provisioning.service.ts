/**
 * ERPNext auto-provisioning service.
 * Creates an ERPNext company + user when a new Westbridge account is activated.
 *
 * This automates the manual step of creating an ERPNext company for each customer.
 * Called from billing.service.ts after payment is confirmed.
 */

import { ok, err, type Result } from "../utils/result.js";
import { prisma } from "../data/prisma.js";
import { logger } from "../logger.js";

const ERPNEXT_URL = process.env.ERPNEXT_URL ?? "http://localhost:8080";
const ERPNEXT_API_KEY = process.env.ERPNEXT_API_KEY ?? "";
const ERPNEXT_API_SECRET = process.env.ERPNEXT_API_SECRET ?? "";

function authHeaders(): Record<string, string> {
  if (ERPNEXT_API_KEY && ERPNEXT_API_SECRET) {
    return { Authorization: `token ${ERPNEXT_API_KEY}:${ERPNEXT_API_SECRET}` };
  }
  return {};
}

export interface ProvisionResult {
  companyName: string;
  erpnextUser: string;
}

/**
 * Provision an ERPNext company and user for a new account.
 * 1. Creates the Company doctype in ERPNext
 * 2. Creates a User in ERPNext linked to the account email
 * 3. Updates the Account record with the erpnextCompany name
 */
export async function provisionErpnextAccount(
  accountId: string,
): Promise<Result<ProvisionResult, string>> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { email: true, companyName: true, currency: true, country: true },
  });

  if (!account) return err("Account not found");

  const companyName = account.companyName;
  const abbr = companyName
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 5) || "WB";

  try {
    // 1. Create Company in ERPNext
    const companyRes = await fetch(`${ERPNEXT_URL}/api/resource/Company`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        data: {
          company_name: companyName,
          abbr,
          default_currency: account.currency ?? "GYD",
          country: account.country === "GY" ? "Guyana" : account.country,
          chart_of_accounts: "Standard",
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!companyRes.ok) {
      const text = await companyRes.text().catch(() => "");
      // Company may already exist — check for duplicate
      if (!text.includes("already exists")) {
        logger.error("ERPNext company creation failed", { status: companyRes.status, body: text.slice(0, 500) });
        return err("Failed to create ERPNext company");
      }
    }

    // 2. Create User in ERPNext
    const userRes = await fetch(`${ERPNEXT_URL}/api/resource/User`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        data: {
          email: account.email,
          first_name: companyName,
          send_welcome_email: 0,
          new_password: `WB-${Date.now()}-${Math.random().toString(36).slice(2)}`, // temp password, user resets via Westbridge
          roles: [
            { role: "System Manager" },
            { role: "Accounts Manager" },
            { role: "HR Manager" },
            { role: "Stock Manager" },
            { role: "Manufacturing Manager" },
            { role: "Projects Manager" },
          ],
          user_type: "System User",
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!userRes.ok) {
      const text = await userRes.text().catch(() => "");
      if (!text.includes("already exists")) {
        logger.warn("ERPNext user creation failed (non-fatal)", { status: userRes.status });
      }
    }

    // 3. Set default company for the user
    await fetch(`${ERPNEXT_URL}/api/resource/User/${encodeURIComponent(account.email)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        data: { defaults: { company: companyName } },
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});

    // 4. Update Westbridge account with ERPNext company name
    await prisma.account.update({
      where: { id: accountId },
      data: { erpnextCompany: companyName },
    });

    logger.info("ERPNext account provisioned", { accountId, companyName });
    return ok({ companyName, erpnextUser: account.email });
  } catch (e) {
    logger.error("ERPNext provisioning failed", {
      accountId,
      error: e instanceof Error ? e.message : String(e),
    });
    return err(e instanceof Error ? e.message : "Provisioning failed");
  }
}
