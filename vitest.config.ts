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
      thresholds: {
        // Current baseline — raise to 80/70/70/80 before GA release
        statements: 45,
        branches: 40,
        functions: 40,
        lines: 45,
      },
    },
  },
});
