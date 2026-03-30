import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createPaymentSession, isPaymentApproved, verifyCallbackHash } from "../wipay.client.js";

describe("wipay.client", () => {
  let originalFetch: typeof global.fetch;
  let originalAccountNumber: string | undefined;
  let originalApiKey: string | undefined;
  let originalSandbox: string | undefined;
  let originalCountryCode: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = global.fetch;
    originalAccountNumber = process.env.WIPAY_ACCOUNT_NUMBER;
    originalApiKey = process.env.WIPAY_API_KEY;
    originalSandbox = process.env.WIPAY_SANDBOX;
    originalCountryCode = process.env.WIPAY_COUNTRY_CODE;
    // Default: set credentials
    process.env.WIPAY_ACCOUNT_NUMBER = "1234567890";
    process.env.WIPAY_API_KEY = "123";
    process.env.WIPAY_SANDBOX = "true";
    process.env.WIPAY_COUNTRY_CODE = "GY";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalAccountNumber !== undefined) process.env.WIPAY_ACCOUNT_NUMBER = originalAccountNumber;
    else delete process.env.WIPAY_ACCOUNT_NUMBER;
    if (originalApiKey !== undefined) process.env.WIPAY_API_KEY = originalApiKey;
    else delete process.env.WIPAY_API_KEY;
    if (originalSandbox !== undefined) process.env.WIPAY_SANDBOX = originalSandbox;
    else delete process.env.WIPAY_SANDBOX;
    if (originalCountryCode !== undefined) process.env.WIPAY_COUNTRY_CODE = originalCountryCode;
    else delete process.env.WIPAY_COUNTRY_CODE;
  });

  describe("isPaymentApproved", () => {
    it("returns true when status is success", () => {
      expect(isPaymentApproved({ status: "success" })).toBe(true);
    });

    it("returns false when status is fail", () => {
      expect(isPaymentApproved({ status: "fail" })).toBe(false);
    });

    it("returns false for empty data", () => {
      expect(isPaymentApproved({})).toBe(false);
    });

    it("returns false when status is undefined", () => {
      expect(isPaymentApproved({ order_id: "test" })).toBe(false);
    });
  });

  describe("verifyCallbackHash", () => {
    it("returns false when API key is not set", () => {
      delete process.env.WIPAY_API_KEY;
      expect(verifyCallbackHash({ order_id: "o1", status: "success", transaction_id: "t1", hash: "abc" })).toBe(false);
    });

    it("returns false when required params are missing", () => {
      expect(verifyCallbackHash({ order_id: "o1", status: "success" })).toBe(false);
      expect(verifyCallbackHash({ order_id: "o1", hash: "abc" })).toBe(false);
      expect(verifyCallbackHash({})).toBe(false);
    });

    it("returns false for incorrect hash", () => {
      expect(
        verifyCallbackHash({
          order_id: "o1",
          status: "success",
          transaction_id: "t1",
          hash: "wrong_hash",
        }),
      ).toBe(false);
    });

    it("verifies correct MD5 hash", () => {
      const { createHash } = require("crypto");
      const orderId = "WB-acc1-12345";
      const status = "success";
      const transactionId = "txn_123";
      const apiKey = "123";
      const expectedHash = createHash("md5").update(`${orderId}${status}${transactionId}${apiKey}`).digest("hex");

      expect(
        verifyCallbackHash({
          order_id: orderId,
          status,
          transaction_id: transactionId,
          hash: expectedHash,
        }),
      ).toBe(true);
    });

    it("is case-insensitive for hash comparison", () => {
      const { createHash } = require("crypto");
      const orderId = "WB-acc1-12345";
      const status = "success";
      const transactionId = "txn_123";
      const apiKey = "123";
      const expectedHash = createHash("md5")
        .update(`${orderId}${status}${transactionId}${apiKey}`)
        .digest("hex")
        .toUpperCase();

      expect(
        verifyCallbackHash({
          order_id: orderId,
          status,
          transaction_id: transactionId,
          hash: expectedHash,
        }),
      ).toBe(true);
    });
  });

  describe("createPaymentSession", () => {
    it("returns null when credentials not configured", async () => {
      delete process.env.WIPAY_ACCOUNT_NUMBER;
      delete process.env.WIPAY_API_KEY;

      const result = await createPaymentSession("Starter", "acc_1", "http://localhost/callback");
      expect(result).toBeNull();
    });

    it("returns null for invalid plan", async () => {
      const result = await createPaymentSession("InvalidPlan" as any, "acc_1", "http://localhost/callback");
      expect(result).toBeNull();
    });

    it("returns payment session on successful API response", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            url: "https://gy.wipayfinancial.com/hosted/pay/abc123",
            message: "Success",
            transaction_id: "txn_456",
          }),
      }) as any;

      const result = await createPaymentSession("Starter", "acc_1", "http://localhost/callback");

      expect(result).not.toBeNull();
      expect(result!.redirectUrl).toBe("https://gy.wipayfinancial.com/hosted/pay/abc123");
      expect(result!.transactionId).toBe("txn_456");
    });

    it("returns null on HTTP error", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            url: "http://localhost/callback?error=true",
            message: "Invalid account",
            transaction_id: "",
          }),
      }) as any;

      const result = await createPaymentSession("Starter", "acc_1", "http://localhost/callback");
      expect(result).toBeNull();
    });

    it("returns null when URL is missing from response", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            message: "Success",
            transaction_id: "txn_1",
          }),
      }) as any;

      const result = await createPaymentSession("Starter", "acc_1", "http://localhost/callback");
      expect(result).toBeNull();
    });

    it("returns null on fetch error", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network error")) as any;

      const result = await createPaymentSession("Starter", "acc_1", "http://localhost/callback");
      expect(result).toBeNull();
    });

    it("sends sandbox environment when WIPAY_SANDBOX is true", async () => {
      process.env.WIPAY_SANDBOX = "true";
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ url: "https://example.com/pay", transaction_id: "t1" }),
      }) as any;

      await createPaymentSession("Starter", "acc_1", "http://localhost/callback");

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = new URLSearchParams(fetchCall[1].body as string);
      expect(body.get("environment")).toBe("sandbox");
    });

    it("sends live environment when WIPAY_SANDBOX is false", async () => {
      process.env.WIPAY_SANDBOX = "false";
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ url: "https://example.com/pay", transaction_id: "t1" }),
      }) as any;

      await createPaymentSession("Starter", "acc_1", "http://localhost/callback");

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = new URLSearchParams(fetchCall[1].body as string);
      expect(body.get("environment")).toBe("live");
    });

    it("uses form-urlencoded body", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ url: "https://example.com/pay", transaction_id: "t1" }),
      }) as any;

      await createPaymentSession("Starter", "acc_1", "http://localhost/callback");

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      // Verify body is URL-encoded, not JSON
      const body = new URLSearchParams(fetchCall[1].body as string);
      expect(body.get("account_number")).toBe("1234567890");
      expect(body.get("total")).toBe("199.99");
      expect(body.get("origin")).toBe("westbridge-erp");
      expect(body.get("fee_structure")).toBe("customer_pay");
      expect(body.get("method")).toBe("credit_card");
    });

    it("defaults to USD when unknown currency is passed", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ url: "https://example.com/pay", transaction_id: "t1" }),
      }) as any;

      await createPaymentSession("Starter", "acc_1", "http://localhost/callback", "ZZZ");

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = new URLSearchParams(fetchCall[1].body as string);
      expect(body.get("currency")).toBe("USD");
    });

    it("accepts TTD currency", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ url: "https://example.com/pay", transaction_id: "t1" }),
      }) as any;

      await createPaymentSession("Starter", "acc_1", "http://localhost/callback", "TTD");

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = new URLSearchParams(fetchCall[1].body as string);
      expect(body.get("currency")).toBe("TTD");
    });

    it("uses order_id as fallback transactionId when API does not return one", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            url: "https://example.com/pay",
            message: "OK",
          }),
      }) as any;

      const result = await createPaymentSession("Starter", "acc_1", "http://localhost/callback");
      expect(result).not.toBeNull();
      expect(result!.transactionId).toContain("WB-acc_1-");
    });
  });
});
