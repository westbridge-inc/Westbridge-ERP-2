# Tech Debt Register

Known technical debt items tracked for prioritization. Referenced from
[CONTRIBUTING.md](../CONTRIBUTING.md).

Last reviewed: 2026-04-05

## Resolution Policy

- **Critical (P0):** Fix within 1 sprint (2 weeks)
- **High (P1):** Fix within 2 sprints (4 weeks)
- **Medium (P2):** Fix within 1 quarter
- **Low (P3):** Best effort, review quarterly

| ID     | Description                                                                                                                                                                                                                                                                                                                                                                                  | Severity   | Effort            | Target   | Source                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------- | -------- | -------------------------------------------------------------------------- |
| TD-001 | **bull-board dashboard not wired up.** BullMQ has `@bull-board/api` for a web UI to inspect stuck/failed jobs. Currently we inspect Redis directly.                                                                                                                                                                                                                                          | Medium     | Small (1-2 days)  | v1.1     | `src/lib/jobs/queue.ts:27`                                                 |
| TD-002 | **`toWebRequest` conversion shim in auth middleware.** The session service uses the Web API `Request` interface (`request.headers.get`), but Express provides its own `req` object. A fake `globalThis.Request` is constructed on every authenticated request. Should either migrate session service to accept Express `req` directly, or adopt a framework with native Web API support. | Medium     | Medium (3-5 days) | v1.1     | `src/middleware/auth.ts:179-197`                                           |
| TD-003 | **PDF email attachment not wired.** Document email route generates the PDF but does not attach it because `sendEmail` does not yet support Resend attachments. The PDF buffer is created and discarded.                                                                                                                                                                                      | High       | Small (1 day)     | v1.0     | `src/routes/document.routes.ts:155`                                        |
| TD-004 | ~~**`--legacy-peer-deps` used everywhere in CI.**~~ **RESOLVED** (2026-04-05): Downgraded zod-to-openapi to v7, upgraded OpenTelemetry, removed all `--legacy-peer-deps` from CI, Dockerfile, and .npmrc.                                                                                                                                                                                    | ~~Medium~~ | ~~Medium~~        | ~~v1.1~~ | Resolved                                                                   |
| TD-005 | ~~**TruffleHog secrets scan uses `continue-on-error: true`.**~~ **RESOLVED** (2026-04-05): Set `continue-on-error: false` in security.yml.                                                                                                                                                                                                                                                   | ~~High~~   | ~~Small~~         | ~~v1.0~~ | Resolved                                                                   |
| TD-006 | **k6 load test failures are swallowed.** The CI smoke test step runs `k6 run ... \|\| echo "::warning::..."`, converting failures into warnings. The load test never blocks a merge.                                                                                                                                                                                                         | Medium     | Small (< 1 day)   | v1.1     | `.github/workflows/ci.yml:198`                                             |
| TD-007 | **`NEXT_PHASE` build-phase guards in server code.** Both `erpnext.client.ts` and `queue.ts` check `process.env.NEXT_PHASE === "phase-production-build"` to skip validation during Next.js SSR builds. This is a leftover from when the backend was co-located with a Next.js frontend. The backend is now a standalone Express app and these guards are dead code.                           | Low        | Small (< 1 day)   | v1.2     | `src/lib/data/erpnext.client.ts:11`, `src/lib/jobs/queue.ts:11`            |
| TD-008 | **`dev-local-session` magic string for local auth fallback.** In development mode, when ERPNext is unreachable, `auth.service.ts` returns the literal string `"dev-local-session"` as a session ID. The ERPNext client checks for this string to switch to API key auth. Should be replaced with a typed enum or config flag.                                                                | Low        | Small (< 1 day)   | v1.2     | `src/lib/services/auth.service.ts:71`, `src/lib/data/erpnext.client.ts:52` |
| TD-009 | **No automatic re-encryption on key rotation.** When `ENCRYPTION_KEY` is rotated, old ciphertexts remain encrypted under `ENCRYPTION_KEY_PREVIOUS`. There is no background job to re-encrypt existing records with the new key, so both keys must be kept indefinitely or until all records are naturally rewritten.                                                                         | Medium     | Medium (2-3 days) | v1.2     | `src/lib/encryption.ts:64-81`                                              |
| TD-010 | **Load test CI step may silently skip.** If the server fails to start within 30s (e.g., missing secrets), the load test step exits 0 with a warning. It does not fail the build, so regressions in startup time go undetected.                                                                                                                                                               | Low        | Small (< 1 day)   | v1.2     | `.github/workflows/ci.yml:185-194`                                         |

## Severity Definitions

- **High** -- Actively causing user-facing bugs, security gaps, or blocking features.
- **Medium** -- Increases maintenance burden or masks real problems; not user-facing yet.
- **Low** -- Cosmetic, dead code, or minor DX friction. Fix opportunistically.

## Process

1. When you find tech debt, add a row to this table and reference the source file.
2. During sprint planning, review this list and pull items into the backlog.
3. When an item is resolved, remove it from this table and note the PR in the commit.
