/**
 * Vitest global setup — polyfills and cleanup for test environments.
 */
import { webcrypto } from "node:crypto";
import { afterAll } from "vitest";

// Polyfill crypto.randomUUID() for environments where Web Crypto API is not available.
if (typeof globalThis.crypto === "undefined") {
  // @ts-expect-error — webcrypto is compatible enough for randomUUID
  globalThis.crypto = webcrypto;
} else if (typeof globalThis.crypto.randomUUID !== "function") {
  globalThis.crypto.randomUUID = webcrypto.randomUUID.bind(webcrypto);
}

// Ensure Redis connections are closed after all tests to prevent process hang / ECONNREFUSED errors
afterAll(async () => {
  try {
    const { closeRedis } = await import("./src/lib/redis.js");
    await closeRedis();
  } catch {
    // Redis module may not be loaded in all test suites
  }
});
