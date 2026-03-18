# Contributing Patterns -- Westbridge ERP Backend

## Overview

Express 5 API server (TypeScript, ESM). Uses Prisma (Postgres), Redis (sessions + cache), and BullMQ (background jobs). Runs on port 4000.

## Key Patterns

- **Result type**: Service functions return `Result<T, E>` via `ok()` / `err()` from `src/lib/utils/result.ts`. Never throw from services.
- **API responses**: Always use `apiSuccess(data, meta)` / `apiError(message, code)` from `src/types/api.ts`. Never return raw JSON shapes.
- **Auth middleware chain**: `validateSession()` extracts the session token from cookies. Always scope DB queries by `accountId` for multi-tenant isolation.
- **Service layer**: Business logic in `src/lib/services/`, data access in `src/lib/data/`. Route handlers only do validation, auth, and response formatting.
- **Input validation**: Define Zod schemas in `src/types/schemas/`. Validate all input before passing to services.
- **Workers**: BullMQ workers live in `src/workers/`. Design jobs to be idempotent and safely retried.

## Security Conventions

- No secrets in code -- use env vars, document new ones in `.env.example`.
- Validate all input with Zod before processing.
- Rate-limit every public endpoint with `checkRateLimit()`.
- CSRF validation on all mutation endpoints.
- Always scope queries by `accountId` -- use `withTenant()` if in doubt.

## Test Conventions

- **Runner**: Vitest.
- **Unit tests**: Alongside source (`src/lib/foo.test.ts`).
- **Route tests**: In `src/routes/__tests__/`.
- **Integration tests**: In `src/__tests__/integration/` -- require running Postgres and Redis.
- **Commands**: `npm test` (single run), `vitest` (watch mode).

## What NOT To Do

- Do not put business logic in route handlers -- use the service layer.
- Do not throw from service functions -- return `err()`.
- Do not use `console.log` -- use `logger.info/debug/error` (Pino).
- Do not use `any` types without justification.
- Do not use `prisma db push` in production -- always create migrations.
- Do not commit `.env` files or hardcoded credentials.
- Do not skip rate limiting on new endpoints.
