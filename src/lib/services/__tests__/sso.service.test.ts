import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SSO state HMAC is HKDF-derived from SESSION_SECRET (≥32 chars required).
// Stub before importing the service so the cached state key is initialised
// against a real value rather than failing-closed on first use.
vi.stubEnv("SESSION_SECRET", "test-session-secret-at-least-32-characters-long-for-hkdf");

const mockRedis = {
  set: vi.fn().mockResolvedValue("OK"),
  get: vi.fn(),
  del: vi.fn().mockResolvedValue(1),
};

vi.mock("../../redis.js", () => ({
  getRedis: vi.fn(() => mockRedis),
}));

vi.mock("../../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../data/prisma-admin.js", () => ({
  prismaAdmin: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import {
  discoverOidc,
  buildAuthorizationUrl,
  handleCallback,
  findOrCreateSsoUser,
  _resetSsoStateKeyCacheForTests,
  type SsoConfig,
} from "../sso.service.js";
import { prismaAdmin } from "../../data/prisma-admin.js";

const mockConfig: SsoConfig = {
  accountId: "acc_1",
  provider: "oidc",
  issuerUrl: "https://accounts.example.com",
  clientId: "client_123",
  clientSecret: "secret_456",
  allowedDomains: ["example.com"],
  autoProvision: true,
  defaultRole: "member",
};

describe("sso.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset global fetch mock
    vi.restoreAllMocks();
    // Re-stub SESSION_SECRET after restoreAllMocks (which clears env stubs).
    vi.stubEnv("SESSION_SECRET", "test-session-secret-at-least-32-characters-long-for-hkdf");
    _resetSsoStateKeyCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetSsoStateKeyCacheForTests();
  });

  describe("discoverOidc", () => {
    it("fetches OIDC discovery document", async () => {
      const mockDiscovery = {
        authorization_endpoint: "https://accounts.example.com/authorize",
        token_endpoint: "https://accounts.example.com/token",
        userinfo_endpoint: "https://accounts.example.com/userinfo",
        jwks_uri: "https://accounts.example.com/.well-known/jwks.json",
        issuer: "https://accounts.example.com",
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockDiscovery),
      }) as any;

      const result = await discoverOidc("https://accounts.example.com");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.authorization_endpoint).toBe("https://accounts.example.com/authorize");
      }
    });

    it("returns error on HTTP failure", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }) as any;

      const result = await discoverOidc("https://bad.example.com");
      expect(result.ok).toBe(false);
    });

    it("returns error on invalid discovery", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ issuer: "test" }), // missing endpoints
      }) as any;

      const result = await discoverOidc("https://incomplete.example.com");
      expect(result.ok).toBe(false);
    });
  });

  describe("buildAuthorizationUrl", () => {
    it("builds authorization URL", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            authorization_endpoint: "https://accounts.example.com/authorize",
            token_endpoint: "https://accounts.example.com/token",
            userinfo_endpoint: "https://accounts.example.com/userinfo",
            jwks_uri: "https://accounts.example.com/jwks",
            issuer: "https://accounts.example.com",
          }),
      }) as any;

      const result = await buildAuthorizationUrl({
        redirectUri: "http://localhost:3000/api/auth/sso/callback",
        accountId: "acc_1",
        config: mockConfig,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.url).toContain("accounts.example.com/authorize");
        expect(result.data.url).toContain("client_123");
        expect(result.data.state).toBeTruthy();
        expect(result.data.codeVerifier).toBeTruthy();
      }
    });
  });

  describe("handleCallback", () => {
    it("returns error when Redis not available", async () => {
      const { getRedis } = await import("../../redis.js");
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

      const result = await handleCallback({
        code: "code_123",
        state: "acc_1:nonce:sig",
        redirectUri: "http://localhost:3000/callback",
        config: mockConfig,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Redis");
    });

    it("returns error for expired state", async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await handleCallback({
        code: "code_123",
        state: "acc_1:nonce:sig",
        redirectUri: "http://localhost:3000/callback",
        config: mockConfig,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("expired");
    });
  });

  describe("findOrCreateSsoUser", () => {
    it("returns existing user", async () => {
      (prismaAdmin.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "usr_1",
        name: "John",
        email: "john@example.com",
      });

      const result = await findOrCreateSsoUser("acc_1", "john@example.com", "John", mockConfig);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.userId).toBe("usr_1");
        expect(result.data.isNew).toBe(false);
      }
    });

    it("updates name if changed", async () => {
      (prismaAdmin.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "usr_1",
        name: "Old Name",
        email: "john@example.com",
      });

      const result = await findOrCreateSsoUser("acc_1", "john@example.com", "New Name", mockConfig);
      expect(result.ok).toBe(true);
      expect(prismaAdmin.user.update).toHaveBeenCalled();
    });

    it("creates new user when auto-provision enabled", async () => {
      (prismaAdmin.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prismaAdmin.user.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "usr_2",
        name: "New User",
        email: "new@example.com",
      });

      const result = await findOrCreateSsoUser("acc_1", "new@example.com", "New User", mockConfig);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.isNew).toBe(true);
      }
    });

    it("returns error when auto-provision disabled", async () => {
      (prismaAdmin.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const noProvisionConfig = { ...mockConfig, autoProvision: false };
      const result = await findOrCreateSsoUser("acc_1", "new@example.com", "New User", noProvisionConfig);
      expect(result.ok).toBe(false);
    });
  });
});
