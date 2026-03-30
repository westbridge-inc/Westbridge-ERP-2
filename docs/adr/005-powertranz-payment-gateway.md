# ADR-005: WiPay as Payment Gateway

## Status: Accepted (supersedes PowerTranz)

## Date: 2026-03-30

## Context

The platform needed to accept credit card payments from Caribbean businesses.
Requirements:

- Support for Caribbean currencies: USD, TTD, JMD.
- Hosted payment page (HPP) to minimize PCI scope.
- Reasonable integration complexity for a small team.
- Broad availability in Guyana.

### Historical Context

PowerTranz was originally selected (2026-03-10) as the primary payment gateway
due to its Caribbean focus, native multi-currency support (USD, GYD, TTD, JMD,
XCD, BMD), and HPP flow that reduces PCI scope to SAQ A. However, WiPay was
selected as a replacement for broader Guyana support, simpler integration, and
better local availability for Caribbean merchants.

Options evaluated:

- **Stripe** -- best developer experience, but limited Caribbean currency
  support and not available in all CARICOM territories.
- **2Checkout/Verifone** -- used for initial billing integration, global
  reach but poor Caribbean-specific support.
- **PowerTranz** -- Caribbean-focused processor, native multi-currency,
  but limited local availability in Guyana.
- **WiPay** -- Caribbean payment processor with strong Guyana presence,
  simple hosted page flow, browser redirect callback model.

## Decision

We use **WiPay** as the primary payment gateway, implemented in
`src/lib/data/wipay.client.ts`.

Flow (Hosted Payment Page):

1. Server POSTs to `https://gy.wipayfinancial.com/plugins/payments/request`
   with transaction details, amount, and currency (ISO 4217 alpha codes).
2. WiPay returns a `url` (hosted page URL) and `transaction_id`.
3. Customer's browser is redirected to the WiPay hosted payment page.
4. Customer enters card details on WiPay's domain (PCI scope stays
   with WiPay).
5. WiPay redirects the browser back to `response_url` with query params
   including `status`, `order_id`, `transaction_id`, and `hash`.
6. Server verifies the callback hash (`verifyCallbackHash`), checks
   status (`isPaymentApproved`), and activates the account.
7. Server redirects the browser to the frontend signup success/failure page.

Implementation details:

- **4-tier pricing**: Solo ($49.99), Starter ($199.99), Business ($999.99),
  Enterprise ($4,999.99).
- **Currency**: ISO 4217 alpha codes (USD, TTD, JMD).
- **MD5 hash verification**: Callback hash verified using
  `order_id + status + transaction_id + API key`.
- **Sandbox/live toggle**: `WIPAY_SANDBOX` env var switches between
  `environment=sandbox` and `environment=live`.
- **Fee structure**: `customer_pay` — transaction fees are paid by the
  customer, not absorbed by the merchant.
- **Country code**: Defaults to `GY` (Guyana), configurable via
  `WIPAY_COUNTRY_CODE`.
- **Timeout**: 30s for payment session creation.
- **Browser redirect**: WiPay uses GET redirect (not server POST), so the
  webhook endpoint redirects the browser to the frontend after processing.

## Consequences

### Positive

- Strong local presence and support in Guyana.
- HPP flow keeps card data off our servers entirely (PCI SAQ A).
- Simpler integration than PowerTranz (form-urlencoded POST, browser redirect).
- MD5 hash callback verification prevents forged payment confirmations.
- Browser redirect model is simpler to debug than server-to-server callbacks.

### Negative

- Fewer supported currencies than PowerTranz (USD, TTD, JMD vs. full Caribbean set).
- No server-to-server webhook — relies on browser redirect, which can fail
  if the customer closes their browser mid-redirect. Transaction lookup
  on the WiPay dashboard provides a manual fallback.
- MD5 hash verification is weaker than HMAC-SHA256 (used by PowerTranz),
  but adequate for the redirect callback model.
- No built-in refund API — refunds must be processed through the WiPay
  merchant dashboard.
