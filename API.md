# API Reference

Westbridge ERP Backend API. All endpoints are served under `/api/v1/` (canonical) and `/api/` (backwards-compatible alias).

For request/response schemas, see the OpenAPI 3.1 specification at `/api/docs`.

---

## Base URL

```
https://api.westbridge.co/api/v1
```

Development: `http://localhost:4000/api/v1`

## Authentication

Most endpoints require session-based authentication. Authenticate by calling `POST /auth/login`, which sets an HttpOnly cookie (`westbridge_sid`). All subsequent requests include this cookie automatically.

State-changing requests (POST, PUT, DELETE, PATCH) also require a CSRF token. Obtain one from `GET /csrf` and include it in the `X-CSRF-Token` header.

## Response Format

All responses follow a consistent envelope:

```json
{
  "ok": true,
  "data": { ... },
  "meta": {
    "request_id": "req_abc123",
    "timestamp": "2026-03-20T12:00:00.000Z"
  }
}
```

Error responses:

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION",
    "message": "Email is required"
  }
}
```

## Rate Limiting

All endpoints are rate-limited via Redis sliding-window counters. Rate limit headers are included in responses:

| Header                  | Description                     |
| ----------------------- | ------------------------------- |
| `X-RateLimit-Limit`     | Maximum requests in the window  |
| `X-RateLimit-Remaining` | Requests remaining              |
| `X-RateLimit-Reset`     | Seconds until the window resets |

---

## Auth

| Method | Path                    | Auth    | Description                                       |
| ------ | ----------------------- | ------- | ------------------------------------------------- |
| POST   | `/auth/login`           | None    | Authenticate with email and password              |
| POST   | `/auth/logout`          | Session | Revoke the current session                        |
| GET    | `/auth/validate`        | Session | Validate the current session and return user info |
| POST   | `/auth/forgot-password` | None    | Request a password reset email                    |
| POST   | `/auth/reset-password`  | None    | Apply a password reset using a token              |
| POST   | `/auth/change-password` | Session | Change password (requires current password)       |

## Two-Factor Authentication

| Method | Path                | Auth    | Description                            |
| ------ | ------------------- | ------- | -------------------------------------- |
| POST   | `/auth/2fa/setup`   | Session | Generate TOTP secret and QR code URI   |
| POST   | `/auth/2fa/verify`  | Session | Verify TOTP code and enable 2FA        |
| POST   | `/auth/2fa/disable` | Session | Disable 2FA for the authenticated user |

## SSO (Enterprise)

| Method | Path             | Auth  | Description                                   |
| ------ | ---------------- | ----- | --------------------------------------------- |
| GET    | `/sso/authorize` | None  | Redirect to the configured identity provider  |
| GET    | `/sso/callback`  | None  | Handle IdP callback and create session        |
| GET    | `/sso/config`    | Admin | Get SSO configuration for the current account |
| PUT    | `/sso/config`    | Admin | Update SSO configuration (OIDC settings)      |

## Signup

| Method | Path      | Auth | Description                         |
| ------ | --------- | ---- | ----------------------------------- |
| POST   | `/signup` | None | Register a new account with payment |

## CSRF

| Method | Path    | Auth | Description                                        |
| ------ | ------- | ---- | -------------------------------------------------- |
| GET    | `/csrf` | None | Generate a CSRF token (returned via cookie + body) |

## ERP

| Method | Path             | Auth    | Description                                    |
| ------ | ---------------- | ------- | ---------------------------------------------- |
| GET    | `/erp/list`      | Session | List documents of a given doctype (paginated)  |
| GET    | `/erp/doc`       | Session | Get a single document by doctype and name      |
| POST   | `/erp/doc`       | Session | Create a new document                          |
| PUT    | `/erp/doc`       | Session | Update an existing document                    |
| DELETE | `/erp/doc`       | Session | Delete a document                              |
| POST   | `/erp/batch`     | Session | Batch create documents (up to 100 per request) |
| GET    | `/erp/dashboard` | Session | Get dashboard summary data                     |

### Supported Doctypes

Sales Invoice, Sales Order, Purchase Invoice, Purchase Order, Quotation, Customer, Supplier, Item, Employee, Journal Entry, Payment Entry, Stock Entry, Expense Claim, Leave Application, Salary Slip, BOM, Company, Account, Warehouse, Stock Ledger Entry, Opportunity, Project, Task, Timesheet, Attendance.

Access to doctypes is controlled by your plan tier.

## Billing

| Method | Path                    | Auth    | Description                                   |
| ------ | ----------------------- | ------- | --------------------------------------------- |
| GET    | `/billing/history`      | Session | List billing invoices for the current account |
| GET    | `/billing/subscription` | Session | Get current subscription details              |
| POST   | `/billing/change-plan`  | Session | Upgrade or downgrade the subscription plan    |
| POST   | `/billing/cancel`       | Session | Cancel the current subscription               |

## Team

| Method | Path             | Auth    | Description                                          |
| ------ | ---------------- | ------- | ---------------------------------------------------- |
| GET    | `/team`          | Session | List all team members in the current account         |
| DELETE | `/team/:id`      | Session | Remove a team member (soft-delete + revoke sessions) |
| PATCH  | `/team/:id/role` | Session | Change a team member's role                          |

## Invitations

| Method | Path               | Auth    | Description                                      |
| ------ | ------------------ | ------- | ------------------------------------------------ |
| POST   | `/invite`          | Session | Send a team invitation email                     |
| GET    | `/invite/validate` | None    | Validate an invitation token                     |
| POST   | `/invite/accept`   | None    | Accept an invitation and create user account     |
| GET    | `/invite/list`     | Session | List pending invitations for the current account |
| DELETE | `/invite/:id`      | Session | Revoke a pending invitation                      |

## Portal (Customer Self-Service)

| Method | Path                        | Auth         | Description                                 |
| ------ | --------------------------- | ------------ | ------------------------------------------- |
| POST   | `/portal/invite`            | Session      | Generate portal token and email to customer |
| GET    | `/portal/validate`          | Portal Token | Validate a portal access token              |
| GET    | `/portal/invoices`          | Portal Token | List the customer's Sales Invoices          |
| GET    | `/portal/quotations`        | Portal Token | List the customer's Quotations              |
| GET    | `/portal/orders`            | Portal Token | List the customer's Sales Orders            |
| POST   | `/portal/quotations/accept` | Portal Token | Accept a quotation                          |
| GET    | `/portal/invoice-pdf`       | Portal Token | Download an invoice as PDF                  |

## AI (Bridge AI)

| Method | Path        | Auth    | Description                                       |
| ------ | ----------- | ------- | ------------------------------------------------- |
| POST   | `/ai/chat`  | Session | Send a message to Bridge AI (ERP-aware assistant) |
| GET    | `/ai/usage` | Session | Get AI usage stats for the current account        |

## Settings

| Method | Path                      | Auth    | Description                           |
| ------ | ------------------------- | ------- | ------------------------------------- |
| GET    | `/settings/notifications` | Session | Get notification preferences          |
| PUT    | `/settings/notifications` | Session | Update notification preferences       |
| GET    | `/settings/api-keys`      | Session | List API keys for the current account |
| POST   | `/settings/api-keys`      | Session | Create a new API key                  |
| DELETE | `/settings/api-keys/:id`  | Session | Revoke an API key                     |

## Account

| Method | Path               | Auth    | Description                                          |
| ------ | ------------------ | ------- | ---------------------------------------------------- |
| PATCH  | `/account/profile` | Session | Update the current user's profile                    |
| DELETE | `/account/delete`  | Owner   | Delete account and all data (GDPR right-to-deletion) |

## Audit

| Method | Path            | Auth    | Description                                  |
| ------ | --------------- | ------- | -------------------------------------------- |
| GET    | `/audit`        | Session | Paginated audit logs for the current account |
| GET    | `/audit/export` | Session | Stream audit log export (CSV or JSON format) |

## Reports

| Method | Path              | Auth    | Description                                    |
| ------ | ----------------- | ------- | ---------------------------------------------- |
| POST   | `/reports`        | Session | Enqueue an async report generation job         |
| GET    | `/reports`        | Session | List completed reports for the current account |
| GET    | `/reports/:jobId` | Session | Get a specific report result by job ID         |

## Documents

| Method | Path              | Auth    | Description                            |
| ------ | ----------------- | ------- | -------------------------------------- |
| GET    | `/erp/doc/pdf`    | Session | Generate PDF for an ERPNext document   |
| POST   | `/erp/doc/email`  | Session | Email a document as PDF attachment     |
| POST   | `/erp/doc/upload` | Session | Upload a file attachment to a document |

## Admin

| Method | Path                         | Auth  | Description                                 |
| ------ | ---------------------------- | ----- | ------------------------------------------- |
| GET    | `/admin/flags`               | Admin | List all feature flags                      |
| PUT    | `/admin/flags`               | Admin | Update a feature flag                       |
| GET    | `/admin/jobs`                | Admin | BullMQ queue stats for all queues           |
| POST   | `/admin/jobs/:id/retry`      | Admin | Retry a specific failed job                 |
| POST   | `/admin/webhooks/:id/enable` | Admin | Re-enable a circuit-broken webhook endpoint |

The BullMQ dashboard is available at `/admin/queues` (requires admin session).

## Webhooks (Inbound)

| Method | Path                | Auth              | Description                            |
| ------ | ------------------- | ----------------- | -------------------------------------- |
| POST   | `/webhooks/payment` | IPN Signature     | 2Checkout Instant Payment Notification |
| POST   | `/webhooks/erpnext` | HMAC Verification | ERPNext document change webhook        |

## Analytics

| Method | Path                | Auth    | Description                      |
| ------ | ------------------- | ------- | -------------------------------- |
| POST   | `/analytics/track`  | Session | Receive product analytics events |
| POST   | `/analytics/vitals` | Session | Receive Core Web Vitals data     |

## Leads

| Method | Path                | Auth | Description                 |
| ------ | ------------------- | ---- | --------------------------- |
| POST   | `/leads/demo`       | None | Submit a demo request       |
| POST   | `/leads/newsletter` | None | Subscribe to the newsletter |

## Events

| Method | Path             | Auth    | Description                                     |
| ------ | ---------------- | ------- | ----------------------------------------------- |
| GET    | `/events/stream` | Session | Server-Sent Events stream for real-time updates |

## Infrastructure

| Method | Path            | Auth         | Description                        |
| ------ | --------------- | ------------ | ---------------------------------- |
| GET    | `/health`       | None         | Comprehensive health check         |
| GET    | `/health/live`  | None         | Liveness probe (K8s/ECS)           |
| GET    | `/health/ready` | None         | Readiness probe (K8s/ECS)          |
| GET    | `/metrics`      | Bearer Token | Prometheus metrics scrape endpoint |
| GET    | `/usage`        | Session      | Billing-period usage statistics    |
| GET    | `/docs`         | None         | OpenAPI 3.1 JSON specification     |

---

## Error Codes

| Code           | HTTP Status | Description                                 |
| -------------- | ----------- | ------------------------------------------- |
| `VALIDATION`   | 400         | Request body failed schema validation       |
| `BAD_REQUEST`  | 400         | Malformed request                           |
| `UNAUTHORIZED` | 401         | Missing or invalid session                  |
| `FORBIDDEN`    | 403         | Insufficient permissions or tenant mismatch |
| `NOT_FOUND`    | 404         | Resource not found                          |
| `RATE_LIMIT`   | 429         | Rate limit exceeded                         |
| `ERP_ERROR`    | 502         | Upstream ERPNext error                      |
| `SERVER_ERROR` | 500         | Internal server error                       |
