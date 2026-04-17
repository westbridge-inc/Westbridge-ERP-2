/**
 * SSO routes — OIDC authentication for enterprise accounts.
 *
 * GET  /sso/authorize   — Redirect to identity provider
 * GET  /sso/callback     — Handle IdP callback, create session
 * GET  /sso/config       — Get SSO config for current account (admin only)
 * PUT  /sso/config       — Update SSO config (admin only)
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth, requirePermission, requireCsrf, rateLimit, toWebRequest } from "../middleware/auth.js";
import { apiSuccess, apiError, apiMeta, getRequestId } from "../types/api.js";
import { logAudit, auditContext } from "../lib/services/audit.service.js";
import {
  buildAuthorizationUrl,
  handleCallback,
  findOrCreateSsoUser,
  type SsoConfig,
} from "../lib/services/sso.service.js";
import { createSession } from "../lib/services/session.service.js";
import { encrypt, decrypt, ENCRYPTION_CONTEXT } from "../lib/encryption.js";
import { prismaAdmin } from "../lib/data/prisma-admin.js";
import { COOKIE, COOKIE_SAME_SITE, COOKIE_SECURE } from "../lib/constants.js";

const router = Router();

// ─── Schemas ────────────────────────────────────────────────────────────────

const ssoConfigSchema = z.object({
  provider: z.enum(["oidc"]),
  issuerUrl: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  allowedDomains: z.array(z.string()).default([]),
  autoProvision: z.boolean().default(true),
  defaultRole: z.enum(["admin", "member", "viewer"]).default("member"),
});

// ─── Helper: load SSO config from PostgreSQL (Blocker #11 — migrated from Redis) ──

async function loadSsoConfig(accountId: string): Promise<SsoConfig | null> {
  const row = await prismaAdmin.ssoConfig.findUnique({ where: { accountId } });
  if (!row) return null;
  try {
    return {
      accountId: row.accountId,
      provider: row.provider as "oidc",
      issuerUrl: row.issuerUrl,
      clientId: row.clientId,
      // AAD-bound to accountId on v1 envelopes; v0 legacy still decrypts.
      clientSecret: decrypt(row.clientSecret, ENCRYPTION_CONTEXT.ssoClientSecret(accountId)),
      allowedDomains: row.allowedDomains,
      autoProvision: row.autoProvision,
      defaultRole: row.defaultRole,
    };
  } catch {
    return null;
  }
}

async function saveSsoConfig(config: SsoConfig): Promise<void> {
  // AAD-bind clientSecret to accountId so an attacker who gains write access
  // to sso_configs cannot copy a client secret onto another account's row.
  const aad = ENCRYPTION_CONTEXT.ssoClientSecret(config.accountId);
  await prismaAdmin.ssoConfig.upsert({
    where: { accountId: config.accountId },
    update: {
      provider: config.provider,
      issuerUrl: config.issuerUrl,
      clientId: config.clientId,
      clientSecret: encrypt(config.clientSecret, aad),
      allowedDomains: config.allowedDomains,
      autoProvision: config.autoProvision,
      defaultRole: config.defaultRole,
    },
    create: {
      accountId: config.accountId,
      provider: config.provider,
      issuerUrl: config.issuerUrl,
      clientId: config.clientId,
      clientSecret: encrypt(config.clientSecret, aad),
      allowedDomains: config.allowedDomains,
      autoProvision: config.autoProvision,
      defaultRole: config.defaultRole,
    },
  });
}

// ─── GET /sso/authorize ─────────────────────────────────────────────────────

router.get("/sso/authorize", rateLimit("anonymous", "/api/sso/authorize"), async (req: Request, res: Response) => {
  const accountId = req.query.account_id as string;
  if (!accountId) {
    return res.status(400).json(apiError("VALIDATION", "account_id query parameter required"));
  }

  const config = await loadSsoConfig(accountId);
  if (!config) {
    return res.status(404).json(apiError("NOT_FOUND", "SSO is not configured for this account"));
  }

  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/auth/sso/callback`;

  const result = await buildAuthorizationUrl({ redirectUri, accountId, config });
  if (!result.ok) {
    return res.status(500).json(apiError("SSO_ERROR", result.error));
  }

  // ── Open redirect protection ────────────────────────────────────────
  // The authorization URL is built from config.issuerUrl (admin-set) via
  // OIDC discovery. Verify the final URL's hostname matches the configured
  // issuerUrl's hostname AND uses HTTPS, to prevent a compromised discovery
  // document or tampered config from redirecting users to an attacker domain.
  try {
    const authUrl = new URL(result.data.url);
    const issuerUrl = new URL(config.issuerUrl);
    if (authUrl.protocol !== "https:") {
      return res.status(500).json(apiError("SSO_ERROR", "SSO authorization endpoint must use HTTPS"));
    }
    if (authUrl.hostname !== issuerUrl.hostname) {
      return res
        .status(500)
        .json(apiError("SSO_ERROR", "SSO authorization endpoint hostname does not match configured issuer"));
    }
  } catch {
    return res.status(500).json(apiError("SSO_ERROR", "Invalid SSO authorization URL"));
  }

  // Sanitized above: hostname validated against admin-set issuerUrl + HTTPS enforced
  // nosemgrep: javascript.express.web.tainted-redirect-express.tainted-redirect-express
  // nosemgrep: javascript.express.open-redirect-deepsemgrep.open-redirect-deepsemgrep
  return res.redirect(result.data.url);
});

// ─── GET /sso/callback ──────────────────────────────────────────────────────

router.get("/sso/callback", async (req: Request, res: Response) => {
  const { code, state, error: idpError } = req.query as Record<string, string>;

  if (idpError) {
    return res.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/login?error=sso_denied`);
  }

  if (!code || !state) {
    return res.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/login?error=sso_invalid`);
  }

  // Extract accountId from state
  const accountId = state.split(":")[0];
  if (!accountId) {
    return res.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/login?error=sso_invalid`);
  }

  const config = await loadSsoConfig(accountId);
  if (!config) {
    return res.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/login?error=sso_not_configured`);
  }

  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/auth/sso/callback`;

  const callbackResult = await handleCallback({ code, state, redirectUri, config });
  if (!callbackResult.ok) {
    return res.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/login?error=sso_failed`);
  }

  const { email, name } = callbackResult.data;
  const ctx = auditContext(toWebRequest(req));

  // Find or create user
  const userResult = await findOrCreateSsoUser(accountId, email, name, config);
  if (!userResult.ok) {
    logAudit({
      accountId,
      action: "sso.login.user_not_found",
      meta: { email },
      ...ctx,
      severity: "warn",
      outcome: "failure",
    }).catch((err: any) => console.error("Background task failed", err));
    return res.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/login?error=sso_user_not_found`);
  }

  // Create session
  const sessionResult = await createSession(userResult.data.userId, toWebRequest(req), null);
  if (!sessionResult.ok) {
    return res.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/login?error=session_failed`);
  }

  const { token, expiresAt } = sessionResult.data;
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));

  logAudit({
    accountId,
    userId: userResult.data.userId,
    action: "sso.login.success",
    meta: { email, isNew: userResult.data.isNew },
    ...ctx,
    severity: "info",
    outcome: "success",
  }).catch((err: any) => console.error("Background task failed", err));

  res.cookie(COOKIE.SESSION_NAME, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAME_SITE,
    maxAge: maxAge * 1000,
    path: "/",
  });

  return res.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard`);
});

// ─── GET /sso/config (admin only) ───────────────────────────────────────────

router.get("/sso/config", requireAuth, requirePermission("admin:*"), async (req: Request, res: Response) => {
  const requestId = getRequestId(toWebRequest(req));
  const session = req.session!;

  const config = await loadSsoConfig(session.accountId);
  if (!config) {
    return res.json(apiSuccess({ configured: false }, apiMeta({ request_id: requestId })));
  }

  // Never return the client secret
  return res.json(
    apiSuccess(
      {
        configured: true,
        provider: config.provider,
        issuerUrl: config.issuerUrl,
        clientId: config.clientId,
        allowedDomains: config.allowedDomains,
        autoProvision: config.autoProvision,
        defaultRole: config.defaultRole,
      },
      apiMeta({ request_id: requestId }),
    ),
  );
});

// ─── PUT /sso/config (admin only) ───────────────────────────────────────────

router.put(
  "/sso/config",
  requireAuth,
  requireCsrf,
  requirePermission("admin:*"),
  async (req: Request, res: Response) => {
    const requestId = getRequestId(toWebRequest(req));
    const session = req.session!;
    const ctx = auditContext(toWebRequest(req));

    const parsed = ssoConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json(
          apiError(
            "VALIDATION",
            parsed.error.flatten().fieldErrors.toString(),
            undefined,
            apiMeta({ request_id: requestId }),
          ),
        );
    }

    const config: SsoConfig = {
      accountId: session.accountId,
      ...parsed.data,
    };

    try {
      await saveSsoConfig(config);

      logAudit({
        accountId: session.accountId,
        userId: session.userId,
        action: "sso.config.updated",
        meta: { provider: config.provider, issuerUrl: config.issuerUrl },
        ...ctx,
        severity: "info",
        outcome: "success",
      }).catch((err: any) => console.error("Background task failed", err));

      return res.json(apiSuccess({ configured: true }, apiMeta({ request_id: requestId })));
    } catch {
      return res
        .status(500)
        .json(
          apiError("SERVER_ERROR", "Failed to save SSO configuration", undefined, apiMeta({ request_id: requestId })),
        );
    }
  },
);

export default router;
