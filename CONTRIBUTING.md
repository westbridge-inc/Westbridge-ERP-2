# Contributing to Westbridge ERP Backend

This guide covers everything needed to contribute to the Westbridge ERP backend. Follow these conventions to keep the codebase consistent and reviews efficient.

---

## 1. Development Environment

### Prerequisites

| Tool           | Version  | Notes                                   |
| -------------- | -------- | --------------------------------------- |
| Node.js        | >= 20.19 | LTS recommended; see `.nvmrc`           |
| npm            | >= 10    | Ships with Node 20+                     |
| Docker Desktop | Latest   | For PostgreSQL 16, Redis 7, ERPNext v16 |
| Git            | >= 2.40  | Husky hooks require modern Git          |

### Setup

```bash
git clone git@github.com:westbridgeinc/Westbridge-ERP-2.git
cd Westbridge-ERP-2
npm install

# Start infrastructure
docker compose up -d postgres redis

# Configure environment
cp .env.example .env
# Fill in all required values (see inline comments)
# Generate secrets with: openssl rand -hex 32

# Database
npx prisma generate
npx prisma migrate deploy
npx prisma db seed

# Start dev server (hot reload on port 4000)
npm run dev
```

### Full-Stack Mode

To develop against the full platform, including ERPNext:

```bash
docker compose up -d postgres redis mariadb erpnext redis-erpnext
```

Then start the frontend separately:

```bash
cd ../Westbridge-ERP-1 && npm run dev
```

---

## 2. Code Conventions

### TypeScript

- **Strict mode** is enabled. No `any` types without a comment explaining why.
- **ESM modules** -- use `.js` extensions in import paths (TypeScript resolves them).
- **Absolute imports** are available via `@/*` path alias for `src/*`.

### Response Types

Always use the standardized API response helpers:

```typescript
// Good -- structured response envelope
return res.json(apiSuccess(data, apiMeta({ request_id: requestId })));

// Good -- structured error
return res.status(400).json(apiError("VALIDATION", "Email is required"));

// Bad -- raw JSON shape
return res.json({ ok: true, data });
```

### Result Type

Service functions return `Result<T, E>` instead of throwing:

```typescript
import { ok, err, type Result } from "../utils/result.js";

export async function getInvoice(accountId: string, name: string): Promise<Result<Invoice, string>> {
  const invoice = await prisma.salesInvoice.findFirst({
    where: { accountId, name },
  });
  if (!invoice) return err("Invoice not found");
  return ok(invoice);
}
```

Route handlers inspect the result and decide the HTTP status:

```typescript
const result = await getInvoice(session.accountId, name);
if (!result.ok) {
  return res.status(404).json(apiError("NOT_FOUND", result.error));
}
return res.json(apiSuccess(result.data));
```

### Service Layer

Business logic belongs in `src/lib/services/`, not in route handlers. Route handlers are responsible for:

1. Input validation (Zod)
2. Authentication/authorization checks
3. Calling the appropriate service function
4. Formatting the HTTP response

### Input Validation

Define Zod schemas in `src/types/schemas/` and validate all input before passing to services:

```typescript
const schema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "manager", "member", "viewer"]),
});

const parsed = schema.safeParse(req.body);
if (!parsed.success) {
  return res.status(400).json(apiError("VALIDATION", "Invalid input"));
}
```

### Logging

Use structured logging via Pino. Never use `console.log`:

```typescript
import { logger } from "../lib/logger.js";

// Good
logger.info("Invoice created", { accountId, invoiceId, amount });
logger.error("Payment failed", { error: err.message, transactionId });

// Bad
console.log("Invoice created:", invoiceId);
```

### Multi-Tenant Isolation

Every database query must be scoped by `accountId`. This is a hard rule:

```typescript
// Good -- tenant-scoped
const users = await prisma.user.findMany({
  where: { accountId: session.accountId },
});

// Bad -- no tenant scope (data leak)
const users = await prisma.user.findMany();
```

---

## 3. Testing

### Test Organization

| Type          | Location                      | Requires         |
| ------------- | ----------------------------- | ---------------- |
| Unit tests    | `src/lib/**/*.test.ts`        | Nothing          |
| Service tests | `src/lib/services/__tests__/` | Nothing          |
| Route tests   | `src/routes/__tests__/`       | Nothing (mocked) |
| Integration   | `src/__tests__/integration/`  | Postgres + Redis |
| Load tests    | `load-tests/`                 | Running server   |

### Running Tests

```bash
# All tests (single run)
npm test

# Watch mode
npm run test:watch

# With coverage
npx vitest run --coverage

# Specific file
npx vitest run src/lib/services/__tests__/auth.service.test.ts
```

### Writing Tests

- Co-locate unit tests with source: `src/lib/encryption.ts` -> `src/lib/__tests__/encryption.test.ts`
- Mock ERPNext responses in route tests -- never make real HTTP calls in unit tests.
- Use factories from test setup files for consistent test data.
- Test both success and failure paths. Test edge cases.

### Coverage Thresholds

CI enforces minimum coverage. These gates are defined in `vitest.config.ts`:

| Metric     | Required | Target (GA) |
| ---------- | -------- | ----------- |
| Statements | 55%      | 80%         |
| Branches   | 65%      | 70%         |
| Functions  | 90%      | 90%         |
| Lines      | 55%      | 80%         |

New code should maintain or improve these numbers. PRs that drop coverage below thresholds will be blocked by CI.

---

## 4. Database Migrations

### Creating a Migration

When modifying `prisma/schema.prisma`:

