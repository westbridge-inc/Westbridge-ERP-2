/**
 * Response time middleware tests 
 */

import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { responseTime } from "../response-time.js";

function mockRes(): Response {
  const res = {
    getHeader: vi.fn().mockReturnValue(undefined),
    setHeader: vi.fn(),
    writeHead: vi.fn(),
  } as unknown as Response;
  return res;
}

describe("responseTime middleware", () => {
  it("calls next immediately", () => {
    const req = {} as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    responseTime(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("patches writeHead to set X-Response-Time header", () => {
    const req = {} as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    responseTime(req, res, next);

    // Simulate Express calling writeHead
    res.writeHead(200);

    expect(res.setHeader).toHaveBeenCalledWith("X-Response-Time", expect.stringMatching(/^\d+(\.\d+)?ms$/));
  });

  it("does not override existing X-Response-Time header", () => {
    const req = {} as Request;
    const res = mockRes();
    (res.getHeader as ReturnType<typeof vi.fn>).mockReturnValue("50ms");
    const next = vi.fn() as unknown as NextFunction;

    responseTime(req, res, next);
    res.writeHead(200);

    expect(res.setHeader).not.toHaveBeenCalledWith("X-Response-Time", expect.anything());
  });
});
