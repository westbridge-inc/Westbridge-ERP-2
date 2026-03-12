## Summary
<!-- Brief description of what this PR does -->

## Type of Change
- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update
- [ ] Refactoring (no functional changes)
- [ ] Security patch
- [ ] Database migration
- [ ] Dependency update

## Related Issues
<!-- Link to related issues: Closes #123 -->

## Changes Made
<!-- List the key changes made -->
-

## Testing
- [ ] Unit tests added/updated
- [ ] Integration tests added/updated (if applicable)
- [ ] Manual testing completed with local Docker stack
- [ ] All existing tests pass (`npm test`)
- [ ] Load tests verified (if performance-sensitive)

## Quality Checklist
- [ ] Code follows project conventions (see [CONTRIBUTING.md](../CONTRIBUTING.md))
- [ ] TypeScript strict mode — no `any` types
- [ ] No `console.log` statements (use `logger` from `lib/logger.ts`)
- [ ] Zod schemas updated for request/response changes
- [ ] API routes use `apiSuccess` / `apiError` response helpers
- [ ] Rate limiting applied to new endpoints
- [ ] DB queries scoped by `accountId` for multi-tenancy

## Security Checklist (if applicable)
- [ ] No secrets or credentials committed
- [ ] Input validation with Zod for all user inputs
- [ ] Authentication checked (`validateSession`)
- [ ] Authorization checked (RBAC permissions verified)
- [ ] SQL injection prevention (parameterized queries via Prisma)
- [ ] Security headers applied (`securityHeaders()`)

## Database Changes (if applicable)
- [ ] Migration created (`npx prisma migrate dev`)
- [ ] Migration is reversible
- [ ] Indexes added for new query patterns
- [ ] No breaking schema changes without migration plan

## API Response Examples (if applicable)
<!-- Add response examples for API changes -->
