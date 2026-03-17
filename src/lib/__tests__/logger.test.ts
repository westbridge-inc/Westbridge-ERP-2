import { describe, it, expect } from "vitest";
import { logger } from "../logger.js";

describe("logger", () => {
  it("has all expected methods", () => {
    expect(typeof logger.trace).toBe("function");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.fatal).toBe("function");
    expect(typeof logger.child).toBe("function");
  });

  it("child returns a child logger", () => {
    const child = logger.child({ service: "test-service" });
    expect(child).toBeDefined();
    expect(typeof child.info).toBe("function");
    expect(typeof child.error).toBe("function");
  });

  it("child with traceId", () => {
    const child = logger.child({ service: "auth", traceId: "abc-123" });
    expect(child).toBeDefined();
  });

  it("logger methods do not throw when called", () => {
    expect(() => logger.info("test info")).not.toThrow();
    expect(() => logger.warn("test warn", { service: "test" })).not.toThrow();
    expect(() => logger.error("test error")).not.toThrow();
    expect(() => logger.debug("test debug")).not.toThrow();
    expect(() => logger.trace("test trace")).not.toThrow();
    expect(() => logger.fatal("test fatal")).not.toThrow();
  });
});
