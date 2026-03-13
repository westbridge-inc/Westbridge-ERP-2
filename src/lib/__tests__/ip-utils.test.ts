/**
 * IP utility tests — CIDR matching, IPv4 validation, edge cases.
 */
import { describe, it, expect } from "vitest";
import { ipToInt, isInCidr, matchesCidr, type CidrRange } from "../ip-utils.js";

describe("ipToInt", () => {
  it("converts 0.0.0.0 to 0", () => {
    expect(ipToInt("0.0.0.0")).toBe(0);
  });

  it("converts 255.255.255.255 to 4294967295", () => {
    expect(ipToInt("255.255.255.255")).toBe(4294967295);
  });

  it("converts 192.168.1.1 correctly", () => {
    expect(ipToInt("192.168.1.1")).toBe((192 << 24 | 168 << 16 | 1 << 8 | 1) >>> 0);
  });

  it("converts 10.0.0.1 correctly", () => {
    expect(ipToInt("10.0.0.1")).toBe((10 << 24 | 1) >>> 0);
  });
});

describe("isInCidr", () => {
  it("matches IP within /24 range", () => {
    expect(isInCidr("86.105.46.100", "86.105.46.0", 24)).toBe(true);
    expect(isInCidr("86.105.46.0", "86.105.46.0", 24)).toBe(true);
    expect(isInCidr("86.105.46.255", "86.105.46.0", 24)).toBe(true);
  });

  it("rejects IP outside /24 range", () => {
    expect(isInCidr("86.105.47.1", "86.105.46.0", 24)).toBe(false);
    expect(isInCidr("86.105.45.255", "86.105.46.0", 24)).toBe(false);
  });

  it("matches IP within /16 range", () => {
    expect(isInCidr("195.242.0.1", "195.242.0.0", 16)).toBe(true);
    expect(isInCidr("195.242.255.255", "195.242.0.0", 16)).toBe(true);
    expect(isInCidr("195.242.128.50", "195.242.0.0", 16)).toBe(true);
  });

  it("rejects IP outside /16 range", () => {
    expect(isInCidr("195.243.0.1", "195.242.0.0", 16)).toBe(false);
    expect(isInCidr("195.241.255.255", "195.242.0.0", 16)).toBe(false);
  });

  it("matches /32 (exact IP)", () => {
    expect(isInCidr("10.0.0.1", "10.0.0.1", 32)).toBe(true);
    expect(isInCidr("10.0.0.2", "10.0.0.1", 32)).toBe(false);
  });

  it("matches /8 (class A)", () => {
    expect(isInCidr("10.0.0.1", "10.0.0.0", 8)).toBe(true);
    expect(isInCidr("10.255.255.255", "10.0.0.0", 8)).toBe(true);
    expect(isInCidr("11.0.0.1", "10.0.0.0", 8)).toBe(false);
  });
});

describe("matchesCidr", () => {
  const ranges: CidrRange[] = [
    { network: "86.105.46.0", prefix: 24 },
    { network: "195.65.26.0", prefix: 24 },
    { network: "195.242.0.0", prefix: 16 },
  ];

  it("matches IPs in any of the ranges", () => {
    expect(matchesCidr("86.105.46.42", ranges)).toBe(true);
    expect(matchesCidr("195.65.26.1", ranges)).toBe(true);
    expect(matchesCidr("195.242.100.200", ranges)).toBe(true);
  });

  it("rejects IPs not in any range", () => {
    expect(matchesCidr("8.8.8.8", ranges)).toBe(false);
    expect(matchesCidr("86.105.47.1", ranges)).toBe(false);
    expect(matchesCidr("195.243.0.1", ranges)).toBe(false);
  });

  it("rejects non-IPv4 addresses", () => {
    expect(matchesCidr("::1", ranges)).toBe(false);
    expect(matchesCidr("not-an-ip", ranges)).toBe(false);
    expect(matchesCidr("", ranges)).toBe(false);
  });

  it("trims whitespace from IP", () => {
    expect(matchesCidr("  86.105.46.1  ", ranges)).toBe(true);
  });

  // Regression: the old startsWith approach would match "86.105.461.x"
  // because "86.105.46." is a prefix of "86.105.461."
  it("does NOT match IPs that share a prefix but are outside the CIDR", () => {
    // 86.105.461 is not valid IPv4, but this tests the parsing robustness
    expect(matchesCidr("86.105.461.1", ranges)).toBe(false);
  });
});
