/**
 * Express router for /api/erp/* routes.
 *
 * Thin routing layer — middleware wiring only.
 * All business logic lives in erp.controller.ts.
 *
 * Endpoints:
 *   - GET    /erp/list
 *   - GET    /erp/doc
 *   - POST   /erp/doc
 *   - PUT    /erp/doc
 *   - DELETE /erp/doc
 *   - GET    /erp/dashboard
 */

import { Router } from "express";
import { requireAuth, requireCsrf, rateLimit } from "../middleware/auth.js";
import * as erpController from "./erp.controller.js";

const router = Router();

router.get("/erp/list", requireAuth, (req, res) => erpController.handleList(req, res));

router.get("/erp/doc", requireAuth, rateLimit("authenticated", "/api/erp/doc"), (req, res) =>
  erpController.handleGetDoc(req, res),
);

router.post("/erp/doc", requireAuth, requireCsrf, (req, res) => erpController.handleCreateDoc(req, res));

router.put("/erp/doc", requireAuth, requireCsrf, rateLimit("authenticated", "/api/erp/doc"), (req, res) =>
  erpController.handleUpdateDoc(req, res),
);

router.delete("/erp/doc", requireAuth, requireCsrf, rateLimit("authenticated", "/api/erp/doc"), (req, res) =>
  erpController.handleDeleteDoc(req, res),
);

router.get("/erp/dashboard", requireAuth, (req, res) => erpController.handleDashboard(req, res));

export default router;
