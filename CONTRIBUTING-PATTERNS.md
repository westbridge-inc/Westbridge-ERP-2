# Contributing Patterns -- Westbridge ERP Backend

## Overview

Express 5 API server (TypeScript, ESM). Uses Prisma (Postgres), Redis (sessions + cache), and BullMQ (background jobs). Runs on port 4000.

## Key Patterns

- **Result type**: Service functions return `Result<T, E>` via `ok()` / `err()` from `src/lib/utils/result.ts`. Never throw from services.
- **API responses**: Always use `apiSuccess(data, meta)` / `apiError(message, code)` from `src/types/api.ts`. Never return raw JSON shapes.
- **Auth middleware chain**: `validateSession()` extracts the session token from cookies. `requireAuth` then publishes the active `accountId` into `tenantContextStorage` (AsyncLocalStorage) so every downstream Prisma query is automatically pinned to the tenant via PostgreSQL Row-Level Security.
- **Service layer**: Business logic in `src/lib/services/`, data access in `src/lib/data/`. Route handlers only do validation, auth, and response formatting.
- **Input validation**: Define Zod schemas in `src/types/schemas/`. Validate all input before passing to services.
- **Workers**: BullMQ workers live in `src/workers/`. Design jobs to be idempotent and safely retried.

### Prisma client split (Phase 3 RLS)

The codebase exposes **two** Prisma clients with different security contracts. Picking the wrong one is a tenant-isolation bug.

- **`prisma` (`src/lib/data/prisma.ts`)** — the runtime client used inside authenticated request handlers. Installs a `$extends` that wraps every operation in a one-shot `$transaction` calling `set_config('app.current_account_id', ...)` first, so RLS policies filter rows by tenant. Reads `tenantContextStorage` set by `requireAuth`.
- **`prismaAdmin` (`src/lib/data/prisma-admin.ts`)** — the schema-owner client that bypasses RLS by ownership. Use ONLY for: pre-tenant-context auth flows (login lookup, session validate), signature-verified webhooks, cleanup workers operating across all tenants, and system-level audit logging.

**Rule of thumb:** if your code runs _after_ `requireAuth` and operates on rows belonging to the requesting tenant, use `prisma`. Anything else uses `prismaAdmin` and earns a one-line comment explaining why it needs to span tenants.

For BullMQ workers and background tasks that legitimately operate on a single tenant outside the request lifecycle, wrap the work in `withTenantScope(accountId, async (tx) => …)` from `src/lib/data/tenant-scope.ts` — it sets both the AsyncLocalStorage tenant context AND the recursion guard, then opens the `$transaction` that pins the Postgres session variable.

## Security Conventions

- No secrets in code -- use env vars, document new ones in `.env.example`.
- Validate all input with Zod before processing.
- Rate-limit every public endpoint with `checkRateLimit()`.
- CSRF validation on all mutation endpoints.
- Use `prisma` (RLS-pinned) inside authenticated handlers; use `prismaAdmin` (bypass-RLS) only for the listed cross-tenant flows. From a worker, wrap your tenant-scoped work in `withTenantScope(accountId, fn)`.

## Test Conventions

- **Runner**: Vitest.
- **Unit tests**: Alongside source (`src/lib/foo.test.ts`).
- **Route tests**: In `src/routes/__tests__/`.
- **Integration tests**: In `src/__tests__/integration/` -- require running Postgres and Redis.
- **Commands**: `npm test` (single run), `vitest` (watch mode).

## Dependency Injection

This codebase uses **direct ESM imports** rather than a DI container. This is a deliberate
choice, not an oversight:

- **Codebase scale**: With a single backend service and ~20 route files, the overhead of a DI
  framework (InversifyJS, tsyringe, etc.) adds complexity without proportionate benefit.
- **Testability**: Vitest `vi.mock()` provides module-level mocking that covers all current
  testing needs. Service functions are pure (accept inputs, return `Result<T, E>`), making
  them trivially testable without constructor injection.
- **Startup clarity**: Import-time dependency resolution makes the boot order explicit and
  catches missing modules immediately via Node's native loader.

**When to reconsider**: If the codebase grows to multiple independently deployable services
that share business logic, or if integration tests require swapping entire subsystems
(e.g., replacing the ERPNext client with an in-memory fake across all consumers), introduce
a lightweight composition root. Prefer explicit factory functions over decorator-based DI.

## What NOT To Do

- Do not put business logic in route handlers -- use the service layer.
- Do not throw from service functions -- return `err()`.
- Do not use `console.log` -- use `logger.info/debug/error` (Pino).
- Do not use `any` types without justification.
- Do not use `prisma db push` in production -- always create migrations.
- Do not commit `.env` files or hardcoded credentials.
- Do not skip rate limiting on new endpoints.
