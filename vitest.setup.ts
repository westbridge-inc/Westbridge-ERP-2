/**
 * Vitest global setup — polyfills and mocks for test environments.
 */
import { webcrypto } from "node:crypto";
import { vi } from "vitest";

// Polyfill crypto.randomUUID() for environments where Web Crypto API is not available.
if (typeof globalThis.crypto === "undefined") {
  // @ts-expect-error — webcrypto is compatible enough for randomUUID
  globalThis.crypto = webcrypto;
} else if (typeof globalThis.crypto.randomUUID !== "function") {
  globalThis.crypto.randomUUID = webcrypto.randomUUID.bind(webcrypto);
}

// Prevent real Redis connections in unit tests.
// Individual tests that need Redis behavior mock it themselves.
vi.mock("ioredis", () => {
  const EventEmitter = require("events");
  class RedisMock extends EventEmitter {
    status = "ready";
    ping() {
      return Promise.resolve("PONG");
    }
    get() {
      return Promise.resolve(null);
    }
    set() {
      return Promise.resolve("OK");
    }
    del() {
      return Promise.resolve(1);
    }
    setex() {
      return Promise.resolve("OK");
    }
    expire() {
      return Promise.resolve(1);
    }
    zadd() {
      return Promise.resolve(1);
    }
    zrangebyscore() {
      return Promise.resolve([]);
    }
    zremrangebyscore() {
      return Promise.resolve(0);
    }
    zcard() {
      return Promise.resolve(0);
    }
    pipeline() {
      const pipe: Record<string, unknown> = {};
      const self = () => pipe;
      pipe.zadd = self;
      pipe.zremrangebyscore = self;
      pipe.zcard = self;
      pipe.del = self;
      pipe.pexpire = self;
      pipe.expire = self;
      pipe.set = self;
      pipe.get = self;
      pipe.exec = () =>
        Promise.resolve([
          [null, 0],
          [null, 0],
        ]);
      return pipe;
    }
    publish() {
      return Promise.resolve(0);
    }
    subscribe() {
      return Promise.resolve();
    }
    quit() {
      return Promise.resolve("OK");
    }
    disconnect() {
      return;
    }
    keys() {
      return Promise.resolve([]);
    }
    smembers() {
      return Promise.resolve([]);
    }
    scan() {
      return Promise.resolve(["0", []]);
    }
    hset() {
      return Promise.resolve(1);
    }
    hget() {
      return Promise.resolve(null);
    }
    hgetall() {
      return Promise.resolve({});
    }
    hincrby() {
      return Promise.resolve(1);
    }
    sadd() {
      return Promise.resolve(1);
    }
    scard() {
      return Promise.resolve(0);
    }
  }
  return { Redis: RedisMock, Cluster: RedisMock, default: RedisMock };
});
