/**
 * Response time middleware tests (B4)
 */

import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { EventEmitter } from "events";
import { responseTime } from "../response-time.js";

describe("responseTime middleware", () => {
  it("calls next immediately", () => {
    const req = {} as Request;
    const emitter = new EventEmitter();
    const res = Object.assign(emitter, {
      getHeader: vi.fn().mockReturnValue(undefined),
      setHeader: vi.fn(),
    }) as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    responseTime(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("sets X-Response-Time header on finish", () => {
    const req = {} as Request;
    const emitter = new EventEmitter();
    const res = Object.assign(emitter, {
      getHeader: vi.fn().mockReturnValue(undefined),
      setHeader: vi.fn(),
    }) as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    responseTime(req, res, next);
    emitter.emit("finish");

    expect(res.setHeader).toHaveBeenCalledWith("X-Response-Time", expect.stringMatching(/^\d+(\.\d+)?ms$/));
  });

  it("does not override existing X-Response-Time header", () => {
    const req = {} as Request;
    const emitter = new EventEmitter();
    const res = Object.assign(emitter, {
      getHeader: vi.fn().mockReturnValue("50ms"),
      setHeader: vi.fn(),
    }) as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    responseTime(req, res, next);
    emitter.emit("finish");

    expect(res.setHeader).not.toHaveBeenCalled();
  });
});
