/**
 * Express middleware that adds an X-Response-Time header to every response.
 *
 * Uses process.hrtime.bigint() for sub-millisecond precision. Skips setting
 * the header if it was already set by a route handler (e.g., health routes).
 *
 * Mount early in the middleware stack so the timer captures the full request
 * lifecycle.
 */

import type { Request, Response, NextFunction } from "express";

export function responseTime(_req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    // Don't override if already set by a route handler (e.g. health routes)
    if (!res.getHeader("X-Response-Time")) {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      res.setHeader("X-Response-Time", `${ms.toFixed(1)}ms`);
    }
  });

  next();
}
