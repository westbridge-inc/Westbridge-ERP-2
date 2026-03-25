<p align="center">
  <strong>Westbridge ERP</strong><br>
  Backend API Server
</p>

<p align="center">
  <a href="https://github.com/westbridgeinc/Westbridge-ERP-2/actions/workflows/ci.yml"><img src="https://github.com/westbridgeinc/Westbridge-ERP-2/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/westbridgeinc/Westbridge-ERP-2/actions/workflows/security.yml"><img src="https://github.com/westbridgeinc/Westbridge-ERP-2/actions/workflows/security.yml/badge.svg" alt="Security"></a>
  <img src="https://img.shields.io/badge/TypeScript-strict-blue" alt="TypeScript strict">
  <img src="https://img.shields.io/badge/coverage-90%25%20functions-brightgreen" alt="Coverage">
  <img src="https://img.shields.io/badge/license-proprietary-red" alt="License">
</p>

---

Production-grade API server for the Westbridge ERP platform. Built on Express 5 with TypeScript strict mode, Prisma ORM, Redis-backed sessions, and BullMQ background processing. Serves as the control plane for multi-tenant ERP operations, billing, team management, and Bridge AI.

## Architecture

```
                            ┌──────────────────────────────────────┐
                            │             Clients                  │
                            │   Next.js  /  Mobile  /  Webhooks    │
                            └──────────────────┬───────────────────┘
                                               │ HTTPS
                                               v
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Express 5 API Server (:4000)                        │
│                                                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  ┌───────────────────────┐   │
│  │  Helmet   │  │   CORS   │  │  CSRF (HMAC)  │  │  Rate Limiter         │   │
│  │ (headers) │  │          │  │  double-submit │  │  (Redis sliding-win)  │   │
│  └──────────┘  └──────────┘  └───────────────┘  └───────────────────────┘   │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │                         Route Handlers                               │    │
│  │  auth  signup  erp  billing  team  portal  ai  admin  settings       │    │
│  │  audit  reports  webhooks  sso  totp  documents  analytics  leads    │    │
│  └───────────────────────────────┬──────────────────────────────────────┘    │
│                                  │                                           │
│  ┌───────────────────────────────v──────────────────────────────────────┐    │
│  │                        Service Layer                                 │    │
│  │  AuthService   SessionService   BillingService   SubscriptionService │    │
│  │  AuditService  InviteService    SsoService       DashboardService    │    │
│  │  ErpService    PasswordResetService              ProvisioningService │    │
│  └──────┬──────────────────┬────────────────────────┬──────────────────┘    │
│         │                  │                        │                        │
└─────────┼──────────────────┼────────────────────────┼────────────────────────┘
          │                  │                        │
          v                  v                        v
┌──────────────────┐ ┌──────────────┐ ┌───────────────────────────────────┐
│   PostgreSQL 16  │ │   Redis 7    │ │            ERPNext v16            │
│   (Prisma ORM)   │ │              │ │    (headless ERP data engine)     │
│                  │ │  Sessions    │ │                                   │
│  14 models:      │ │  Cache       │ │  40+ doctypes: Invoices, Orders,  │
│  Account, User,  │ │  Rate limits │ │  Inventory, HR, Manufacturing,   │
│  Session, Audit, │ │  BullMQ jobs │ │  Projects, Procurement           │
│  Subscription,   │ │  AI history  │ │                                   │
│  ApiKey, Invite, │ └──────────────┘ └───────────────────────────────────┘
│  PasswordReset,  │
│  Webhook, Lead,  │        ┌───────────────────────────────────┐
│  SsoConfig,      │        │         Observability             │
│  Notification,   │        │  Pino (structured JSON logging)   │
│  TotpSecret,     │        │  Sentry (error tracking)          │
│  BillingInvoice, │        │  Prometheus (13 custom metrics)   │
│  PortalToken     │        │  OpenTelemetry (distributed trace)│
└──────────────────┘        │  PostHog (product analytics)      │
                            └───────────────────────────────────┘
┌──────────────────┐
│     BullMQ       │        ┌───────────────────────────────────┐
│ Background Jobs  │        │         Bridge AI                 │
│                  │        │  Claude API (Anthropic SDK)        │
│  email           │        │  12 data-access tools             │
│  erp-sync        │        │  Conversation history (Redis)     │
│  reports         │        │  Per-plan usage metering           │
│  cleanup         │        └───────────────────────────────────┘
│  webhooks        │
└──────────────────┘
```

