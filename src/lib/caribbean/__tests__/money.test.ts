import { describe, it, expect } from "vitest";
import { Money } from "../money.js";

describe("Money Value Object", () => {
  describe("creation", () => {
    it("creates Money from decimal amount", () => {
      const m = Money.of(100_000, "GYD");
      expect(m.amount).toBe(100_000);
      expect(m.currency).toBe("GYD");
    });

    it("defaults to GYD currency", () => {
      const m = Money.of(1000);
      expect(m.currency).toBe("GYD");
    });

    it("creates zero Money", () => {
      const m = Money.zero("USD");
      expect(m.amount).toBe(0);
      expect(m.currency).toBe("USD");
    });

    it("creates from cents", () => {
      const m = Money.fromCents(10050, "USD");
      expect(m.amount).toBe(100.50);
    });

    it("throws on non-finite amount", () => {
      expect(() => Money.of(Infinity)).toThrow("must be finite");
      expect(() => Money.of(NaN)).toThrow("must be finite");
    });

    it("throws on unsupported currency", () => {
      expect(() => Money.of(100, "ZZZ" as never)).toThrow("unsupported currency");
    });

    it("supports all Caribbean currencies", () => {
      expect(() => Money.of(1, "GYD")).not.toThrow();
      expect(() => Money.of(1, "USD")).not.toThrow();
      expect(() => Money.of(1, "TTD")).not.toThrow();
      expect(() => Money.of(1, "BBD")).not.toThrow();
      expect(() => Money.of(1, "JMD")).not.toThrow();
      expect(() => Money.of(1, "XCD")).not.toThrow();
    });
  });

  describe("arithmetic", () => {
    it("adds two Money values", () => {
      const a = Money.of(100_000, "GYD");
      const b = Money.of(50_000, "GYD");
      expect(a.add(b).amount).toBe(150_000);
    });

    it("subtracts Money values", () => {
      const a = Money.of(100_000, "GYD");
      const b = Money.of(30_000, "GYD");
      expect(a.subtract(b).amount).toBe(70_000);
    });

    it("multiplies by scalar (tax rate)", () => {
      const price = Money.of(100_000, "GYD");
      const vat = price.multiply(0.14);
      expect(vat.amount).toBe(14_000);
    });

    it("divides by scalar", () => {
      const total = Money.of(114_000, "GYD");
      const split = total.divide(3);
      expect(split.amount).toBe(38_000);
    });

    it("throws on divide by zero", () => {
      expect(() => Money.of(100).divide(0)).toThrow("cannot divide by zero");
    });

    it("negates a value", () => {
      const m = Money.of(500, "GYD");
      expect(m.negate().amount).toBe(-500);
    });

    it("takes absolute value", () => {
      const m = Money.of(-500, "GYD");
      expect(m.abs().amount).toBe(500);
    });

    it("prevents cross-currency arithmetic", () => {
      const gyd = Money.of(1000, "GYD");
      const usd = Money.of(5, "USD");
      expect(() => gyd.add(usd)).toThrow("cannot combine GYD with USD");
    });

    it("handles floating-point precision", () => {
      // 0.1 + 0.2 !== 0.3 in JavaScript, but Money handles it
      const a = Money.of(0.1, "USD");
      const b = Money.of(0.2, "USD");
      expect(a.add(b).amount).toBe(0.3);
    });
  });

  describe("comparisons", () => {
    it("checks zero", () => {
      expect(Money.zero().isZero()).toBe(true);
      expect(Money.of(1).isZero()).toBe(false);
    });

    it("checks positive", () => {
      expect(Money.of(100).isPositive()).toBe(true);
      expect(Money.of(-100).isPositive()).toBe(false);
      expect(Money.zero().isPositive()).toBe(false);
    });

    it("checks negative", () => {
      expect(Money.of(-100).isNegative()).toBe(true);
      expect(Money.of(100).isNegative()).toBe(false);
    });

    it("checks equality", () => {
      const a = Money.of(100, "GYD");
      const b = Money.of(100, "GYD");
      const c = Money.of(100, "USD");
      expect(a.equals(b)).toBe(true);
      expect(a.equals(c)).toBe(false); // Different currency
    });

    it("checks greater than", () => {
      expect(Money.of(200).greaterThan(Money.of(100))).toBe(true);
      expect(Money.of(100).greaterThan(Money.of(200))).toBe(false);
    });

    it("checks less than", () => {
      expect(Money.of(100).lessThan(Money.of(200))).toBe(true);
      expect(Money.of(200).lessThan(Money.of(100))).toBe(false);
    });

    it("prevents cross-currency comparison", () => {
      expect(() => Money.of(100, "GYD").greaterThan(Money.of(1, "USD"))).toThrow();
    });
  });

  describe("formatting", () => {
    it("formats GYD", () => {
      expect(Money.of(1_250_000, "GYD").format()).toBe("GY$ 1,250,000.00");
    });

    it("formats USD", () => {
      expect(Money.of(99.99, "USD").format()).toBe("$ 99.99");
    });

    it("formats TTD", () => {
      expect(Money.of(5_000, "TTD").format()).toBe("TT$ 5,000.00");
    });

    it("formats BBD", () => {
      expect(Money.of(1_000, "BBD").format()).toBe("BD$ 1,000.00");
    });

    it("formats JMD", () => {
      expect(Money.of(150_000, "JMD").format()).toBe("J$ 150,000.00");
    });

    it("formats XCD", () => {
      expect(Money.of(2_700, "XCD").format()).toBe("EC$ 2,700.00");
    });

    it("toString returns formatted value", () => {
      expect(`${Money.of(100, "USD")}`).toBe("$ 100.00");
    });
  });

  describe("serialization", () => {
    it("serializes to JSON", () => {
      const m = Money.of(100_000, "GYD");
      const json = m.toJSON();
      expect(json).toEqual({ amount: 100_000, currency: "GYD" });
    });

    it("toCents returns integer", () => {
      const m = Money.of(100.50, "USD");
      expect(m.toCents()).toBe(10050);
    });
  });
});
