import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSend = vi.fn();

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: mockSend },
  })),
}));

// Set env before importing
process.env.RESEND_API_KEY = "re_test_key";

import { sendEmail } from "../index.js";

describe("sendEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends email successfully", async () => {
    mockSend.mockResolvedValue({ data: { id: "email_123" }, error: null });

    const result = await sendEmail({
      to: "test@example.com",
      subject: "Test",
      html: "<p>Hello</p>",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe("email_123");
    }
  });

  it("returns error when Resend returns error", async () => {
    mockSend.mockResolvedValue({ data: null, error: { message: "Invalid recipient" } });

    const result = await sendEmail({
      to: "bad@test.com",
      subject: "Test",
      html: "<p>Hello</p>",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unable to send the email right now");
    }
  });

  it("handles thrown exceptions", async () => {
    mockSend.mockRejectedValue(new Error("Network error"));

    const result = await sendEmail({
      to: "test@example.com",
      subject: "Test",
      html: "<p>Hello</p>",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unable to send the email right now");
    }
  });

  it("uses custom from address", async () => {
    mockSend.mockResolvedValue({ data: { id: "email_456" }, error: null });

    await sendEmail({
      to: "test@example.com",
      subject: "Test",
      html: "<p>Hello</p>",
      from: "Custom <custom@test.com>",
    });

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ from: "Custom <custom@test.com>" }));
  });

  // ── M6: retry-on-failure ────────────────────────────────────────────────
  describe("retry behaviour (M6)", () => {
    it("retries on transient 5xx error and eventually succeeds", async () => {
      mockSend
        .mockResolvedValueOnce({ data: null, error: { statusCode: 503, message: "Service unavailable" } })
        .mockResolvedValueOnce({ data: null, error: { statusCode: 502, message: "Bad gateway" } })
        .mockResolvedValueOnce({ data: { id: "email_recovered" }, error: null });

      const result = await sendEmail({ to: "test@example.com", subject: "Test", html: "<p>Hi</p>" });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.id).toBe("email_recovered");
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it("retries on network error (rejection without statusCode)", async () => {
      mockSend
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce({ data: { id: "email_after_network_blip" }, error: null });

      const result = await sendEmail({ to: "test@example.com", subject: "Test", html: "<p>Hi</p>" });

      expect(result.ok).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry on 4xx (caller error — won't help)", async () => {
      mockSend.mockResolvedValue({
        data: null,
        error: { statusCode: 400, message: "Invalid recipient address" },
      });

      const result = await sendEmail({ to: "not-an-email", subject: "Test", html: "<p>Hi</p>" });

      expect(result.ok).toBe(false);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("returns failure after MAX_ATTEMPTS exhausted on persistent transient errors", async () => {
      mockSend.mockResolvedValue({ data: null, error: { statusCode: 500, message: "Server error" } });

      const result = await sendEmail({ to: "test@example.com", subject: "Test", html: "<p>Hi</p>" });

      expect(result.ok).toBe(false);
      expect(mockSend).toHaveBeenCalledTimes(3); // MAX_ATTEMPTS = 3
    });
  });
});