```bash
# 1. Make your schema changes in prisma/schema.prisma

# 2. Generate and apply migration
npx prisma migrate dev --name describe_the_change

# 3. Verify the generated SQL
cat prisma/migrations/<timestamp>_describe_the_change/migration.sql

# 4. If new models need demo data, update prisma/seed.ts

# 5. Commit the migration file with your PR
```

### Rules

- **Never** use `prisma db push` in production -- always create migrations.
- **Always** review generated SQL before committing. Prisma sometimes generates destructive operations.
- **Include** the migration directory in your PR.
- **Test** the migration against a fresh database: `npx prisma migrate reset` (destructive -- dev only).
- **Document** new environment variables in `.env.example` if your migration depends on them.

### Regenerating the Client

If you only need to update the Prisma client without creating a migration (e.g., after pulling someone else's migration):

```bash
npx prisma generate
```

---

## 5. Adding a New API Route

Follow this checklist when adding a new endpoint:

1. **Schema**: Define Zod schemas in `src/types/schemas/<feature>.ts`
2. **Service**: Implement business logic in `src/lib/services/<feature>.service.ts`
3. **Route**: Create `src/routes/<feature>.routes.ts`
4. **Register**: Mount the router in `src/app.ts`
5. **OpenAPI**: Add specification in `src/lib/api/openapi.ts`
6. **Test**: Write at least a smoke test in `src/routes/__tests__/<feature>.routes.test.ts`
7. **Rate limit**: Apply `checkTieredRateLimit()` to public endpoints
8. **Env vars**: Document any new variables in `.env.example`

### Route Template

```typescript
import { Router, Request, Response } from "express";
import { z } from "zod";
import { apiSuccess, apiError, apiMeta, getRequestId } from "../types/api.js";
import { requireAuth, requireCsrf, toWebRequest } from "../middleware/auth.js";
import { checkTieredRateLimit, getClientIdentifier, rateLimitHeaders } from "../lib/api/rate-limit-tiers.js";
import * as Sentry from "@sentry/node";

const router = Router();

router.get("/feature", requireAuth, async (req: Request, res: Response) => {
  const requestId = getRequestId(toWebRequest(req));
  const session = req.session!;

  try {
    // Rate limit
    const limit = await checkTieredRateLimit(getClientIdentifier(toWebRequest(req)), "authenticated", "/api/feature");
    if (!limit.allowed) {
      return res.status(429).set(rateLimitHeaders(limit)).json(apiError("RATE_LIMIT", "Too many requests"));
    }

    // Business logic (delegate to service layer)
    const result = await myService(session.accountId);
    if (!result.ok) {
      return res.status(404).json(apiError("NOT_FOUND", result.error));
    }

    return res.json(apiSuccess(result.data, apiMeta({ request_id: requestId })));
  } catch (error) {
    Sentry.captureException(error);
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred"));
  }
});

export default router;
```

---

## 6. Branch Naming

```
feat/<short-description>       # New feature
fix/<short-description>        # Bug fix
chore/<short-description>      # Dependency bumps, config changes
docs/<short-description>       # Documentation only
test/<short-description>       # Test additions/fixes
security/<short-description>   # Security patches (draft PR until reviewed)
```

Use kebab-case. Keep names to 3-5 words.

---

## 7. Commit Style

Conventional commits, loosely enforced. Subject line format:

```
<type>(<scope>): <short imperative description>
```

**Types:** `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `security`

**Scope:** Module or area touched (e.g., `auth`, `erp`, `workers`, `ci`, `prisma`)

Examples:

```
feat(reports): add revenue summary report worker
fix(erp): return 404 instead of 502 for missing docs
chore(deps): bump express from 5.0.0 to 5.0.1
security(csrf): validate HMAC before timestamp check
test(auth): add concurrent login storm test
```

No period at the end. Body optional but appreciated for non-obvious changes. Reference issues with `Closes #123`.

---

## 8. Pull Request Process

### Before Opening a PR

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm test` passes
- [ ] `npm run lint` passes with zero warnings
- [ ] No `console.log` statements -- use `logger.info/debug/error`
- [ ] New environment variables added to `.env.example` with descriptions
- [ ] Schema changes include a migration file
- [ ] New routes have at least a smoke test
- [ ] Rate limiting applied to new public endpoints
- [ ] No hardcoded secrets or credentials
- [ ] All queries scoped by `accountId` for tenant isolation

### PR Description

Use the PR template in `.github/PULL_REQUEST_TEMPLATE.md`. Include:

- **What** changed and **why**
- Testing approach (unit, integration, manual)
- Screenshots for UI-visible changes
- Breaking changes and migration notes

### Review Process

- All PRs require at least one approval before merge.
- Security-related PRs (`security/*` branches) require two reviewers and the `security` label.
- CI must be green (typecheck, lint, test, build).
- `CODEOWNERS` automatically assigns reviewers based on affected paths.

---

## 9. Code Quality Standards

- **TypeScript strict mode** -- the compiler catches bugs before they ship
- **ESLint** -- enforced in CI with zero-warning policy
- **Prettier** -- auto-formatted via lint-staged on commit (Husky pre-commit hook)
- **No dead code** -- remove unused imports, functions, and files
- **Error handling** -- every async operation has explicit error handling
- **Logging** -- structured JSON via Pino, always include context (`accountId`, `jobId`, etc.)

---

## 10. Workers and Background Jobs

BullMQ workers live in `src/workers/`. When adding a new worker:

1. Define the queue in `src/lib/jobs/queue.ts`
2. Implement the worker function in `src/workers/`
3. Start the worker in `src/server.ts`
4. Design jobs to be **idempotent** -- they must be safely retryable
5. Use structured logging with job context
6. Add the queue to the Bull Board dashboard

---

## Questions?

Open a GitHub Discussion or reach out in Slack `#engineering`.
