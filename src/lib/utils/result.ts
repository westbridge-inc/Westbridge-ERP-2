/**
 * Result type for service layer. No thrown exceptions for expected failures.
 *
 * Every service, API call, and domain operation returns a typed result.
 * This eliminates raw try/catch for business logic and makes error paths
 * explicit and type-checked at compile time.
 */

export type Result<T, E = Error> =
  | { ok: true; data: T }
  | { ok: false; error: E };

/**
 * Structured error for service/data layers.
 * Includes code, message, optional details, timestamp, and requestId
 * for end-to-end traceability.
 */
export interface AppError {
  code:
    | "VALIDATION"
    | "NOT_FOUND"
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "CONFLICT"
    | "RATE_LIMITED"
    | "UPSTREAM_ERROR"
    | "INTERNAL"
    | string;
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
  requestId?: string;
}

export function ok<T>(data: T): Result<T, never> {
  return { ok: true, data };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Create an AppError with auto-populated timestamp. */
export function appError(
  code: AppError["code"],
  message: string,
  opts?: { details?: Record<string, unknown>; requestId?: string },
): AppError {
  return {
    code,
    message,
    details: opts?.details,
    timestamp: new Date().toISOString(),
    requestId: opts?.requestId,
  };
}
