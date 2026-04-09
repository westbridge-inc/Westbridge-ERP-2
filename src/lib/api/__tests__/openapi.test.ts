/**
 * OpenAPI generator regression tests.
 *
 * Phase 1 of this file exists because the live spec endpoint was 500'ing
 * silently in production: the openapi.ts module forgot to call
 * extendZodWithOpenApi(z) before any registry.register() call, so every
 * Zod schema crashed at registration with "zodSchema.openapi is not a
 * function". The test below would have caught it the first time.
 *
 * If this file ever fails after a Zod or zod-to-openapi upgrade, the fix
 * is almost certainly to re-call extendZodWithOpenApi(z) at the top of
 * src/lib/api/openapi.ts.
 */

import { describe, it, expect } from "vitest";
import { generateOpenApiSpec } from "../openapi.js";

describe("openapi", () => {
  it("generates the spec without throwing", () => {
    expect(() => generateOpenApiSpec()).not.toThrow();
  });

  it("returns a valid OpenAPI 3.1 document with paths and components", () => {
    const spec = generateOpenApiSpec();
    expect(spec.openapi).toMatch(/^3\.1/);
    expect(spec.info?.title).toBeTruthy();
    expect(spec.info?.version).toBeTruthy();
    expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0);
    expect(spec.components?.schemas).toBeDefined();
  });

  it("includes the canonical auth + cortex paths the dashboard depends on", () => {
    const spec = generateOpenApiSpec();
    const paths = Object.keys(spec.paths ?? {});
    // We don't assert on the exact list (it grows over time) but a handful
    // of these MUST be present or the spec is missing whole subsystems.
    const expectedSubstrings = ["/api/auth/login", "/api/erp", "/api/csrf"];
    for (const sub of expectedSubstrings) {
      expect(paths.some((p) => p.includes(sub))).toBe(true);
    }
  });
});
