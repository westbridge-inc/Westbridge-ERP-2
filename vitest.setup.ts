/**
 * Vitest global setup — polyfills and cleanup for test environments.
 */
import { webcrypto } from "node:crypto";

// Polyfill crypto.randomUUID() for environments where Web Crypto API is not available.
if (typeof globalThis.crypto === "undefined") {
  // @ts-expect-error — webcrypto is compatible enough for randomUUID
  globalThis.crypto = webcrypto;
} else if (typeof globalThis.crypto.randomUUID !== "function") {
  globalThis.crypto.randomUUID = webcrypto.randomUUID.bind(webcrypto);
}

// Suppress ioredis ECONNREFUSED errors in test environment.
// Some modules eagerly import ioredis at module scope (e.g., BullMQ queue setup).
// Without Redis running, these emit unhandled error events that cause exit code 1.
process.on("uncaughtException", (err) => {
  if (err.message?.includes("ECONNREFUSED") || err.message?.includes("ioredis")) {
    // Expected in test env — Redis is not running
    return;
  }
  throw err;
});
