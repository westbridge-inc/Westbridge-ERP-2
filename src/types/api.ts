/**
 * Standard API response shape. Every endpoint returns this.
 */

import { randomUUID } from "crypto";

export interface ApiMeta {
  timestamp: string;
  request_id?: string;
  pagination?: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
  /** ERP list: page index (0-based), page size, and whether more pages exist */
  page?: number;
  pageSize?: number;
  hasMore?: boolean;
}

export interface ApiSuccess<T> {
  data: T;
  meta: ApiMeta;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, string>;
}

export interface ApiErrorResponse {
  error: ApiErrorBody;
  meta: ApiMeta;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiErrorResponse;

/** Every API response must include meta with timestamp and request_id. */
export function apiMeta(overrides?: Partial<ApiMeta>): ApiMeta {
  return {
    timestamp: new Date().toISOString(),
    request_id: overrides?.request_id ?? randomUUID(),
    ...overrides,
  };
}

/** Call from API routes: pass request_id from header or generate. */
export function getRequestId(request: Request): string {
  return request.headers.get("x-request-id") ?? randomUUID();
}

export function apiSuccess<T>(data: T, meta?: Partial<ApiMeta>): ApiSuccess<T> {
  return { data, meta: apiMeta(meta) };
}

export function apiError(
  code: string,
  message: string,
  details?: Record<string, string>,
  meta?: Partial<ApiMeta>
): ApiErrorResponse {
  return {
    error: { code, message, ...(details && { details }) },
    meta: apiMeta(meta),
  };
}
