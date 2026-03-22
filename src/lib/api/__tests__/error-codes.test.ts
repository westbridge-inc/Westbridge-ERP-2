/**
 * Error codes tests (B6)
 */

import { describe, it, expect, vi } from "vitest";
import { ErrorCode, apiErrorResponse } from "../error-codes.js";

describe("ErrorCode", () => {
  it("contains all expected error codes", () => {
    expect(ErrorCode.VALIDATION_ERROR).toBe("VALIDATION_ERROR");
    expect(ErrorCode.UNAUTHORIZED).toBe("UNAUTHORIZED");
    expect(ErrorCode.FORBIDDEN).toBe("FORBIDDEN");
    expect(ErrorCode.NOT_FOUND).toBe("NOT_FOUND");
    expect(ErrorCode.RATE_LIMITED).toBe("RATE_LIMITED");
    expect(ErrorCode.CONFLICT).toBe("CONFLICT");
    expect(ErrorCode.PAYLOAD_TOO_LARGE).toBe("PAYLOAD_TOO_LARGE");
    expect(ErrorCode.AUTH_FAILED).toBe("AUTH_FAILED");
    expect(ErrorCode.SESSION_EXPIRED).toBe("SESSION_EXPIRED");
    expect(ErrorCode.ACCOUNT_LOCKED).toBe("ACCOUNT_LOCKED");
    expect(ErrorCode.SUBSCRIPTION_EXPIRED).toBe("SUBSCRIPTION_EXPIRED");
    expect(ErrorCode.INTERNAL_ERROR).toBe("INTERNAL_ERROR");
    expect(ErrorCode.SERVICE_UNAVAILABLE).toBe("SERVICE_UNAVAILABLE");
    expect(ErrorCode.BAD_GATEWAY).toBe("BAD_GATEWAY");
  });

  it("is readonly (values are string literals)", () => {
    const codes = Object.values(ErrorCode);
    expect(codes.every((c) => typeof c === "string")).toBe(true);
    expect(codes.length).toBeGreaterThan(10);
  });
});

describe("apiErrorResponse", () => {
  it("returns structured error with correct status", () => {
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    apiErrorResponse(res as never, 400, ErrorCode.VALIDATION_ERROR, "Invalid input");

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: { code: "VALIDATION_ERROR", message: "Invalid input" },
    });
  });

  it("works with 401 UNAUTHORIZED", () => {
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    apiErrorResponse(res as never, 401, ErrorCode.UNAUTHORIZED, "Not logged in");

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: { code: "UNAUTHORIZED", message: "Not logged in" },
    });
  });

  it("works with 500 INTERNAL_ERROR", () => {
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    apiErrorResponse(res as never, 500, ErrorCode.INTERNAL_ERROR, "Something went wrong");

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
    });
  });

  it("accepts custom string codes for backwards compatibility", () => {
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    apiErrorResponse(res as never, 502, "ERP_ERROR", "ERPNext unavailable");

    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: { code: "ERP_ERROR", message: "ERPNext unavailable" },
    });
  });
});
