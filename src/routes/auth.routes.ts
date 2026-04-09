/**
 * Express router for /api/auth/* routes.
 *
 * Thin routing layer — validation and HTTP concerns only.
 * All business logic lives in auth.controller.ts.
 *
 * Endpoints:
 *   - POST /api/auth/login
 *   - POST /api/auth/login/totp   (C1 fix — second-factor completion)
 *   - POST /api/auth/logout
 *   - GET  /api/auth/validate
 *   - POST /api/auth/forgot-password
 *   - POST /api/auth/reset-password
 *   - POST /api/auth/change-password
 */

import { Router } from "express";
import { requireCsrf, rateLimit } from "../middleware/auth.js";
import * as authController from "./auth.controller.js";

const router = Router();

router.post("/login", requireCsrf, (req, res) => authController.handleLogin(req, res));
// Rate limit /login/totp at the middleware level so static analysers
// (CodeQL js/missing-rate-limiting) and code reviewers can see the
// limit without inspecting the controller. Tier matches /api/auth/login
// per the security audit — same per-IP budget so the second factor
// inherits the brute-force ceiling of the password endpoint.
router.post("/login/totp", requireCsrf, rateLimit("anonymous", "/api/auth/login/totp"), (req, res) =>
  authController.handleLoginTotp(req, res),
);
router.post("/logout", requireCsrf, (req, res) => authController.handleLogout(req, res));
router.get("/validate", (req, res) => authController.handleValidate(req, res));
router.post("/forgot-password", requireCsrf, (req, res) => authController.handleForgotPassword(req, res));
router.post("/reset-password", requireCsrf, (req, res) => authController.handleResetPassword(req, res));
router.post("/change-password", requireCsrf, (req, res) => authController.handleChangePassword(req, res));

export default router;
