import { describe, it, expect, vi } from "vitest";

vi.mock("../logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@sentry/node", () => ({
  captureMessage: vi.fn(),
}));

import { reportSecurityEvent } from "../security-monitor.js";
import { logger } from "../logger.js";
import * as Sentry from "@sentry/node";

describe("security-monitor", () => {
  it("reportSecurityEvent logs and reports to Sentry", () => {
    reportSecurityEvent({
      type: "brute_force",
      userId: "usr_1",
      accountId: "acc_1",
      ipAddress: "1.2.3.4",
      details: "Too many login attempts",
    });

    expect(logger.error).toHaveBeenCalledWith(
      "security_event",
      expect.objectContaining({
        type: "brute_force",
        ipAddress: "1.2.3.4",
      }),
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "Security Event: brute_force",
      expect.objectContaining({ level: "error" }),
    );
  });

  it("handles all event types", () => {
    for (const type of ["session_hijack", "csrf_attack", "unauthorized_access"] as const) {
      reportSecurityEvent({
        type,
        ipAddress: "5.6.7.8",
        details: "test",
      });
    }
    // 3 calls here + 1 from the first test = 4 total
    expect(logger.error).toHaveBeenCalledTimes(4);
  });
});
