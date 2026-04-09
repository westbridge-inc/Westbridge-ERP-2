/**
 * Express 5 async-error safety net regression tests.
 *
 * Audit finding M4 ("Async route handlers don't catch all rejections")
 * was raised against the Express 4 era pattern where an unhandled rejection
 * inside an async route handler would NOT be forwarded to the error
 * middleware — the request would simply hang and the rejection would
 * become a process-level unhandledRejection.
 *
 * Express 5 (which this codebase uses — see package.json `"express": "^5.0.1"`)
 * fixes this natively: any error thrown OR promise rejection bubbling out of
 * a route handler is automatically forwarded to the registered error
 * middleware. No `asyncHandler` wrapper is required.
 *
 * These tests lock in that contract so a future Express version bump (or
 * accidental downgrade) immediately fails CI rather than silently
 * regressing the safety net.
 */
import { describe, it, expect } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";

function buildAppWithStandardErrorHandler() {
  const app = express();
  app.use(express.json());

  // Async handler that throws (synchronous throw inside async function).
  app.get("/throw-sync", async (_req, _res) => {
    throw new Error("synchronous throw inside async handler");
  });

  // Async handler that returns a rejected promise (await rejection).
  app.get("/throw-await", async (_req, _res) => {
    await Promise.reject(new Error("rejected promise inside async handler"));
  });

  // Async handler that throws AFTER an await boundary — the trickiest case.
  app.get("/throw-after-await", async (_req, _res) => {
    await new Promise((r) => setTimeout(r, 1));
    throw new Error("throw after async hop");
  });

  // Async handler that calls a service which itself rejects.
  app.get("/nested-reject", async (_req, _res) => {
    const failingService = async () => {
      await new Promise((r) => setTimeout(r, 1));
      throw new Error("service-level failure");
    };
    await failingService();
  });

  // Same shape of error middleware as src/app.ts.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res
      .status(500)
      .json({ ok: false, error: { code: "SERVER_ERROR", message: "Internal server error" }, debug: err.message });
  });

  return app;
}

describe("Express 5 async error safety net (M4)", () => {
  const app = buildAppWithStandardErrorHandler();

  it("forwards a synchronous throw inside an async handler to the error middleware", async () => {
    const res = await request(app).get("/throw-sync");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("SERVER_ERROR");
    expect(res.body.debug).toContain("synchronous throw");
  });

  it("forwards a rejected awaited promise to the error middleware", async () => {
    const res = await request(app).get("/throw-await");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("SERVER_ERROR");
    expect(res.body.debug).toContain("rejected promise");
  });

  it("forwards a throw that happens AFTER an await boundary", async () => {
    const res = await request(app).get("/throw-after-await");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("SERVER_ERROR");
    expect(res.body.debug).toContain("after async hop");
  });

  it("forwards a rejection from a nested async service call", async () => {
    const res = await request(app).get("/nested-reject");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("SERVER_ERROR");
    expect(res.body.debug).toContain("service-level failure");
  });

  it("does NOT leave the request hanging (response time is bounded)", async () => {
    // Regression guard: in Express 4, an unhandled rejection in an async
    // handler would cause the request to hang until the supertest timeout
    // fired (~10s). Bound this test at 1s to catch a regression loudly.
    const start = Date.now();
    await request(app).get("/throw-sync");
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
