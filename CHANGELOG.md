# Changelog

All notable changes to the Westbridge ERP Backend will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Work on `feat/team-management` branch.

### Added

- **Team**: Member removal, role changes, invite management, and per-plan seat limits
- **Auth**: Block API access for `past_due` and `canceled` subscriptions (returns 402)
- **Infrastructure**: Provisioning retry with exponential backoff and error notification

### Changed

- **AI**: Update Claude models to latest (sonnet-4-6, opus-4-6)

### Fixed

- **Infrastructure**: Require email provider (RESEND_API_KEY or SMTP) in production env validation

## [0.9.0] - 2026-03-15

### Added

- **Auth**: E2E test foundation for API-level integration testing
- **Observability**: Per-request logger context middleware with request ID propagation

### Changed

- **ERP**: Extract tenant isolation to shared helper for consistent `accountId` scoping
- **Auth**: Extract change-password logic to dedicated auth service module

### Fixed

- **Security**: Validate `accountId` on analytics endpoints to prevent cross-tenant data access
- **Auth**: Apply `requireAuth` middleware to AI history and account routes
- **CI**: Remove ERPNext health check from CI (requires pre-configured site)

### Security

- Security hardening pass: graceful ERPNext error handling, input validation tightening

## [0.8.0] - 2026-03-12

### Added

- **Testing**: 90%+ function coverage (780 tests across 18 new test files)
- **Billing**: Payment flow tests for PowerTranz integration
- **Team**: GDPR account deletion and invite acceptance tests

### Fixed

- Preserve error cause chain in encryption module for better debugging
- Clean all lint warnings, add missing `beforeAll` imports

## [0.7.0] - 2026-03-10

### Added

- **Billing**: 4-tier pricing backend (Solo $49.99, Starter $199.99, Business $999.99, Enterprise $4,999.99)
- **Auth**: Enterprise SSO via OIDC (Google Workspace, Microsoft Entra, Okta)
- **Infrastructure**: HA auto-scaling configuration for Fly.io and AWS ECS
- **Testing**: Coverage raised from 45% to 63% over two rounds (79+ new tests)
- Enterprise governance files (SECURITY.md, CODE_OF_CONDUCT.md, CONTRIBUTING.md)
- GitHub issue and PR templates, CODEOWNERS for automatic review routing

### Changed

- License changed from MIT to proprietary source-available

### Fixed

- Remove CodeQL job (requires Advanced Security), re-add on public repo confirmation

## [0.1.0] - 2026-02-15

### Added

#### Auth & Security

- Session-based authentication with SHA-256 hashed tokens and HttpOnly cookies
- 5-tier RBAC authorization (owner, admin, manager, member, viewer)
- CSRF protection with double-submit cookie pattern
- AES-256-GCM encryption with key rotation support (`ENCRYPTION_KEY_PREVIOUS`)
- TOTP-based two-factor authentication
- Password policy enforcement with bcrypt (12 rounds)
- Session fingerprinting (User-Agent + IP /24) for hijack detection
- Max 5 concurrent sessions with TOCTOU-safe enforcement

#### ERP Integration

- ERPNext API proxy with session cookie relay
- CRUD operations (list, get, create, update, delete) for all ERPNext doctypes
- Tenant isolation via company filter injection
- Retry with exponential backoff for transient upstream errors
- Caribbean regional tax and payroll module (Guyana NIS, PAYE, VAT)

#### AI

- AI-powered chat via Claude API (Anthropic SDK)
- Conversation history persistence

#### Billing & Payments

- PowerTranz payment gateway integration (HPP flow)
- Multi-currency support (USD, GYD, TTD, JMD, XCD, BMD)
- 3D Secure enabled for all transactions
- HMAC callback signature verification

#### Team & Accounts

- Multi-tenant architecture scoped by `accountId`
- Team invitation flow with email delivery
- Account provisioning and onboarding

#### Infrastructure

- Express 5 API server with TypeScript strict mode
- PostgreSQL database with Prisma ORM
- Redis caching and BullMQ background workers (email, erp-sync, reports, cleanup, webhooks)
- Prometheus metrics (13 custom metrics), Sentry error tracking, PostHog analytics
- OpenTelemetry distributed tracing
- Structured JSON logging via Pino
- Health check endpoints (live, ready, full)
- Server-sent events for real-time updates
- Webhook management system with retry
- Graceful shutdown with ordered resource cleanup
- Docker containerization
- CI/CD pipeline (typecheck, lint, test, integration test, build, Docker, security scanning)
- Load testing suite with k6 (smoke, average, stress, spike profiles)
- SOC 2 compliance documentation and evidence mapping
- Deployment automation for Fly.io and AWS ECS

[Unreleased]: https://github.com/westbridge-inc/erp-backend/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/westbridge-inc/erp-backend/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/westbridge-inc/erp-backend/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/westbridge-inc/erp-backend/compare/v0.1.0...v0.7.0
[0.1.0]: https://github.com/westbridge-inc/erp-backend/releases/tag/v0.1.0
