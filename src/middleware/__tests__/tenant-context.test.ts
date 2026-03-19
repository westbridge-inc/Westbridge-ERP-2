/**
 * Tenant context middleware tests (B1)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    $executeRaw: vi.fn().mockResolvedValue(0),
  },
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { tenantContext } from "../tenant-context.js";
import { prisma } from "../../lib/data/prisma.js";

describe("tenantContext middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets tenant context when session has accountId", async () => {
    const req = { session: { accountId: "acc-123" } } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as unknown as NextFunction;

    await tenantContext(req, res, next);

    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it("calls next() without setting context when no session", async () => {
    const req = {} as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as unknown as NextFunction;

    await tenantContext(req, res, next);

    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it("calls next() without setting context when session has no accountId", async () => {
    const req = { session: {} } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as unknown as NextFunction;

    await tenantContext(req, res, next);

    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it("logs warning and continues when prisma fails", async () => {
    const error = new Error("DB connection lost");
    vi.mocked(prisma.$executeRaw).mockRejectedValueOnce(error);

    const req = { session: { accountId: "acc-123" } } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as unknown as NextFunction;

    await tenantContext(req, res, next);

    // RLS is defense-in-depth — failure should not block the request
    expect(next).toHaveBeenCalledWith();
    const { logger } = await import("../../lib/logger.js");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("uses parameterized query (not string interpolation)", async () => {
    const req = { session: { accountId: "acc-123'; DROP TABLE users; --" } } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as unknown as NextFunction;

    await tenantContext(req, res, next);

    // The tagged template literal should be used (not $executeRawUnsafe)
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });
});
