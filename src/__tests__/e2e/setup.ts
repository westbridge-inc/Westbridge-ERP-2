/**
 * E2E test setup — starts the Express app on a random port and provides
 * a supertest `request` helper pointed at the running server.
 *
 * Unlike the route-level unit tests (which use supertest against the raw
 * Express app), these tests spin up a real HTTP server so the full request
 * lifecycle is exercised (TCP → middleware chain → route handler → response).
 *
 * External services (ERPNext, Redis, Prisma) are still mocked so the tests
 * are deterministic and don't require infrastructure.
 */

import { type Server } from "node:http";
import { type AddressInfo } from "node:net";
import supertest from "supertest";
import type { Application } from "express";

let server: Server;
let baseUrl: string;

/**
 * Boot the Express app on an OS-assigned port.
 * Returns a supertest agent bound to the running server.
 */
export function startApp(app: Application): {
  request: supertest.Agent;
  getBaseUrl: () => string;
} {
  return {
    request: supertest.agent(app),
    getBaseUrl: () => baseUrl,
  };
}

/**
 * Start a real HTTP server (for tests that need a live TCP connection).
 */
export async function startServer(app: Application): Promise<{
  request: supertest.Agent;
  baseUrl: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        request: supertest.agent(baseUrl),
        baseUrl,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
