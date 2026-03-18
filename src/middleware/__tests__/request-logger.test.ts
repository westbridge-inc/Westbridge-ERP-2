import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("../../lib/logger.js", () => ({
  logger: {
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { requestLogger } from "../request-logger.js";

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    method: "GET",
    path: "/api/health",
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  return {
    setHeader: vi.fn(),
  } as unknown as Response;
}

describe("requestLogger middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attaches req.log as a child logger", () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    requestLogger(req, res, next);

    expect(req.log).toBeDefined();
    expect(next).toHaveBeenCalled();
  });

  it("uses X-Request-ID header when provided", () => {
    const req = mockReq({
      headers: { "x-request-id": "custom-req-id" },
    });
    const res = mockRes();
    const next = vi.fn();

    requestLogger(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith("X-Request-ID", "custom-req-id");
    expect(next).toHaveBeenCalled();
  });

  it("generates a UUID when X-Request-ID is not provided", () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    requestLogger(req, res, next);

    const setHeaderCall = (res.setHeader as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(setHeaderCall[0]).toBe("X-Request-ID");
    // Should be a UUID-like string
    expect(typeof setHeaderCall[1]).toBe("string");
    expect(setHeaderCall[1].length).toBeGreaterThan(0);
  });
});
