# Changelog

All notable changes to the Westbridge ERP Backend will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial changelog following Keep a Changelog format
- Enterprise governance files (SECURITY.md, CODE_OF_CONDUCT.md, CONTRIBUTING.md)
- GitHub issue and PR templates
- CODEOWNERS for automatic review routing

## [0.1.0] - 2026-03-10

### Added
- Express API server with TypeScript strict mode
- Authentication system with session management and CSRF protection
- 5-tier RBAC authorization (owner, admin, manager, member, viewer)
- AES-256-GCM encryption with key rotation support
- ERPNext API proxy integration
- PostgreSQL database with Prisma ORM (9 models)
- Redis caching and BullMQ background workers
- Multi-tenant architecture scoped by accountId
- Caribbean regional tax and payroll module (Guyana NIS, PAYE, VAT)
- Team management with invitation flow
- Billing integration with 2Checkout/Verifone
- AI-powered chat via Claude API
- Comprehensive CI/CD pipeline (typecheck, test, integration test, build, Docker, security scanning)
- Load testing suite with k6 (smoke, average, stress, spike profiles)
- Prometheus metrics (13 custom metrics), Sentry, PostHog, OpenTelemetry
- SOC 2 compliance documentation and evidence mapping
- Deployment automation for Fly.io and AWS ECS
- Health check endpoints (live, ready, full)
- Server-sent events for real-time updates
- Webhook management system
- Security monitoring and event reporting
- Graceful shutdown with ordered resource cleanup
