/**
 * Express middleware that adds an X-Response-Time header to every response.
 *
 * Hooks into res.writeHead to set the header just before it's sent,
 * ensuring it's always present without triggering "headers already sent" errors.
 */

import type { Request, Response, NextFunction } from "express";

export function responseTime(_req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  // Monkey-patch writeHead to inject the header before it's sent
  const originalWriteHead = res.writeHead.bind(res);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.writeHead = function (statusCode: number, ...args: any[]) {
    if (!res.getHeader("X-Response-Time")) {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      res.setHeader("X-Response-Time", `${ms.toFixed(1)}ms`);
    }
    return originalWriteHead(statusCode, ...args);
  };

  next();
}