## API Overview

All endpoints are available under `/api/v1/` (canonical) and `/api/` (backwards-compatible alias). Full OpenAPI 3.1 specification served at `/api/docs`.

| Domain       | Description                                         |
| ------------ | --------------------------------------------------- |
| **Auth**     | Login, logout, session validation, 2FA, SSO (OIDC)  |
| **Signup**   | Account registration with payment                   |
| **ERP**      | CRUD for 40+ ERPNext doctypes, batch import, search |
| **Billing**  | Invoice history, subscription, plan changes, cancel |
| **Team**     | Member listing, invitations, role management        |
| **Portal**   | Token-based customer self-service portal            |
| **AI**       | Bridge AI chat with ERP data access tools           |
| **Settings** | Notification preferences, API key management        |
| **Admin**    | Feature flags, BullMQ job queue ops, webhook mgmt   |
| **Reports**  | Async report generation (via BullMQ workers)        |
| **Audit**    | Paginated audit logs with CSV/JSON export           |

See [API.md](API.md) for the complete endpoint reference.

## Getting Started

### Prerequisites

| Tool           | Version  | Notes                                 |
| -------------- | -------- | ------------------------------------- |
| Node.js        | >= 20.19 | LTS recommended; managed via `.nvmrc` |
| npm            | >= 10    | Ships with Node 20+                   |
| Docker Desktop | Latest   | For PostgreSQL, Redis, ERPNext        |
| PostgreSQL     | 16       | Via Docker or standalone              |
| Redis          | 7        | Via Docker or standalone              |

### Installation

```bash
# Clone and install
git clone git@github.com:westbridgeinc/Westbridge-ERP-2.git
cd Westbridge-ERP-2
npm install

# Start infrastructure
docker compose up -d postgres redis

# Configure environment
cp .env.example .env
# Edit .env with your credentials (see comments for each variable)
# Generate secrets: openssl rand -hex 32

# Database setup
npx prisma generate
npx prisma migrate deploy
npx prisma db seed

# Start development server
npm run dev
# => Server listening on http://localhost:4000
```

### Full-Stack Development

To run the complete platform including ERPNext:

```bash
docker compose up -d postgres redis mariadb erpnext redis-erpnext
# Then start the frontend: cd ../Westbridge-ERP-1 && npm run dev
```

### Environment Variables

All configuration is driven by environment variables. Copy `.env.example` and fill in values. Critical secrets must be generated with `openssl rand -hex 32`. See `.env.example` for full documentation of each variable.

Key groups:

- **Database** -- `DATABASE_URL` (PostgreSQL connection string)
- **Redis** -- `REDIS_URL` (session store, cache, job queues)
- **Security** -- `SESSION_SECRET`, `CSRF_SECRET`, `ENCRYPTION_KEY` (all required)
- **ERPNext** -- `ERPNEXT_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`
- **Payments** -- `TWOCHECKOUT_MERCHANT_CODE`, `TWOCHECKOUT_SECRET_KEY`
- **Email** -- SMTP or Resend configuration
- **Observability** -- `SENTRY_DSN`, `POSTHOG_API_KEY`, `LOG_LEVEL`

## Scripts

