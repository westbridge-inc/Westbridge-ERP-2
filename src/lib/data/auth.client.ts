/**
 * Data layer: ERPNext login (session). Pure I/O.
 */

import { Result, ok, err } from "../utils/result.js";

const ERPNEXT_URL = process.env.ERPNEXT_URL || "http://localhost:8080";

export async function erpLogin(email: string, password: string): Promise<Result<string, string>> {
  try {
    const res = await fetch(`${ERPNEXT_URL}/api/method/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usr: email, pwd: password }),
    });
    if (!res.ok) return err("Invalid credentials");

    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) return err("No session returned");

    const match = setCookie.match(/sid=([^;]+)/);
    if (!match) return err("No session returned");

    return ok(match[1]);
  } catch (_e) {
    return err("Unable to verify your credentials right now. Please try again.");
  }
}
