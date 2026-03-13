import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.integration.test.ts"],
    testTimeout: 10_000,
    env: {
      NODE_ENV: "test",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: [
        "node_modules/",
        "dist/",
        "prisma/",
        "load-tests/",
        "**/*.config.*",
        "**/prisma/generated/**",
        "**/*.test.ts",
        "**/*.spec.ts",
        "**/types/**/*.d.ts",
        "src/__tests__/**",
      ],
      // Current baseline — enforced in CI. Raise incrementally as coverage improves.
      // Target: statements 80, branches 70, functions 75, lines 80.
      thresholds: {
        statements: 45,
        branches: 40,
        functions: 40,
        lines: 45,
      },
    },
  },
});
