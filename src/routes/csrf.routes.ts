import { Router, Request, Response } from "express";
import { generateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME, CSRF_MAX_AGE_SECONDS } from "../lib/csrf.js";
import { apiSuccess, apiMeta, getRequestId } from "../types/api.js";
import { COOKIE_SAME_SITE, COOKIE_SECURE } from "../lib/constants.js";
import { toWebRequest } from "../middleware/auth.js";

const router = Router();

/**
 * GET /csrf — returns a CSRF token and sets it in a cookie.
 * Call before login/signup/mutations; send the token in X-CSRF-Token header on POST.
 */
router.get("/csrf", (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const token = generateCsrfToken();

  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false, // client must read to send in header
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAME_SITE,
    maxAge: CSRF_MAX_AGE_SECONDS * 1000, // Express maxAge is in milliseconds
    path: "/",
  });

  res.set({
    "X-Response-Time": `${Date.now() - start}ms`,
    [CSRF_HEADER_NAME]: token,
  });

  return res.json(apiSuccess({ token }, apiMeta({ request_id: requestId })));
});

export default router;
