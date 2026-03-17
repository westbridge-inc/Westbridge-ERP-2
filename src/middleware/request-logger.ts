/**
 * Per-request logger context middleware.
 *
 * Creates a pino child logger bound to the current request ID and attaches
 * it to `req.log`. This ensures every log statement emitted during a request
 * automatically carries the request ID for end-to-end traceability.
 *
 * Must be mounted early in the middleware stack (after cookie-parser but
 * before route handlers).
 */

import { randomUUID } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { logger, type Logger } from "../lib/logger.js";

declare global {
  namespace Express {
    interface Request {
      log?: Logger;
    }
  }
}

/**
 * Middleware that creates a child logger with the request ID and attaches
 * it to `req.log`.
 */
export function requestLogger(req: Request, _res: Response, next: NextFunction): void {
  const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();

  req.log =
    typeof logger.child === "function" ? logger.child({ requestId, method: req.method, path: req.path }) : logger;

  next();
}
