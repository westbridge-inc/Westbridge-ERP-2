/**
 * VAT calculation engine — Guyana Revenue Authority compliant.
 *
 * Standard rate: 14% on all taxable goods and services.
 * Zero-rated: exports, basic food items.
 * Exempt: financial services, medical, education.
 */

import { VAT_RATE, GRA_TIN_REGEX, type CaribbeanCurrency } from "./constants.js";
import { Money } from "./money.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VatCalculation {
  netAmount: number;
  vatAmount: number;
  grossAmount: number;
  vatRate: number;
  currency: CaribbeanCurrency;
}

export interface VatLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  vatRate?: number;           // Override per-item (for zero-rated items)
  isExempt?: boolean;
}

export interface VatLineResult {
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  vatRate: number;
  vatAmount: number;
  grossTotal: number;
}

export interface VatInvoiceResult {
  lines: VatLineResult[];
  subtotal: number;
  totalVat: number;
  grandTotal: number;
  currency: CaribbeanCurrency;
}

// ─── Core Calculations ───────────────────────────────────────────────────────

/**
 * Calculate VAT on a net amount.
 *
 * @param netAmount  - Amount before VAT
 * @param currency   - Currency code (default GYD)
 * @param rate       - VAT rate override (default 14%)
 */
export function calculateVat(
  netAmount: number,
  currency: CaribbeanCurrency = "GYD",
  rate: number = VAT_RATE,
): VatCalculation {
  const net = Money.of(netAmount, currency);
  const vat = net.multiply(rate);
  const gross = net.add(vat);

  return {
    netAmount: net.amount,
    vatAmount: vat.amount,
    grossAmount: gross.amount,
    vatRate: rate,
    currency,
  };
}

/**
 * Extract VAT from a VAT-inclusive (gross) amount.
 * Useful for receipts where the displayed price includes VAT.
 */
export function extractVat(
  grossAmount: number,
  currency: CaribbeanCurrency = "GYD",
  rate: number = VAT_RATE,
): VatCalculation {
  const gross = Money.of(grossAmount, currency);
  const net = gross.divide(1 + rate);
  const vat = gross.subtract(net);

  return {
    netAmount: net.amount,
    vatAmount: vat.amount,
    grossAmount: gross.amount,
    vatRate: rate,
    currency,
  };
}

/**
 * Calculate VAT for an entire invoice with line items.
 * Supports per-line VAT rate overrides and exempt items.
 */
export function calculateInvoiceVat(
  items: VatLineItem[],
  currency: CaribbeanCurrency = "GYD",
): VatInvoiceResult {
  let subtotal = Money.zero(currency);
  let totalVat = Money.zero(currency);

  const lines: VatLineResult[] = items.map((item) => {
    const lineTotal = Money.of(item.quantity * item.unitPrice, currency);
    const effectiveRate = item.isExempt ? 0 : (item.vatRate ?? VAT_RATE);
    const vatAmount = lineTotal.multiply(effectiveRate);
    const grossTotal = lineTotal.add(vatAmount);

    subtotal = subtotal.add(lineTotal);
    totalVat = totalVat.add(vatAmount);

    return {
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: lineTotal.amount,
      vatRate: effectiveRate,
      vatAmount: vatAmount.amount,
      grossTotal: grossTotal.amount,
    };
  });

  return {
    lines,
    subtotal: subtotal.amount,
    totalVat: totalVat.amount,
    grandTotal: subtotal.add(totalVat).amount,
    currency,
  };
}

// ─── GRA TIN Validation ─────────────────────────────────────────────────────

/**
 * Validate a Guyana Revenue Authority Tax Identification Number.
 * Format: exactly 10 digits (hyphens and spaces stripped).
 */
export function validateGraTin(tin: string): { valid: boolean; normalized: string } {
  const normalized = tin.replace(/[-\s]/g, "");
  return {
    valid: GRA_TIN_REGEX.test(normalized),
    normalized,
  };
}
