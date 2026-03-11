import { describe, it, expect } from "vitest";
import { calculateVat, extractVat, calculateInvoiceVat, validateGraTin } from "../vat.js";
import { VAT_RATE } from "../constants.js";

describe("VAT Engine", () => {
  describe("calculateVat", () => {
    it("calculates standard 14% VAT on GYD amount", () => {
      const result = calculateVat(100_000, "GYD");
      expect(result.netAmount).toBe(100_000);
      expect(result.vatAmount).toBe(14_000);
      expect(result.grossAmount).toBe(114_000);
      expect(result.vatRate).toBe(0.14);
      expect(result.currency).toBe("GYD");
    });

    it("handles zero amount", () => {
      const result = calculateVat(0, "GYD");
      expect(result.netAmount).toBe(0);
      expect(result.vatAmount).toBe(0);
      expect(result.grossAmount).toBe(0);
    });

    it("handles large amounts (typical GYD values)", () => {
      const result = calculateVat(5_000_000, "GYD");
      expect(result.vatAmount).toBe(700_000);
      expect(result.grossAmount).toBe(5_700_000);
    });

    it("uses default GYD currency when not specified", () => {
      const result = calculateVat(1000);
      expect(result.currency).toBe("GYD");
    });

    it("supports other Caribbean currencies", () => {
      const result = calculateVat(1000, "TTD");
      expect(result.currency).toBe("TTD");
      expect(result.vatAmount).toBe(140);
    });

    it("supports custom VAT rate override", () => {
      const result = calculateVat(100_000, "GYD", 0);
      expect(result.vatAmount).toBe(0);
      expect(result.grossAmount).toBe(100_000);
    });

    it("handles fractional amounts with rounding", () => {
      const result = calculateVat(33.33, "USD");
      expect(result.vatAmount).toBeCloseTo(4.67, 1);
      expect(result.grossAmount).toBeCloseTo(38, 0);
    });

    it("uses the correct default rate constant", () => {
      expect(VAT_RATE).toBe(0.14);
    });
  });

  describe("extractVat", () => {
    it("extracts VAT from a gross amount", () => {
      const result = extractVat(114_000, "GYD");
      expect(result.netAmount).toBeCloseTo(100_000, 0);
      expect(result.vatAmount).toBeCloseTo(14_000, 0);
      expect(result.grossAmount).toBe(114_000);
    });

    it("round-trips with calculateVat", () => {
      const calc = calculateVat(250_000, "GYD");
      const extract = extractVat(calc.grossAmount, "GYD");
      expect(extract.netAmount).toBeCloseTo(250_000, 0);
    });

    it("handles zero gross amount", () => {
      const result = extractVat(0, "GYD");
      expect(result.netAmount).toBe(0);
      expect(result.vatAmount).toBe(0);
    });
  });

  describe("calculateInvoiceVat", () => {
    it("calculates VAT for multiple line items", () => {
      const result = calculateInvoiceVat([
        { description: "Widget A", quantity: 10, unitPrice: 5_000 },
        { description: "Widget B", quantity: 5, unitPrice: 10_000 },
      ]);

      expect(result.subtotal).toBe(100_000);
      expect(result.totalVat).toBe(14_000);
      expect(result.grandTotal).toBe(114_000);
      expect(result.lines).toHaveLength(2);
      expect(result.currency).toBe("GYD");
    });

    it("handles exempt line items", () => {
      const result = calculateInvoiceVat([
        { description: "Taxable item", quantity: 1, unitPrice: 100_000 },
        { description: "Medical supply", quantity: 1, unitPrice: 50_000, isExempt: true },
      ]);

      expect(result.subtotal).toBe(150_000);
      expect(result.totalVat).toBe(14_000); // Only on the taxable item
      expect(result.grandTotal).toBe(164_000);
    });

    it("handles per-item VAT rate overrides (zero-rated exports)", () => {
      const result = calculateInvoiceVat([
        { description: "Local sale", quantity: 1, unitPrice: 100_000 },
        { description: "Export item", quantity: 1, unitPrice: 200_000, vatRate: 0 },
      ]);

      expect(result.totalVat).toBe(14_000); // Only on local sale
    });

    it("supports different currencies", () => {
      const result = calculateInvoiceVat(
        [{ description: "Item", quantity: 1, unitPrice: 100 }],
        "USD",
      );
      expect(result.currency).toBe("USD");
    });

    it("handles empty line items", () => {
      const result = calculateInvoiceVat([]);
      expect(result.subtotal).toBe(0);
      expect(result.totalVat).toBe(0);
      expect(result.grandTotal).toBe(0);
      expect(result.lines).toHaveLength(0);
    });

    it("computes per-line totals correctly", () => {
      const result = calculateInvoiceVat([
        { description: "Bulk order", quantity: 100, unitPrice: 1_500 },
      ]);

      const line = result.lines[0]!;
      expect(line.lineTotal).toBe(150_000);
      expect(line.vatAmount).toBe(21_000);
      expect(line.grossTotal).toBe(171_000);
    });
  });

  describe("validateGraTin", () => {
    it("accepts valid 10-digit TIN", () => {
      const result = validateGraTin("1234567890");
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe("1234567890");
    });

    it("strips hyphens and spaces", () => {
      const result = validateGraTin("123-456-7890");
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe("1234567890");
    });

    it("rejects TIN with wrong length", () => {
      expect(validateGraTin("12345").valid).toBe(false);
      expect(validateGraTin("12345678901").valid).toBe(false);
    });

    it("rejects TIN with non-digit characters", () => {
      expect(validateGraTin("123456789A").valid).toBe(false);
      expect(validateGraTin("ABCDEFGHIJ").valid).toBe(false);
    });

    it("handles empty string", () => {
      expect(validateGraTin("").valid).toBe(false);
    });
  });
});
