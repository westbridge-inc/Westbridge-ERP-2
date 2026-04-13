# ADR-001: Express.js 5 as HTTP Framework

## Status: Accepted

## Date: 2026-03-10

## Context

The backend needed an HTTP framework to serve the REST API, proxy requests to
ERPNext, host BullMQ job queues, and expose Prometheus metrics. Candidates
evaluated:

- **Express 5** -- the long-awaited major release with native async error
  handling and Promise-returning middleware.
- **Fastify** -- high-performance, schema-based validation, built-in logging.
- **Hono** -- ultralight, Web Standard API native, runs on edge runtimes.
- **Koa** -- minimal core, middleware composition via async/await.

Key constraints: the team was small (1-2 engineers), the product was launching
in the Caribbean market on a tight timeline, and the middleware surface was
large (Helmet, CORS, cookie-parser, Sentry, OpenTelemetry, Prom-client).

## Decision

We chose **Express 5** (`express@^5.0.1`).

1. **Middleware ecosystem** -- Helmet, cors, cookie-parser, Sentry, and
   OpenTelemetry all provide first-party Express middleware. Fastify and Hono
   would have required adapter shims or rewrites.
2. **Express 5 async support** -- Express 5 catches rejected Promises in route
   handlers automatically, removing the main foot-gun of Express 4.
3. **Hiring and onboarding** -- Express is the most widely known Node.js
   framework. Future hires can be productive on day one.
4. **Separation of app and server** -- `createApp` in `src/app.ts` returns a
   configured Express instance that integration tests import via Supertest
   without starting the HTTP server or BullMQ workers.

## Consequences

### Positive

- Every middleware dependency worked out of the box with zero adapter code.
- Supertest integration tests are straightforward (`supertest(app)`).
- The `trust proxy` setting integrates cleanly with Fly.io's proxy layer.

### Negative

- Express is slower than Fastify and Hono in synthetic benchmarks. Acceptable
  for our scale (< 500 RPS), validated by k6 load tests.
- Express 5 type definitions (`@types/express@^5.0.0`) were unstable at
  adoption time and required pinning.
- No built-in schema validation -- we use Zod separately in every route.
