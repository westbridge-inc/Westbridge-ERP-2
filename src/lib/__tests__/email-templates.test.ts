import { describe, it, expect } from "vitest";
import { inviteEmail, passwordResetEmail, accountActivatedEmail } from "../email/templates.js";

describe("inviteEmail", () => {
  const data = {
    inviterName: "Alice",
    companyName: "Acme Corp",
    role: "admin",
    acceptUrl: "https://app.example.com/invite?token=abc",
  };

  it("returns an HTML string", () => {
    const html = inviteEmail(data);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  it("includes inviter name", () => {
    expect(inviteEmail(data)).toContain("Alice");
  });

  it("includes company name", () => {
    expect(inviteEmail(data)).toContain("Acme Corp");
  });

  it("includes role", () => {
    expect(inviteEmail(data)).toContain("admin");
  });

  it("includes accept URL in button", () => {
    expect(inviteEmail(data)).toContain(data.acceptUrl);
  });

  it("escapes HTML in user-supplied values", () => {
    const html = inviteEmail({ ...data, inviterName: '<script>alert("xss")</script>' });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("passwordResetEmail", () => {
  const data = {
    userName: "Bob",
    resetUrl: "https://app.example.com/reset?token=xyz",
  };

  it("returns valid HTML", () => {
    const html = passwordResetEmail(data);
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("includes user name", () => {
    expect(passwordResetEmail(data)).toContain("Bob");
  });

  it("includes reset URL", () => {
    expect(passwordResetEmail(data)).toContain(data.resetUrl);
  });

  it("includes 'Reset password' button text", () => {
    expect(passwordResetEmail(data)).toContain("Reset password");
  });

  it("handles empty userName gracefully", () => {
    const html = passwordResetEmail({ ...data, userName: "" });
    expect(html).toContain("your email"); // fallback when no name
  });
});

describe("accountActivatedEmail", () => {
  const data = {
    companyName: "Acme Corp",
    plan: "Business",
    loginUrl: "https://app.example.com/login",
  };

  it("returns valid HTML", () => {
    const html = accountActivatedEmail(data);
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("includes company name", () => {
    expect(accountActivatedEmail(data)).toContain("Acme Corp");
  });

  it("includes plan name", () => {
    expect(accountActivatedEmail(data)).toContain("Business");
  });

  it("includes login URL", () => {
    expect(accountActivatedEmail(data)).toContain(data.loginUrl);
  });

  it("includes dashboard button", () => {
    expect(accountActivatedEmail(data)).toContain("Go to dashboard");
  });
});
