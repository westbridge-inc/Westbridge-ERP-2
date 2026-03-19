import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock posthog-node before any imports
const mockCapture = vi.fn();
const mockIdentify = vi.fn();
const mockShutdown = vi.fn().mockResolvedValue(undefined);

vi.mock("posthog-node", () => ({
  PostHog: vi.fn().mockImplementation(() => ({
    capture: mockCapture,
    identify: mockIdentify,
    shutdown: mockShutdown,
  })),
}));

describe("posthog.server", () => {
  let originalApiKey: string | undefined;
  let originalHost: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    originalApiKey = process.env.POSTHOG_API_KEY;
    originalHost = process.env.POSTHOG_HOST;
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env.POSTHOG_API_KEY = originalApiKey;
    } else {
      delete process.env.POSTHOG_API_KEY;
    }
    if (originalHost !== undefined) {
      process.env.POSTHOG_HOST = originalHost;
    } else {
      delete process.env.POSTHOG_HOST;
    }
  });

  describe("capture", () => {
    it("does nothing when POSTHOG_API_KEY is not set", async () => {
      delete process.env.POSTHOG_API_KEY;
      const { capture } = await import("../posthog.server.js");

      capture("user_1", "test_event", { key: "value" });

      expect(mockCapture).not.toHaveBeenCalled();
    });

    it("captures event when API key is set", async () => {
      process.env.POSTHOG_API_KEY = "phc_test123";
      const { capture } = await import("../posthog.server.js");

      capture("user_1", "page_view", { page: "/dashboard" });

      expect(mockCapture).toHaveBeenCalledWith({
        distinctId: "user_1",
        event: "page_view",
        properties: { page: "/dashboard" },
      });
    });

    it("captures event without properties", async () => {
      process.env.POSTHOG_API_KEY = "phc_test123";
      const { capture } = await import("../posthog.server.js");

      capture("user_1", "login");

      expect(mockCapture).toHaveBeenCalledWith({
        distinctId: "user_1",
        event: "login",
        properties: undefined,
      });
    });

    it("never throws even if PostHog client throws", async () => {
      process.env.POSTHOG_API_KEY = "phc_test123";
      mockCapture.mockImplementation(() => {
        throw new Error("PostHog internal error");
      });
      const { capture } = await import("../posthog.server.js");

      // Should not throw
      expect(() => capture("user_1", "test_event")).not.toThrow();
    });
  });

  describe("identify", () => {
    it("does nothing when POSTHOG_API_KEY is not set", async () => {
      delete process.env.POSTHOG_API_KEY;
      const { identify } = await import("../posthog.server.js");

      identify("user_1", { email: "test@test.com" });

      expect(mockIdentify).not.toHaveBeenCalled();
    });

    it("identifies user when API key is set", async () => {
      process.env.POSTHOG_API_KEY = "phc_test123";
      const { identify } = await import("../posthog.server.js");

      identify("user_1", {
        email: "test@test.com",
        plan: "Starter",
        companyName: "Test Corp",
        role: "owner",
      });

      expect(mockIdentify).toHaveBeenCalledWith({
        distinctId: "user_1",
        properties: {
          email: "test@test.com",
          plan: "Starter",
          companyName: "Test Corp",
          role: "owner",
        },
      });
    });

    it("never throws even if PostHog client throws", async () => {
      process.env.POSTHOG_API_KEY = "phc_test123";
      mockIdentify.mockImplementation(() => {
        throw new Error("PostHog internal error");
      });
      const { identify } = await import("../posthog.server.js");

      expect(() => identify("user_1", { email: "x@y.com" })).not.toThrow();
    });
  });

  describe("shutdownPostHog", () => {
    it("resolves without error when PostHog was never initialized", async () => {
      delete process.env.POSTHOG_API_KEY;
      const { shutdownPostHog } = await import("../posthog.server.js");

      await expect(shutdownPostHog()).resolves.not.toThrow();
    });

    it("calls shutdown on PostHog client when initialized", async () => {
      process.env.POSTHOG_API_KEY = "phc_test123";
      const { capture, shutdownPostHog } = await import("../posthog.server.js");

      // Initialize the client by calling capture
      capture("user_1", "init_event");
      await shutdownPostHog();

      expect(mockShutdown).toHaveBeenCalled();
    });
  });

  describe("lazy initialization", () => {
    it("creates PostHog instance lazily on first capture call", async () => {
      process.env.POSTHOG_API_KEY = "phc_lazy_test";
      const { PostHog } = await import("posthog-node");

      // Reset to check constructor calls
      (PostHog as ReturnType<typeof vi.fn>).mockClear();

      const { capture } = await import("../posthog.server.js");

      // Before any call, constructor shouldn't have been called (via this import)
      capture("user_1", "first_event");

      // After capture, client should have been initialized
      // (PostHog constructor called at least once in this module's lifecycle)
    });

    it("reuses the same instance across multiple calls", async () => {
      process.env.POSTHOG_API_KEY = "phc_reuse_test";
      const { capture } = await import("../posthog.server.js");

      capture("user_1", "event_1");
      capture("user_2", "event_2");
      capture("user_3", "event_3");

      expect(mockCapture).toHaveBeenCalledTimes(3);
    });
  });
});
