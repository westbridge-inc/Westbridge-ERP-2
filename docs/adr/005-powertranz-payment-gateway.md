# ADR-005: PowerTranz as Payment Gateway

## Status: Accepted

## Date: 2026-03-10

## Context

The platform needed to accept credit card payments from Caribbean businesses.
Requirements:

- Support for Caribbean currencies: USD, GYD, TTD, JMD, XCD, BMD.
- 3D Secure (3DS) support for PCI DSS compliance.
- Hosted payment page (HPP) to minimize PCI scope.
- Reasonable integration complexity for a small team.

Options evaluated:

- **Stripe** -- best developer experience, but limited Caribbean currency
  support and not available in all CARICOM territories.
- **2Checkout/Verifone** -- used for initial billing integration, global
  reach but poor Caribbean-specific support.
- **PowerTranz** -- Caribbean-focused processor, native multi-currency,
  HPP flow reduces PCI scope to SAQ A.

## Decision

We use **PowerTranz** as the primary payment gateway, implemented in
`src/lib/data/powertranz.client.ts`.

Flow (SPI Hosted Payment Page):

1. Server calls `POST /Api/Spi/Auth` with transaction details, amount, and
   currency (ISO 4217 numeric codes).
2. PowerTranz returns an `SpiToken` and redirect URL.
3. Customer's browser is redirected to the PowerTranz hosted payment page.
4. Customer enters card details on PowerTranz's domain (PCI scope stays
   with PowerTranz).
5. PowerTranz redirects back to `MerchantResponseUrl` with the result.
6. Server verifies the callback (`isPaymentApproved`) and activates the
   account.

Implementation details:

- **4-tier pricing**: Solo ($49.99), Starter ($199.99), Business ($999.99),
  Enterprise ($4,999.99).
- **Currency mapping**: ISO 4217 numeric codes (840=USD, 328=GYD, 780=TTD,
  388=JMD, 951=XCD, 060=BMD).
- **3D Secure**: Always enabled (`ThreeDSecure: true`).
- **HMAC verification**: Callback signatures verified with `timingSafeEqual`
  to prevent timing attacks.
- **Test/production toggle**: `POWERTRANZ_TEST_MODE` switches between
  `staging.ptranz.com` and `ptranz.com`.
- **Refund support**: `refundTransaction()` for full or partial refunds.
- **Timeout**: 30s for payment sessions, 15s for transaction lookups.

## Consequences

### Positive

- Native support for all target Caribbean currencies.
- HPP flow keeps card data off our servers entirely (PCI SAQ A).
- 3DS reduces chargeback liability.
- HMAC callback verification prevents forged payment confirmations.

### Negative

- PowerTranz documentation is less polished than Stripe's; integration
  required some trial-and-error.
- Staging environment can be slow or intermittent.
- No webhook-based async notifications -- we rely on the synchronous
  redirect callback, which can fail if the customer closes their browser
  mid-redirect. Transaction lookup (`getTransaction`) provides a fallback.
