import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createPaymentSession,
  isPaymentApproved,
  verifyCallbackSignature,
  getTransaction,
  refundTransaction,
} from "../powertranz.client.js";

describe("powertranz.client", () => {
  let originalFetch: typeof global.fetch;
  let originalPtzId: string | undefined;
  let originalPtzPassword: string | undefined;
  let originalTestMode: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = global.fetch;
    originalPtzId = process.env.POWERTRANZ_ID;
    originalPtzPassword = process.env.POWERTRANZ_PASSWORD;
    originalTestMode = process.env.POWERTRANZ_TEST_MODE;
    // Default: set credentials
    process.env.POWERTRANZ_ID = "test_id";
    process.env.POWERTRANZ_PASSWORD = "test_pass";
    process.env.POWERTRANZ_TEST_MODE = "true";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalPtzId !== undefined) process.env.POWERTRANZ_ID = originalPtzId;
    else delete process.env.POWERTRANZ_ID;
    if (originalPtzPassword !== undefined) process.env.POWERTRANZ_PASSWORD = originalPtzPassword;
    else delete process.env.POWERTRANZ_PASSWORD;
    if (originalTestMode !== undefined) process.env.POWERTRANZ_TEST_MODE = originalTestMode;
    else delete process.env.POWERTRANZ_TEST_MODE;
  });

  describe("isPaymentApproved", () => {
    it("returns true when Approved is true", () => {
      expect(isPaymentApproved({ Approved: true })).toBe(true);
    });

    it("returns true when ResponseCode is '00'", () => {
      expect(isPaymentApproved({ Approved: false, ResponseCode: "00" })).toBe(true);
    });

    it("returns false for declined payment", () => {
      expect(isPaymentApproved({ Approved: false, ResponseCode: "05" })).toBe(false);
    });

    it("returns false for empty data", () => {
      expect(isPaymentApproved({})).toBe(false);
    });

    it("returns true when both Approved and ResponseCode indicate success", () => {
      expect(isPaymentApproved({ Approved: true, ResponseCode: "00" })).toBe(true);
    });
  });

  describe("verifyCallbackSignature", () => {
    it("returns false when password is not set", () => {
      delete process.env.POWERTRANZ_PASSWORD;
      expect(verifyCallbackSignature("body", "sig")).toBe(false);
    });

    it("returns false when received signature is empty", () => {
      expect(verifyCallbackSignature("body", "")).toBe(false);
    });

    it("returns false for mismatched signatures", () => {
      expect(verifyCallbackSignature("body", "wrong_signature_value_that_is_wrong")).toBe(false);
    });

    it("verifies correct HMAC-SHA256 signature", () => {
      const { createHmac } = require("crypto");
      const body = '{"test":"data"}';
      const expectedSig = createHmac("sha256", "test_pass").update(body).digest("hex");
      expect(verifyCallbackSignature(body, expectedSig)).toBe(true);
    });

    it("returns false for signatures of different lengths", () => {
      expect(verifyCallbackSignature("body", "short")).toBe(false);
    });
  });

  describe("createPaymentSession", () => {
    it("returns null when credentials not configured", async () => {
      delete process.env.POWERTRANZ_ID;
      delete process.env.POWERTRANZ_PASSWORD;

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
        json: () =>
          Promise.resolve({
            SpiToken: "spi_token_123",
            RedirectUrl: "https://staging.ptranz.com/payment?token=spi_token_123",
            Approved: false,
            ResponseCode: "00",
            TransactionIdentifier: "WB-acc_1-12345",
            OrderIdentifier: "acc_1",
          }),
      }) as any;

      const result = await createPaymentSession("Starter", "acc_1", "http://localhost/callback");

      expect(result).not.toBeNull();
      expect(result!.spiToken).toBe("spi_token_123");
      expect(result!.redirectUrl).toBe("https://staging.ptranz.com/payment?token=spi_token_123");
      expect(result!.transactionId).toContain("WB-acc_1-");
    });

    it("returns null on HTTP error", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      }) as any;

      const result = await createPaymentSession("Starter", "acc_1", "http://localhost/callback");
      expect(result).toBeNull();
    });

    it("returns null when API returns errors", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            Errors: [{ Code: "E001", Message: "Invalid card" }],
          }),
      }) as any;

      const result = await createPaymentSession("Starter", "acc_1", "http://localhost/callback");
      expect(result).toBeNull();
    });

    it("returns null when SpiToken is missing from response", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            Approved: false,
            ResponseCode: "00",
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

    it("uses staging URL in test mode", async () => {
      process.env.POWERTRANZ_TEST_MODE = "true";
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ SpiToken: "tok" }),
      }) as any;

      await createPaymentSession("Starter", "acc_1", "http://localhost/callback");

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("staging.ptranz.com"),
        expect.any(Object),
      );
    });

    it("constructs default redirect URL when RedirectUrl not in response", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            SpiToken: "spi_abc",
            Approved: false,
            ResponseCode: "00",
            TransactionIdentifier: "txn_1",
            OrderIdentifier: "acc_1",
          }),
      }) as any;

      const result = await createPaymentSession("Starter", "acc_1", "http://localhost/callback");
      expect(result).not.toBeNull();
      expect(result!.redirectUrl).toContain("spi_abc");
    });

    it("accepts different currencies", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ SpiToken: "tok" }),
      }) as any;

      await createPaymentSession("Starter", "acc_1", "http://localhost/callback", "GYD");

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body as string);
      expect(body.CurrencyCode).toBe("328"); // GYD
    });

    it("defaults to USD when unknown currency is passed", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ SpiToken: "tok" }),
      }) as any;

      await createPaymentSession("Starter", "acc_1", "http://localhost/callback", "ZZZ");

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body as string);
      expect(body.CurrencyCode).toBe("840"); // USD
    });
  });

  describe("getTransaction", () => {
    it("returns null when credentials not configured", async () => {
      delete process.env.POWERTRANZ_ID;
      delete process.env.POWERTRANZ_PASSWORD;

      const result = await getTransaction("txn_1");
      expect(result).toBeNull();
    });

    it("returns transaction data on success", async () => {
      const txnData = {
        TransactionIdentifier: "txn_1",
        Approved: true,
        ResponseCode: "00",
        TotalAmount: 199.99,
      };
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(txnData),
      }) as any;

      const result = await getTransaction("txn_1");
      expect(result).toEqual(txnData);
    });

    it("returns null on HTTP error", async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as any;

      const result = await getTransaction("txn_missing");
      expect(result).toBeNull();
    });

    it("returns null on fetch error", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network error")) as any;

      const result = await getTransaction("txn_1");
      expect(result).toBeNull();
    });
  });

  describe("refundTransaction", () => {
    it("returns failure when credentials not configured", async () => {
      delete process.env.POWERTRANZ_ID;
      delete process.env.POWERTRANZ_PASSWORD;

      const result = await refundTransaction("txn_1");
      expect(result.success).toBe(false);
      expect(result.message).toContain("credentials");
    });

    it("returns success on approved refund", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            Approved: true,
            ResponseCode: "00",
            ResponseMessage: "Approved",
          }),
      }) as any;

      const result = await refundTransaction("txn_1");
      expect(result.success).toBe(true);
      expect(result.responseCode).toBe("00");
    });

    it("returns failure on declined refund", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            Approved: false,
            ResponseCode: "05",
            ResponseMessage: "Declined",
          }),
      }) as any;

      const result = await refundTransaction("txn_1");
      expect(result.success).toBe(false);
    });

    it("returns failure on HTTP error", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      }) as any;

      const result = await refundTransaction("txn_1");
      expect(result.success).toBe(false);
      expect(result.message).toContain("500");
    });

    it("returns failure on fetch error", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Timeout")) as any;

      const result = await refundTransaction("txn_1");
      expect(result.success).toBe(false);
      expect(result.message).toBe("Timeout");
    });

    it("includes amount in refund request when provided", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ Approved: true, ResponseCode: "00" }),
      }) as any;

      await refundTransaction("txn_1", 50.0);

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body as string);
      expect(body.TotalAmount).toBe(50.0);
      expect(body.TransactionIdentifier).toBe("txn_1");
    });

    it("omits amount when not provided", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ Approved: true, ResponseCode: "00" }),
      }) as any;

      await refundTransaction("txn_1");

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body as string);
      expect(body.TotalAmount).toBeUndefined();
    });
  });
});
