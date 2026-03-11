import { describe, it, expect } from "vitest";
import { ok, err, appError } from "../utils/result.js";
import type { Result, AppError } from "../utils/result.js";

describe("Result type helpers", () => {
  it("ok() creates a success result", () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(42);
  });

  it("err() creates an error result", () => {
    const result = err("something failed");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("something failed");
  });

  it("ok works with objects", () => {
    const result = ok({ id: "1", name: "test" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.id).toBe("1");
  });

  it("err works with AppError", () => {
    const error: AppError = {
      code: "NOT_FOUND",
      message: "Resource not found",
      timestamp: new Date().toISOString(),
    };
    const result: Result<never, AppError> = err(error);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toBe("Resource not found");
      expect(result.error.timestamp).toBeDefined();
    }
  });

  it("appError() factory creates AppError with auto timestamp", () => {
    const error = appError("VALIDATION", "Invalid input", {
      details: { field: "email" },
      requestId: "req-123",
    });
    expect(error.code).toBe("VALIDATION");
    expect(error.message).toBe("Invalid input");
    expect(error.details).toEqual({ field: "email" });
    expect(error.requestId).toBe("req-123");
    expect(error.timestamp).toBeDefined();
    expect(new Date(error.timestamp).getTime()).toBeGreaterThan(0);
  });

  it("ok with null data is valid", () => {
    const result = ok(null);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeNull();
  });

  it("ok with undefined data is valid", () => {
    const result = ok(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeUndefined();
  });
});