| Command                   | Description                                  |
| ------------------------- | -------------------------------------------- |
| `npm run dev`             | Start dev server with hot reload (port 4000) |
| `npm run build`           | Compile TypeScript to `dist/`                |
| `npm start`               | Run compiled production server               |
| `npm run typecheck`       | Type-check without emitting                  |
| `npm test`                | Run test suite (Vitest, single run)          |
| `npm run test:watch`      | Run tests in watch mode                      |
| `npm run lint`            | ESLint with TypeScript rules                 |
| `npm run db:migrate`      | Run pending database migrations              |
| `npm run db:migrate:dev`  | Create and apply a new migration             |
| `npm run db:generate`     | Regenerate Prisma client                     |
| `npm run db:seed`         | Seed database with demo data                 |
| `npm run test:load:smoke` | k6 smoke test (quick validation)             |
| `npm run test:load`       | k6 average load test                         |

## Testing

The test suite uses [Vitest](https://vitest.dev) with V8 code coverage.

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# With coverage report
npx vitest run --coverage
```

### Test Organization

```
src/
  lib/
    __tests__/              # Unit tests for services and utilities
    services/__tests__/     # Service layer unit tests
  routes/__tests__/         # Route handler tests (supertest)
  __tests__/
    integration/            # Integration tests (require Postgres + Redis)
```

### Coverage Thresholds

The CI pipeline enforces minimum coverage. Current thresholds:

| Metric     | Threshold |
| ---------- | --------- |
| Statements | 55%       |
| Branches   | 65%       |
| Functions  | 90%       |
| Lines      | 55%       |

Coverage gates are defined in `vitest.config.ts` and are enforced on every pull request.

### Load Testing

Load tests are built with [k6](https://k6.io) and live in `load-tests/`:

```bash
npm run test:load:smoke     # Quick validation (1 VU, 30s)
npm run test:load           # Average load (50 VUs, 5m)
npm run test:load:stress    # Stress test (200 VUs, 10m ramp)
npm run test:load:spike     # Spike test (sudden burst)
```

## Deployment

### Docker

Multi-stage Dockerfile produces a minimal production image (~180MB):

```bash
docker build -t westbridge-erp-api .
docker run -p 4000:4000 --env-file .env westbridge-erp-api
```

The image runs as a non-root user (`westbridge:1001`) and includes a health check at `/api/health`.

### Docker Compose (Full Stack)

```bash
# Production-like stack
docker compose -f docker-compose.production.yml up -d

# Development stack (all services)
docker compose up -d
```

### Platform Support

Deployment configurations are included for:

- **Docker** -- `Dockerfile` with multi-stage build
- **Docker Compose** -- `docker-compose.yml` (dev), `docker-compose.production.yml` (prod)
- **Fly.io** -- `fly.toml` with auto-scaling
- **Railway** -- `railway.json`
- **AWS ECS** -- HA configuration in `docs/`

### Health Checks

The server exposes three health endpoints for orchestrators:

| Endpoint            | Purpose                                          |
| ------------------- | ------------------------------------------------ |
| `/api/health`       | Comprehensive check (Postgres, Redis, disk, mem) |
| `/api/health/live`  | Liveness probe (is the process running?)         |
| `/api/health/ready` | Readiness probe (can the server handle traffic?) |

## Security

Security is foundational to the platform. For full details, see [SECURITY.md](SECURITY.md).

### Authentication & Authorization

- **Session-based auth** with SHA-256 hashed tokens stored in HttpOnly cookies
- **5-tier RBAC** -- owner, admin, manager, member, viewer
- **TOTP two-factor authentication** with encrypted secrets and backup codes
- **Enterprise SSO** via OIDC (Google Workspace, Microsoft Entra, Okta)
- **Session fingerprinting** (User-Agent + IP subnet) with hijack detection
- **Max 5 concurrent sessions** per user with TOCTOU-safe enforcement
- **Account lockout** after repeated failed login attempts

### Data Protection

- **AES-256-GCM encryption** at rest with key rotation support
- **bcrypt password hashing** (12 rounds) with password policy enforcement
- **Multi-tenant isolation** -- all queries scoped by `accountId`
- **Soft deletes** with GDPR right-to-deletion support
- **PII annotations** in Prisma schema for compliance tracking

### API Security

- **CSRF protection** -- double-submit cookie with HMAC-SHA-256
- **Tiered rate limiting** -- Redis sliding-window with per-endpoint configuration
- **Helmet** -- security headers (CSP, HSTS, X-Frame-Options, etc.)
- **Input validation** -- Zod schemas on all endpoints, reject-first
- **Payment webhook verification** -- IPN signature covers 9 critical fields
- **Fail-closed subscription middleware** -- blocks API access for past-due accounts

### Observability & Monitoring

- **Structured logging** -- Pino JSON with request ID propagation
- **Error tracking** -- Sentry with full stack traces and context
- **Metrics** -- 13 custom Prometheus metrics at `/api/metrics`
- **Distributed tracing** -- OpenTelemetry with OTLP export
- **Audit trail** -- every security-relevant action logged with IP, user-agent, outcome

## Project Structure

```
.
├── prisma/
│   ├── schema.prisma          # Database schema (14 models)
│   ├── migrations/            # SQL migration history
│   └── seed.ts                # Demo data seeding
├── src/
│   ├── app.ts                 # Express application factory
│   ├── server.ts              # Server entry point (HTTP + workers)
│   ├── lib/
│   │   ├── ai/                # Bridge AI (Claude integration, tools, context)
│   │   ├── api/               # Rate limiting, cache headers, OpenAPI
│   │   ├── caribbean/         # Regional tax and payroll (Guyana NIS, PAYE, VAT)
│   │   ├── data/              # Data clients (Prisma, ERPNext, 2Checkout)
│   │   ├── email/             # Email service (Resend + SMTP fallback)
│   │   ├── jobs/              # BullMQ queue definitions and Bull Board
│   │   ├── services/          # Business logic (auth, billing, audit, etc.)
│   │   ├── utils/             # Shared utilities (Result type)
│   │   ├── validation/        # Input validation helpers
│   │   ├── constants.ts       # Application constants
│   │   ├── csrf.ts            # CSRF token generation and verification
│   │   ├── encryption.ts      # AES-256-GCM with key rotation
│   │   ├── env.ts             # Environment variable validation
│   │   ├── erp-constants.ts   # Allowed doctypes and module mapping
│   │   ├── feature-flags.ts   # Feature flag evaluation engine
│   │   ├── logger.ts          # Pino logger configuration
│   │   ├── metering.ts        # Usage metering and AI cost estimation
│   │   ├── metrics.ts         # Prometheus metric definitions
│   │   ├── modules.ts         # Plan-to-module mapping (4-tier pricing)
│   │   ├── password-policy.ts # Password strength validation
│   │   ├── rbac.ts            # Role-based access control (5 tiers)
│   │   ├── realtime.ts        # Server-Sent Events pub/sub
│   │   └── redis.ts           # Redis client singleton
│   ├── middleware/
│   │   ├── auth.ts            # Session validation, CSRF, permissions
│   │   └── request-logger.ts  # Per-request logger context
│   ├── routes/                # Express route handlers (25 route files)
│   ├── types/                 # TypeScript types and Zod schemas
│   └── workers/               # BullMQ worker definitions
├── load-tests/                # k6 load test scripts
├── docs/                      # Architecture and compliance documentation
├── scripts/                   # Operational scripts
├── docker-compose.yml         # Development stack
├── docker-compose.production.yml  # Production stack
├── Dockerfile                 # Multi-stage production build
├── fly.toml                   # Fly.io deployment config
└── vitest.config.ts           # Test configuration with coverage thresholds
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code conventions, testing requirements, and the PR process.

## License

Proprietary. Copyright 2025-present Westbridge Inc. All rights reserved. See [LICENSE](LICENSE).
