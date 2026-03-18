/**
 * Structured error codes for the API.
 *
 * Every API error response should use one of these machine-readable codes.
 * Follows the pattern: { ok: false, error: { code: ErrorCode, message: string } }
 *
 * Usage:
 *   import { ErrorCode, apiErrorResponse } from "../lib/api/error-codes.js";
 *   return apiErrorResponse(res, 400, ErrorCode.VALIDATION_ERROR, "Invalid email");
 */

import type { Response } from "express";

export const ErrorCode = {
  // Client errors
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  CONFLICT: "CONFLICT",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",

  // Auth-specific
  AUTH_FAILED: "AUTH_FAILED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  SUBSCRIPTION_EXPIRED: "SUBSCRIPTION_EXPIRED",

  // Server errors
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  BAD_GATEWAY: "BAD_GATEWAY",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Helper to send a structured error response.
 * Ensures consistent shape: { ok: false, error: { code, message } }
 */
export function apiErrorResponse(
  res: Response,
  status: number,
  code: ErrorCodeValue | string,
  message: string,
): Response {
  return res.status(status).json({
    ok: false,
    error: { code, message },
  });
}
