# ADR-005: Payment Gateway — PowerTranz -> WiPay -> Paddle

## Status: Superseded (migrated to Paddle)

## Date: 2026-03-30

## Context

The platform needed to accept credit card payments from Caribbean businesses.
Requirements:

- Support for global currencies (USD as primary).
- Minimal PCI scope.
- Reasonable integration complexity for a small team.
- Subscription billing with automatic renewals.

### Historical Context

PowerTranz was originally selected (2026-03-10) as the primary payment gateway
due to its Caribbean focus, native multi-currency support (USD, GYD, TTD, JMD,
XCD, BMD), and HPP flow that reduces PCI scope to SAQ A. However, WiPay was
selected as a replacement for broader Guyana support, simpler integration, and
better local availability for Caribbean merchants.

WiPay served as the payment processor using a browser-redirect hosted payment
page model. However, limitations became apparent:

- No server-to-server webhook (relied on browser redirect, fragile).
- MD5 hash verification (weaker than HMAC-SHA256).
- No built-in subscription/recurring billing.
- Limited global reach beyond the Caribbean.
- Renewal flow required manual payment session creation.

Options evaluated:

- **Stripe** -- best developer experience, but limited Caribbean currency
  support and not available in all CARICOM territories.
- **2Checkout/Verifone** -- used for initial billing integration, global
  reach but poor Caribbean-specific support.
- **PowerTranz** -- Caribbean-focused processor, native multi-currency,
  but limited local availability in Guyana.
- **WiPay** -- Caribbean payment processor with strong Guyana presence,
  simple hosted page flow, browser redirect callback model.
- **Paddle** -- Merchant of Record with global reach, built-in subscription
  management, HMAC-SHA256 webhook verification, handles tax/compliance.

## Decision

We use **Paddle** (Billing v2) as the Merchant of Record, implemented in
`src/lib/data/paddle.client.ts`.

### Why Paddle

1. **Merchant of Record**: Paddle handles tax collection, invoicing, and
   compliance globally. We don't need to manage VAT/GST/sales tax.
2. **Built-in subscriptions**: Paddle manages recurring billing, plan
   changes, and cancellations natively. No custom cron for renewals.
3. **Frontend checkout**: Paddle.js overlay handles checkout on the client.
   The backend never sees card data (PCI SAQ A).
4. **Server-to-server webhooks**: POST webhooks with HMAC-SHA256 signature
   verification. Far more reliable than WiPay's browser redirect model.
5. **Global reach**: Supports 200+ countries and territories with
   localized pricing.

### Architecture

Flow (Paddle.js + Webhooks):

1. Frontend opens Paddle.js overlay checkout with a Paddle price ID and
   `custom_data: { accountId }`.
2. Customer completes payment on Paddle's hosted checkout overlay.
3. Paddle sends POST webhook to `/api/webhooks/paddle` with
   `Paddle-Signature` header.
4. Backend verifies HMAC-SHA256 signature using the webhook secret.
5. Backend processes the event:
   - `transaction.completed` -> activate account
   - `subscription.created` -> log subscription
   - `subscription.updated` -> handle plan change
   - `subscription.canceled` -> cancel subscription
6. Backend returns 200 to acknowledge the webhook.

Implementation details:

- **4-tier pricing**: Solo ($49.99), Starter ($199.99), Business ($999.99),
  Enterprise ($4,999.99). Products/prices defined in Paddle dashboard.
- **Signature verification**: HMAC-SHA256 with timing-safe comparison.
  Format: `ts=<timestamp>;h1=<hash>` where hash = HMAC-SHA256 of
  `<timestamp>:<rawBody>`.
- **Sandbox/live toggle**: `PADDLE_SANDBOX` env var switches between
  sandbox and production API endpoints.
- **Idempotency**: Redis-backed dedup on `event_id` (24h TTL).
- **No backend payment session creation**: Checkout is purely frontend.

## Consequences

### Positive

- Merchant of Record eliminates tax/compliance burden.
- Built-in subscription management eliminates custom renewal cron.
- HMAC-SHA256 webhook verification (stronger than WiPay's MD5).
- Server-to-server webhooks (not browser redirect — no lost payments).
- Global currency and territory support.
- Simpler backend — no `createPaymentSession` call needed.
- PCI SAQ A scope maintained (card data never touches our servers).

### Negative

- Paddle takes a larger revenue cut than a pure payment processor.
- Less control over the checkout UI (Paddle.js overlay).
- Products/prices must be configured in the Paddle dashboard.
- Paddle is not Caribbean-specific — customers in Guyana may see
  slightly different payment flows than a local processor.
