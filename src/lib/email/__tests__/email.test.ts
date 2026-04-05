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
});
