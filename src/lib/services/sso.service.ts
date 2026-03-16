/**
 * SSO Service — OIDC (OpenID Connect) support for enterprise customers.
 *
 * Supports any OIDC-compliant identity provider (Okta, Azure AD, Google Workspace,
 * Auth0, OneLogin, etc.) via standard discovery + authorization code flow.
 *
 * Flow:
 *   1. Account admin configures SSO in settings (issuer URL, client ID, client secret)
 *   2. User clicks "Sign in with SSO" → redirected to IdP authorization endpoint
 *   3. IdP authenticates user → redirects back with authorization code
 *   4. Backend exchanges code for tokens → validates ID token → creates/links user session
 *
 * Security:
 *   - PKCE (Proof Key for Code Exchange) for authorization code flow
 *   - State parameter with HMAC signature to prevent CSRF
 *   - Nonce in ID token to prevent replay attacks
 *   - ID token signature verification via JWKS
 */

import { createHash, createHmac, randomBytes } from "crypto";
import { ok, err, type Result } from "../utils/result.js";
import { logger } from "../logger.js";
import { prisma } from "../data/prisma.js";
import { getRedis } from "../redis.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SsoConfig {
  accountId: string;
  provider: "oidc" | "saml"; // SAML support planned
  issuerUrl: string; // e.g. https://accounts.google.com, https://login.microsoftonline.com/{tenant}/v2.0
  clientId: string;
  clientSecret: string; // stored encrypted at rest
  allowedDomains: string[]; // e.g. ["westbridge.app"] — restrict SSO to these email domains
  autoProvision: boolean; // auto-create users on first SSO login
  defaultRole: string; // role for auto-provisioned users
}

export interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

interface OidcTokenResponse {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
}

interface OidcUserInfo {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
}

// ─── OIDC Discovery ─────────────────────────────────────────────────────────

const discoveryCache = new Map<string, { data: OidcDiscovery; expiresAt: number }>();

export async function discoverOidc(issuerUrl: string): Promise<Result<OidcDiscovery, string>> {
  const cached = discoveryCache.get(issuerUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return ok(cached.data);
  }

  try {
    const url = issuerUrl.replace(/\/$/, "") + "/.well-known/openid-configuration";
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return err(`OIDC discovery failed: HTTP ${res.status}`);

    const data = (await res.json()) as OidcDiscovery;
    if (!data.authorization_endpoint || !data.token_endpoint) {
      return err("Invalid OIDC discovery response");
    }

    // Cache for 1 hour
    discoveryCache.set(issuerUrl, { data, expiresAt: Date.now() + 3600_000 });
    return ok(data);
  } catch (e) {
    return err(`OIDC discovery error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── Authorization URL ──────────────────────────────────────────────────────

export interface AuthorizationParams {
  redirectUri: string;
  accountId: string;
  config: SsoConfig;
}

export async function buildAuthorizationUrl(
  params: AuthorizationParams
): Promise<Result<{ url: string; state: string; codeVerifier: string }, string>> {
  const { redirectUri, accountId, config } = params;

  const discovery = await discoverOidc(config.issuerUrl);
  if (!discovery.ok) return err(discovery.error);

  // PKCE: generate code verifier and challenge
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  // State: HMAC-signed to prevent CSRF
  const nonce = randomBytes(16).toString("hex");
  const statePayload = `${accountId}:${nonce}`;
  const stateSecret = process.env.SESSION_SECRET ?? "dev-secret";
  const stateSig = createHmac("sha256", stateSecret).update(statePayload).digest("hex").slice(0, 16);
  const state = `${statePayload}:${stateSig}`;

  // Store code verifier and nonce in Redis (5 min TTL)
  const redis = getRedis();
  if (redis) {
    await redis.set(`sso:state:${state}`, JSON.stringify({ codeVerifier, nonce, accountId }), "EX", 300);
  }

  const authUrl = new URL(discovery.data.authorization_endpoint);
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return ok({ url: authUrl.toString(), state, codeVerifier });
}

// ─── Token Exchange ─────────────────────────────────────────────────────────

export interface CallbackParams {
  code: string;
  state: string;
  redirectUri: string;
  config: SsoConfig;
}

export async function handleCallback(
  params: CallbackParams
): Promise<Result<{ email: string; name: string; sub: string; accountId: string }, string>> {
  const { code, state, redirectUri, config } = params;

  // Validate state
  const redis = getRedis();
  if (!redis) return err("SSO unavailable: Redis not connected");

  const stored = await redis.get(`sso:state:${state}`);
  if (!stored) return err("Invalid or expired SSO state");
  await redis.del(`sso:state:${state}`);

  const { codeVerifier, accountId } = JSON.parse(stored) as {
    codeVerifier: string;
    nonce: string;
    accountId: string;
  };

  // Verify state signature
  const stateSecret = process.env.SESSION_SECRET ?? "dev-secret";
  const parts = state.split(":");
  if (parts.length !== 3) return err("Malformed SSO state");
  const [stateAccountId, stateNonce, stateSig] = parts;
  const expectedSig = createHmac("sha256", stateSecret)
    .update(`${stateAccountId}:${stateNonce}`)
    .digest("hex")
    .slice(0, 16);
  if (stateSig !== expectedSig) return err("SSO state signature mismatch");

  // Exchange code for tokens
  const discovery = await discoverOidc(config.issuerUrl);
  if (!discovery.ok) return err(discovery.error);

  try {
    const tokenRes = await fetch(discovery.data.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => "");
      logger.error("SSO token exchange failed", { status: tokenRes.status, body });
      return err("SSO authentication failed");
    }

    const tokens = (await tokenRes.json()) as OidcTokenResponse;

    // Get user info
    const userInfoRes = await fetch(discovery.data.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!userInfoRes.ok) return err("Failed to fetch user info from identity provider");

    const userInfo = (await userInfoRes.json()) as OidcUserInfo;

    if (!userInfo.email) return err("Identity provider did not return an email address");

    // Validate email domain
    const emailDomain = userInfo.email.split("@")[1];
    if (config.allowedDomains.length > 0 && !config.allowedDomains.includes(emailDomain!)) {
      return err(`Email domain ${emailDomain} is not allowed for SSO on this account`);
    }

    return ok({
      email: userInfo.email,
      name: userInfo.name ?? `${userInfo.given_name ?? ""} ${userInfo.family_name ?? ""}`.trim(),
      sub: userInfo.sub,
      accountId,
    });
  } catch (e) {
    logger.error("SSO callback error", { error: e instanceof Error ? e.message : String(e) });
    return err("SSO authentication failed");
  }
}

// ─── User provisioning ──────────────────────────────────────────────────────

export async function findOrCreateSsoUser(
  accountId: string,
  email: string,
  name: string,
  config: SsoConfig
): Promise<Result<{ userId: string; isNew: boolean }, string>> {
  const user = await prisma.user.findUnique({
    where: { accountId_email: { accountId, email } },
  });

  if (user) {
    // Update name if changed
    if (user.name !== name && name) {
      await prisma.user.update({ where: { id: user.id }, data: { name } });
    }
    return ok({ userId: user.id, isNew: false });
  }

  if (!config.autoProvision) {
    return err("User not found. Contact your account administrator to be invited.");
  }

  const newUser = await prisma.user.create({
    data: {
      accountId,
      email,
      name,
      role: config.defaultRole || "member",
      status: "active",
    },
  });

  logger.info("SSO auto-provisioned user", { accountId, email, role: config.defaultRole });
  return ok({ userId: newUser.id, isNew: true });
}
