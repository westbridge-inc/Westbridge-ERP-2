import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  getPriceId,
  verifyWebhookSignature,
  getSubscription,
  cancelPaddleSubscription,
  PLAN_AMOUNTS,
} from "../paddle.client.js";

describe("paddle.client", () => {
  let originalFetch: typeof global.fetch;
  let originalApiKey: string | undefined;
  let originalWebhookSecret: string | undefined;
  let originalSandbox: string | undefined;
  let originalPriceSolo: string | undefined;
  let originalPriceStarter: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = global.fetch;
    originalApiKey = process.env.PADDLE_API_KEY;
    originalWebhookSecret = process.env.PADDLE_WEBHOOK_SECRET;
    originalSandbox = process.env.PADDLE_SANDBOX;
    originalPriceSolo = process.env.PADDLE_PRICE_SOLO;
    originalPriceStarter = process.env.PADDLE_PRICE_STARTER;
    // Set defaults
    process.env.PADDLE_API_KEY = "test_api_key";
    process.env.PADDLE_WEBHOOK_SECRET = "test_webhook_secret";
    process.env.PADDLE_SANDBOX = "true";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalApiKey !== undefined) process.env.PADDLE_API_KEY = originalApiKey;
    else delete process.env.PADDLE_API_KEY;
    if (originalWebhookSecret !== undefined) process.env.PADDLE_WEBHOOK_SECRET = originalWebhookSecret;
    else delete process.env.PADDLE_WEBHOOK_SECRET;
    if (originalSandbox !== undefined) process.env.PADDLE_SANDBOX = originalSandbox;
    else delete process.env.PADDLE_SANDBOX;
    if (originalPriceSolo !== undefined) process.env.PADDLE_PRICE_SOLO = originalPriceSolo;
    else delete process.env.PADDLE_PRICE_SOLO;
    if (originalPriceStarter !== undefined) process.env.PADDLE_PRICE_STARTER = originalPriceStarter;
    else delete process.env.PADDLE_PRICE_STARTER;
  });

  describe("PLAN_AMOUNTS", () => {
    it("has correct amounts for all plans", () => {
      expect(PLAN_AMOUNTS.Solo).toBe(49.99);
      expect(PLAN_AMOUNTS.Starter).toBe(199.99);
      expect(PLAN_AMOUNTS.Business).toBe(999.99);
      expect(PLAN_AMOUNTS.Enterprise).toBe(4999.99);
    });
  });

  describe("getPriceId", () => {
    it("returns empty string when env var not set", () => {
      expect(getPriceId("Solo")).toBe("");
    });
  });

  describe("verifyWebhookSignature", () => {
    it("returns false when webhook secret is not configured", () => {
      delete process.env.PADDLE_WEBHOOK_SECRET;
      expect(verifyWebhookSignature("body", "ts=123;h1=abc")).toBe(false);
    });

    it("returns false for empty inputs", () => {
      expect(verifyWebhookSignature("", "ts=123;h1=abc")).toBe(false);
      expect(verifyWebhookSignature("body", "")).toBe(false);
    });

    it("returns false when signature is missing ts or h1", () => {
      expect(verifyWebhookSignature("body", "ts=123")).toBe(false);
      expect(verifyWebhookSignature("body", "h1=abc")).toBe(false);
    });

    it("returns false for incorrect hash", () => {
      expect(verifyWebhookSignature("body", "ts=123;h1=0000000000000000000000000000000000000000000000000000000000000000")).toBe(false);
    });

    it("verifies correct HMAC-SHA256 signature", () => {
      const { createHmac } = require("crypto");
      const rawBody = '{"event_type":"transaction.completed"}';
      const ts = "1234567890";
      const secret = "test_webhook_secret";
      const hash = createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex");
      const signature = `ts=${ts};h1=${hash}`;

      expect(verifyWebhookSignature(rawBody, signature)).toBe(true);
    });

    it("rejects tampered body", () => {
      const { createHmac } = require("crypto");
      const rawBody = '{"event_type":"transaction.completed"}';
      const ts = "1234567890";
      const secret = "test_webhook_secret";
      const hash = createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex");
      const signature = `ts=${ts};h1=${hash}`;

      expect(verifyWebhookSignature('{"event_type":"tampered"}', signature)).toBe(false);
    });
  });

  describe("getSubscription", () => {
    it("returns null when API key is not configured", async () => {
      delete process.env.PADDLE_API_KEY;
      const result = await getSubscription("sub_123");
      expect(result).toBeNull();
    });

    it("returns subscription data on success", async () => {
      const subData = { id: "sub_123", status: "active", plan: "Starter" };
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: subData }),
      }) as any;

      const result = await getSubscription("sub_123");
      expect(result).toEqual(subData);
    });

    it("returns null on API error", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }) as any;

      const result = await getSubscription("sub_missing");
      expect(result).toBeNull();
    });

    it("returns null on fetch error", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network error")) as any;

      const result = await getSubscription("sub_123");
      expect(result).toBeNull();
    });
  });

  describe("cancelPaddleSubscription", () => {
    it("returns false when API key is not configured", async () => {
      delete process.env.PADDLE_API_KEY;
      const result = await cancelPaddleSubscription("sub_123");
      expect(result).toBe(false);
    });

    it("returns true on successful cancellation", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { id: "sub_123", status: "canceled" } }),
      }) as any;

      const result = await cancelPaddleSubscription("sub_123");
      expect(result).toBe(true);
    });

    it("sends effective_from: next_billing_period", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: {} }),
      }) as any;

      await cancelPaddleSubscription("sub_123");

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body as string);
      expect(body.effective_from).toBe("next_billing_period");
    });

    it("returns false on API error", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      }) as any;

      const result = await cancelPaddleSubscription("sub_123");
      expect(result).toBe(false);
    });

    it("returns false on fetch error", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network error")) as any;

      const result = await cancelPaddleSubscription("sub_123");
      expect(result).toBe(false);
    });

    it("uses sandbox API when PADDLE_SANDBOX is true", async () => {
      process.env.PADDLE_SANDBOX = "true";
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: {} }),
      }) as any;

      await cancelPaddleSubscription("sub_123");

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain("sandbox-api.paddle.com");
    });
  });
});
