import { describe, it, expect } from "vitest";
import { validateErpFilters } from "../validation/erp-filters.js";

describe("validateErpFilters", () => {
  it("returns ok with empty filters when input is undefined", () => {
    const result = validateErpFilters(undefined);
    expect(result.ok).toBe(true);
    expect(result.filters).toEqual([]);
  });

  it("returns ok with empty filters when input is empty string", () => {
    const result = validateErpFilters("");
    expect(result.ok).toBe(true);
    expect(result.filters).toEqual([]);
  });

  it("parses a valid 3-element filter", () => {
    const result = validateErpFilters('[["status","=","Paid"]]');
    expect(result.ok).toBe(true);
    expect(result.filters).toEqual([["status", "=", "Paid"]]);
  });

  it("parses a valid 4-element filter with doctype", () => {
    const result = validateErpFilters('[["Sales Invoice","status","=","Paid"]]');
    expect(result.ok).toBe(true);
    expect(result.filters).toEqual([["Sales Invoice", "status", "=", "Paid"]]);
  });

  it("rejects non-array JSON", () => {
    const result = validateErpFilters('{"key":"value"}');
    expect(result.ok).toBe(false);
    expect(result.error).toContain("must be an array");
  });

  it("rejects invalid JSON", () => {
    const result = validateErpFilters("not json");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid JSON");
  });

  it("accepts an empty array", () => {
    const result = validateErpFilters("[]");
    expect(result.ok).toBe(true);
    expect(result.filters).toEqual([]);
  });

  it("accepts multiple valid filters", () => {
    const result = validateErpFilters('[["status","=","Paid"],["amount",">",100]]');
    expect(result.ok).toBe(true);
    expect(result.filters).toHaveLength(2);
  });

  it("rejects too many filters", () => {
    const filters = Array.from({ length: 25 }, (_, i) => [`field_${i}`, "=", "val"]);
    const result = validateErpFilters(JSON.stringify(filters));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Too many filters");
  });

  it("rejects invalid operator", () => {
    const result = validateErpFilters('[["status","DROP TABLE","x"]]');
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid operator");
  });

  it("accepts all valid operators", () => {
    const operators = ["=", "!=", "<", ">", "<=", ">=", "like", "not like", "in", "not in", "is", "is not", "between"];
    for (const op of operators) {
      const result = validateErpFilters(JSON.stringify([["field", op, "val"]]));
      expect(result.ok).toBe(true);
    }
  });

  it("rejects invalid field names", () => {
    const result = validateErpFilters('[["1badfield","=","x"]]');
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid field name");
  });

  it("rejects non-array filter elements", () => {
    const result = validateErpFilters('["not_an_array"]');
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Each filter must be an array");
  });

  it("rejects filter with wrong element count", () => {
    const result = validateErpFilters('[["only_two","="]]');
    expect(result.ok).toBe(false);
    expect(result.error).toContain("3 or 4 elements");
  });

  it("rejects overly long string values", () => {
    const longVal = "x".repeat(501);
    const result = validateErpFilters(JSON.stringify([["field", "=", longVal]]));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid filter value");
  });

  it("accepts numeric and null values", () => {
    const result = validateErpFilters('[["amount",">",100],["deleted","is",null]]');
    expect(result.ok).toBe(true);
  });

  it("accepts array values for 'in' operator", () => {
    const result = validateErpFilters('[["status","in",["Paid","Unpaid"]]]');
    expect(result.ok).toBe(true);
  });
});
