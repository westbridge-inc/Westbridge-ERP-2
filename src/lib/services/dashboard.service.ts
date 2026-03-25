/**
 * Dashboard service: aggregates ERP data into dashboard metrics.
 *
 * Extracted from erp.routes.ts to keep route handlers thin and business
 * logic testable in isolation.
 */

import { list } from "./erp.service.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RevenuePoint {
  month: string;
  value: number;
}

export interface ActivityItem {
  text: string;
  time: string;
  type: "success" | "error" | "info" | "default";
}

export interface DashboardPayload {
  revenueMTD: number;
  revenueChange: number;
  outstandingCount: number;
  openDealsCount: number;
  employeeCount: number;
  employeeDelta: number;
  revenueData: RevenuePoint[];
  activity: ActivityItem[];
  /** True when backend data service is unreachable. */
  isOffline?: boolean;
}

// ─── Empty state fallback (no fake data — if it's 0, it's 0) ────────────────

export const EMPTY_DATA: DashboardPayload = {
  revenueMTD: 0,
  revenueChange: 0,
  outstandingCount: 0,
  openDealsCount: 0,
  employeeCount: 0,
  employeeDelta: 0,
  revenueData: [],
  activity: [],
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatRelativeTime(dateStr: string): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ─── Main aggregation ───────────────────────────────────────────────────────

export async function buildDashboardData(
  sessionId: string,
  accountId: string,
  erpnextCompany: string | null,
): Promise<DashboardPayload> {
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);

  // Parallel ERP fetches — any individual failure falls back gracefully
  const [invoicesRes, ordersRes, employeesRes] = await Promise.allSettled([
    list("Sales Invoice", sessionId, { limit_page_length: "100" }, accountId, erpnextCompany),
    list(
      "Sales Order",
      sessionId,
      {
        limit_page_length: "50",
        filters: JSON.stringify([
          ["Sales Order", "status", "in", ["Draft", "To Deliver and Bill", "To Bill", "To Deliver"]],
        ]),
      },
      accountId,
      erpnextCompany,
    ),
    list(
      "Employee",
      sessionId,
      {
        limit_page_length: "100",
        fields: JSON.stringify(["name", "date_of_joining", "status"]),
      },
      accountId,
      erpnextCompany,
    ),
  ]);

  // If all three calls failed, bail out to demo data
  const anySucceeded = [invoicesRes, ordersRes, employeesRes].some((r) => r.status === "fulfilled" && r.value.ok);
  if (!anySucceeded) return EMPTY_DATA;

  // Revenue MTD — sum paid invoices this month
  const invoices =
    invoicesRes.status === "fulfilled" && invoicesRes.value.ok
      ? (invoicesRes.value.data as Record<string, unknown>[])
      : [];

  let revenueMTD = 0;
  let outstandingCount = 0;

  for (const inv of invoices) {
    const status = String(inv.status ?? "");
    const postingDate = String(inv.posting_date ?? "");
    const grandTotal = Number(inv.grand_total ?? 0);

    if (status === "Paid" && postingDate >= firstOfMonth) {
      revenueMTD += grandTotal;
    }
    if (status === "Unpaid" || status === "Overdue") {
      outstandingCount++;
    }
  }

  // 6-month revenue trend
  const revenueByMonth: Record<string, number> = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    revenueByMonth[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`] = 0;
  }
  for (const inv of invoices) {
    if (String(inv.status ?? "") !== "Paid") continue;
    const month = String(inv.posting_date ?? "").slice(0, 7);
    if (month in revenueByMonth) {
      revenueByMonth[month] += Number(inv.grand_total ?? 0);
    }
  }
  const revenueData: RevenuePoint[] = Object.entries(revenueByMonth).map(([key, val]) => {
    const [, m] = key.split("-");
    return {
      month: MONTH_LABELS[parseInt(m, 10) - 1],
      value: parseFloat((val / 1_000_000).toFixed(2)),
    };
  });

  // Revenue change (last month vs month before)
  const monthValues = Object.values(revenueByMonth);
  const prevMonth = monthValues[monthValues.length - 2] ?? 0;
  const currMonth = monthValues[monthValues.length - 1] ?? 0;
  const revenueChange = prevMonth > 0 ? Math.round(((currMonth - prevMonth) / prevMonth) * 100) : 0;

  // Open sales orders
  const openDealsCount =
    ordersRes.status === "fulfilled" && ordersRes.value.ok
      ? (ordersRes.value.data as unknown[]).length
      : EMPTY_DATA.openDealsCount;

  // Employee count (active employees only)
  const employees =
    employeesRes.status === "fulfilled" && employeesRes.value.ok
      ? (employeesRes.value.data as Record<string, unknown>[])
      : [];
  const activeEmployees = employees.filter((e) => String(e.status ?? "") !== "Left");
  const employeeCount = activeEmployees.length || EMPTY_DATA.employeeCount;

  // Delta: employees who joined this month
  const employeeDelta = activeEmployees.filter((e) => {
    const joined = String(e.date_of_joining ?? "");
    return joined >= firstOfMonth;
  }).length;

  // Activity feed — recent invoices + orders
  const activityItems: ActivityItem[] = [];
  for (const inv of invoices.slice(0, 8)) {
    const status = String(inv.status ?? "");
    if (status === "Paid") {
      activityItems.push({
        text: `Invoice ${String(inv.name ?? "")} paid — $${Number(inv.grand_total ?? 0).toLocaleString()}`,
        time: formatRelativeTime(String(inv.modified ?? inv.creation ?? "")),
        type: "success",
      });
    } else if (status === "Overdue") {
      activityItems.push({
        text: `Invoice ${String(inv.name ?? "")} overdue — $${Number(inv.outstanding_amount ?? inv.grand_total ?? 0).toLocaleString()}`,
        time: formatRelativeTime(String(inv.modified ?? inv.creation ?? "")),
        type: "error",
      });
    }
  }

  const isOffline = !anySucceeded;

  return {
    revenueMTD,
    revenueChange,
    outstandingCount,
    openDealsCount,
    employeeCount,
    employeeDelta,
    revenueData,
    activity:
      activityItems.length > 0
        ? activityItems.slice(0, 5)
        : invoices.length > 0
          ? invoices.slice(0, 5).map((inv) => ({
              text: `Invoice ${String(inv.name ?? "")} — ${String(inv.status ?? "Draft")} — $${Number(inv.grand_total ?? 0).toLocaleString()}`,
              time: formatRelativeTime(String(inv.modified ?? inv.creation ?? "")),
              type: "info" as const,
            }))
          : [],
    isOffline,
  };
}
