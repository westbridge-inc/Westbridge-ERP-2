/**
 * Express middleware that sets the PostgreSQL session variable for RLS.
 * Must run after auth middleware (needs req.session.accountId).
 *
 * This ensures every authenticated request sets the RLS context in PostgreSQL,
 * even if individual queries miss a WHERE clause. The tenant context is set
 * using a parameterized query (tagged template) to prevent SQL injection.
 */

import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/data/prisma.js";
import { logger } from "../lib/logger.js";

export async function tenantContext(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const accountId = req.session?.accountId;

  if (accountId) {
    try {
      // Use tagged template literal (parameterized query) — NOT string interpolation
      await prisma.$executeRaw`SELECT set_config('app.current_account_id', ${accountId}, true)`;
      next();
    } catch (err) {
      logger.error("Failed to set tenant context for RLS", {
        accountId,
        error: err instanceof Error ? err.message : String(err),
      });
      next(err);
    }
  } else {
    next();
  }
}
