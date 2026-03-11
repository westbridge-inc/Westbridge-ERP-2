/**
 * Money value object — GYD-first, multi-currency.
 *
 * All monetary arithmetic is done in the smallest unit (cents) as integers
 * to avoid floating-point rounding errors.  The public API accepts and
 * returns human-readable decimals; conversion happens internally.
 *
 * Usage:
 *   const price = Money.of(100_000, "GYD");
 *   const vat   = price.multiply(0.14);
 *   const total = price.add(vat);
 *   console.log(total.format()); // "GY$ 114,000.00"
 */

import { DEFAULT_CURRENCY, type CaribbeanCurrency, SUPPORTED_CURRENCIES } from "./constants.js";

// ─── Currency metadata ───────────────────────────────────────────────────────

interface CurrencyInfo {
  symbol: string;
  decimals: number;
  locale: string;
}

const CURRENCY_INFO: Record<CaribbeanCurrency, CurrencyInfo> = {
  GYD: { symbol: "GY$", decimals: 2, locale: "en-GY" },
  USD: { symbol: "$",   decimals: 2, locale: "en-US" },
  TTD: { symbol: "TT$", decimals: 2, locale: "en-TT" },
  BBD: { symbol: "BD$", decimals: 2, locale: "en-BB" },
  JMD: { symbol: "J$",  decimals: 2, locale: "en-JM" },
  XCD: { symbol: "EC$", decimals: 2, locale: "en-AG" },
};

// ─── Money class ─────────────────────────────────────────────────────────────

export class Money {
  /** Amount stored as integer cents to avoid floating-point issues */
  private readonly cents: number;
  readonly currency: CaribbeanCurrency;

  private constructor(cents: number, currency: CaribbeanCurrency) {
    if (!Number.isFinite(cents)) {
      throw new Error(`Money: amount must be finite, got ${cents}`);
    }
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      throw new Error(`Money: unsupported currency "${currency}"`);
    }
    this.cents = Math.round(cents);
    this.currency = currency;
  }

  // ── Factories ────────────────────────────────────────────────────────────

  /** Create Money from a human-readable decimal amount (e.g. 100_000.50). */
  static of(amount: number, currency: CaribbeanCurrency = DEFAULT_CURRENCY): Money {
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      throw new Error(`Money: unsupported currency "${currency}"`);
    }
    const info = CURRENCY_INFO[currency];
    const factor = 10 ** info.decimals;
    return new Money(Math.round(amount * factor), currency);
  }

  /** Create Money representing zero. */
  static zero(currency: CaribbeanCurrency = DEFAULT_CURRENCY): Money {
    return new Money(0, currency);
  }

  /** Create Money from cents (integer). */
  static fromCents(cents: number, currency: CaribbeanCurrency = DEFAULT_CURRENCY): Money {
    return new Money(cents, currency);
  }

  // ── Arithmetic ───────────────────────────────────────────────────────────

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  /** Multiply by a scalar (e.g. tax rate). */
  multiply(factor: number): Money {
    return new Money(Math.round(this.cents * factor), this.currency);
  }

  /** Divide by a scalar. Rounds to nearest cent. */
  divide(divisor: number): Money {
    if (divisor === 0) throw new Error("Money: cannot divide by zero");
    return new Money(Math.round(this.cents / divisor), this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  abs(): Money {
    return new Money(Math.abs(this.cents), this.currency);
  }

  // ── Comparisons ──────────────────────────────────────────────────────────

  isZero(): boolean {
    return this.cents === 0;
  }

  isPositive(): boolean {
    return this.cents > 0;
  }

  isNegative(): boolean {
    return this.cents < 0;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents > other.cents;
  }

  lessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  // ── Accessors ────────────────────────────────────────────────────────────

  /** The human-readable decimal amount (e.g. 100000.50). */
  get amount(): number {
    const info = CURRENCY_INFO[this.currency];
    return this.cents / 10 ** info.decimals;
  }

  /** Integer cents value for storage / wire transfer. */
  toCents(): number {
    return this.cents;
  }

  // ── Formatting ───────────────────────────────────────────────────────────

  /** Format for display: "GY$ 1,250,000.00" */
  format(): string {
    const info = CURRENCY_INFO[this.currency];
    const formatted = this.amount.toLocaleString("en-US", {
      minimumFractionDigits: info.decimals,
      maximumFractionDigits: info.decimals,
    });
    return `${info.symbol} ${formatted}`;
  }

  /** JSON-safe serialization */
  toJSON(): { amount: number; currency: CaribbeanCurrency } {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return this.format();
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Money: cannot combine ${this.currency} with ${other.currency}. Convert first.`
      );
    }
  }
}

export { CURRENCY_INFO };
