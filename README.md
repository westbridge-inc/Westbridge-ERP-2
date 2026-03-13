# Westbridge ERP — Backend API

[![CI](https://github.com/westbridgeinc/Westbridge-ERP-2/actions/workflows/ci.yml/badge.svg)](https://github.com/westbridgeinc/Westbridge-ERP-2/actions/workflows/ci.yml)
[![Security](https://github.com/westbridgeinc/Westbridge-ERP-2/actions/workflows/security.yml/badge.svg)](https://github.com/westbridgeinc/Westbridge-ERP-2/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Express.js API server for the Westbridge ERP platform.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Clients                                    │
│              (Next.js Frontend / Mobile / Third-Party)              │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTPS
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Express.js API Server                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────────┐   │
│  │  Helmet   │  │   CORS   │  │   CSRF   │  │   Rate Limiter    │   │
│  │ (Headers) │  │          │  │  (HMAC)  │  │ (Redis Sliding W) │   │
│  └──────────┘  └──────────┘  └──────────┘  └───────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    Route Handlers                            │    │
│  │  auth · signup · erp · team · billing · admin · ai · audit  │    │
│  └─────────────────────────┬───────────────────────────────────┘    │
│                            │                                        │
│  ┌─────────────────────────▼───────────────────────────────────┐    │
│  │                    Service Layer                              │    │
│  │  AuthService · SessionService · AuditService · PasswordReset │    │
│  │  RBAC (5-tier) · Encryption (AES-256-GCM) · PasswordPolicy  │    │
│  └──────────┬──────────────┬────────────────────┬──────────────┘    │
│             │              │                    │                    │
└─────────────┼──────────────┼────────────────────┼───────────────────┘
              │              │                    │
              ▼              ▼                    ▼
┌──────────────────┐ ┌──────────────┐ ┌───────────────────────────┐
│   PostgreSQL     │ │    Redis     │ │       ERPNext             │
│   (Prisma ORM)   │ │  (Sessions,  │ │   (Business Data via      │
│                  │ │  Rate Limits,│ │    REST API)              │
│  9 Models:       │ │  BullMQ Jobs)│ │                           │
│  Account, User,  │ │              │ │  Invoices, Inventory,     │
│  Session, Audit, │ └──────────────┘ │  HR, Procurement, etc.    │
│  Subscription,   │                  └───────────────────────────┘
│  ApiKey, Invite, │
│  PasswordReset,  │        ┌───────────────────────────────┐
│  Webhook         │        │       Observability           │
└──────────────────┘        │  Pino (structured logging)    │
                            │  Sentry (error tracking)      │
┌──────────────────┐        │  Prometheus (metrics)         │
│    BullMQ        │        │  OpenTelemetry (tracing)      │
│  Background Jobs │        │  PostHog (product analytics)  │
│  (Redis-backed)  │        └───────────────────────────────┘
└──────────────────┘
```

## Setup

```bash
npm install
cp .env.example .env  # Edit with your credentials
npx prisma generate
npx prisma migrate deploy
npm run dev
```

## Scripts

- `npm run dev` — Start dev server with hot reload (port 4000)
- `npm run build` — Compile TypeScript
- `npm start` — Run compiled server
- `npm run typecheck` — Type check without emitting
- `npm run db:migrate` — Run database migrations
- `npm run db:generate` — Regenerate Prisma client

## API Routes

All routes are prefixed with `/api/`:

- `/api/auth/*` — Authentication (login, logout, validate, password reset)
- `/api/signup` — Account registration
- `/api/csrf` — CSRF token generation
- `/api/erp/*` — ERP data (list, doc, dashboard)
- `/api/invite/*` — Team invitations
- `/api/admin/*` — Admin operations (flags, jobs, webhooks)
- `/api/audit/*` — Audit logs
- `/api/team` — Team management
- `/api/account/*` — Account profile and deletion
- `/api/billing/*` — Billing history
- `/api/ai/*` — AI chat and usage
- `/api/analytics/*` — Product analytics
- `/api/health/*` — Health checks
- `/api/events/stream` — Server-sent events
- `/api/webhooks/*` — Payment webhooks
- `/api/metrics` — Prometheus metrics
- `/api/usage` — Usage stats
- `/api/docs` — OpenAPI spec
