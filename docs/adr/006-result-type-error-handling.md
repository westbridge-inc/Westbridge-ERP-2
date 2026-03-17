# ADR-006: Result Type Pattern Over Exceptions

## Status: Accepted

## Date: 2026-03-10

## Context

The service layer needed a consistent error-handling strategy. Two approaches:

- **Throw/catch** -- idiomatic JavaScript, but error paths are invisible in
  type signatures. Callers must remember to wrap calls in try/catch, and
  TypeScript cannot enforce this.
- **Result type** -- a discriminated union (`{ ok: true; data: T } | { ok:
false; error: E }`) that forces callers to check the result before
  accessing data. Common in Rust, Go, and functional TypeScript.

The codebase communicates with multiple external systems (ERPNext, Redis,
PostgreSQL, PowerTranz) where failures are expected, not exceptional.

## Decision

We use a **Result<T, E> type** defined in `src/lib/utils/result.ts`.

```typescript
type Result<T, E = Error> = { ok: true; data: T } | { ok: false; error: E };
```

Conventions:

- **Services** (`src/lib/services/`) return `Result<T, string>` -- never
  throw for expected failures.
- **Data clients** (`src/lib/data/`) return `Result<T, string>` -- network
  errors, 404s, and upstream failures are all `err()` values.
- **Route handlers** check `result.ok` and map to the appropriate HTTP
  status code. The service does not decide HTTP semantics.
- **AppError** extends the pattern with structured error codes, timestamps,
  and request IDs for end-to-end traceability.
- Helper constructors `ok(data)` and `err(error)` keep call sites concise.

Example from CONTRIBUTING.md:

```typescript
export async function getInvoice(accountId: string, name: string): Promise<Result<Invoice, string>> {
  const invoice = await prisma.salesInvoice.findFirst({
    where: { accountId, name },
  });
  if (!invoice) return err("Invoice not found");
  return ok(invoice);
}
```

## Consequences

### Positive

- Error paths are visible in function signatures -- TypeScript narrows the
  union, so accessing `result.data` without checking `result.ok` is a type
  error.
- Route handlers have full control over HTTP status mapping without catching
  generic exceptions.
- No accidental swallowing of errors -- every `Result` must be inspected.
- Consistent across all service and data layers.

### Negative

- More verbose than throw/catch for simple cases -- every caller needs an
  `if (!result.ok)` check.
- Third-party libraries still throw, so boundaries (e.g., Prisma calls,
  `fetch`) still need try/catch to convert exceptions into `err()` values.
- Team members unfamiliar with the pattern need onboarding (documented in
  CONTRIBUTING.md section 4).
