# Contributing to Westbridge ERP Backend

Thanks for contributing. These are the conventions the team follows — new code should
adhere to them. See `docs/TECH-DEBT.md` for known inconsistencies.

---

## 1. Local Setup

### Prerequisites

- **Node.js** >= 20.19.0 (see `.nvmrc`)
- **Docker Desktop** (PostgreSQL, Redis, ERPNext)
- **npm** >= 10

### One-Command Start

```bash
# Install deps, start containers, run migrations, seed data, start dev server
npm install
docker compose up -d postgres redis erpnext redis-erpnext mariadb
cp .env.example .env              # Fill in secrets (see comments in file)
npx prisma generate
npx prisma migrate deploy
npx prisma db seed
npm run dev
```

The server starts on port 4000 with hot reload.

---

## 2. Branch Naming

```
feat/<short-description>       # New feature
fix/<short-description>        # Bug fix
chore/<short-description>      # Dependency bumps, config changes
docs/<short-description>       # Documentation only
test/<short-description>       # Test additions/fixes
security/<short-description>   # Security patches (consider draft PR until reviewed)
```

Use kebab-case. Keep names to 3–5 words.

---

## 3. Commit Style

Conventional commits (loosely enforced). Subject line format:

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

No period at the end. Body optional but appreciated for non-obvious changes.
Reference issues with `Closes #123`.

---

## 4. Code Patterns

### Routes (`src/routes/`)

- Use `apiSuccess()` / `apiError()` from `src/types/api.ts` — never return raw JSON
- Validate input with Zod schemas (defined in `src/types/schemas/`)
- Rate-limit with `checkRateLimit()` — use tiered limits for new routes
- Authenticate with `validateSession()` — extract token from cookies
- Wrap handler body in try/catch and capture with Sentry

```typescript
// Good
return res.json(apiSuccess(data, meta()));

// Bad — raw shape
return res.json({ ok: true, data });
```

### Services (`src/lib/services/`)

- Business logic lives here, **not** in route handlers
- Return `Result<T, E>` — use `ok()` / `err()` from `src/lib/utils/result.ts`
- Never throw from services — let the caller decide the HTTP status
- Always scope queries by `accountId` for multi-tenant isolation

```typescript
// Good
export async function getInvoice(accountId: string, name: string): Promise<Result<Invoice, string>> {
  const invoice = await prisma.salesInvoice.findFirst({ where: { accountId, name } });
  if (!invoice) return err("Invoice not found");
  return ok(invoice);
}
```

### Data Clients (`src/lib/data/`)

- Low-level data access only — no business logic
- `erpnext.client.ts` handles all ERPNext HTTP calls (with session cookie relay)
- `prisma.ts` is the shared Prisma singleton
- Always pass `accountId` for tenant-scoped queries

### Workers (`src/workers/`)

- Each queue has a dedicated `create*Worker()` function
- Workers are started in `src/server.ts` after the HTTP server is listening
- Use structured logging (`logger.info/error`) with job context
- Idempotency: design jobs to be safely retried

### Tests

- Unit tests alongside source: `src/lib/foo.test.ts`
- Route tests in `src/routes/__tests__/`
- Integration tests in `src/__tests__/integration/`
- Use factories from test setup files for consistent data
- Mock ERPNext responses in route tests

---

## 5. Database Changes

When modifying `prisma/schema.prisma`:

1. Make your schema changes
2. Run `npx prisma migrate dev --name describe_change`
3. Verify the generated SQL in `prisma/migrations/`
4. Update `prisma/seed.ts` if new models need demo data
5. Include the migration file in your PR

Never use `prisma db push` in production — always create migrations.

---

## 6. Adding a New API Route

1. Create `src/routes/myfeature.routes.ts`
2. Define Zod schemas in `src/types/schemas/myfeature.ts`
3. Create service functions in `src/lib/services/myfeature.service.ts`
4. Register the router in `src/app.ts`
5. Add OpenAPI registration in `src/lib/api/openapi.ts`
6. Add a smoke test in `src/routes/__tests__/myfeature.routes.test.ts`
7. Document new env vars in `.env.example`

---

## 7. PR Checklist

Before requesting review:

- [ ] `npm run typecheck` passes (zero errors)
- [ ] `npm test` passes
- [ ] `npm run lint` passes
- [ ] No `console.log` — use `logger.info/debug/error`
- [ ] New env vars added to `.env.example` with descriptions
- [ ] Schema changes have a migration file
- [ ] New routes have at least a smoke test
- [ ] Breaking API changes maintain backward compatibility
- [ ] No hardcoded secrets or credentials
- [ ] Rate limiting applied to new public endpoints

Security-related PRs: add the `security` label and request a second reviewer.

---

## 8. Code Quality Standards

- **TypeScript strict mode** — no `any` types without justification
- **ESLint** — must pass with zero warnings in CI
- **Prettier** — format with `npm run format` before committing
- **No dead code** — remove unused imports, functions, and files
- **Error handling** — every async operation has explicit error handling
- **Logging** — structured JSON via Pino, include context (jobId, accountId, etc.)

---

## 9. Questions?

Open a GitHub Discussion or reach out in Slack `#engineering`.
