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
        // Server entry point (side effects, graceful shutdown) — tested via integration
        "src/server.ts",
        // OpenAPI spec registration (declarative, no logic) — validated by typecheck
        "src/lib/api/openapi.ts",
        // Worker entry point (BullMQ side effects) — tested via integration tests
        "src/workers/index.ts",
        // External payment gateway client — tested via E2E with sandbox
        "src/lib/data/powertranz.client.ts",
        // Type-only files
        "src/lib/feature-flags.types.ts",
        // Prisma client with soft-delete extensions — tested via integration tests
        "src/lib/data/prisma.ts",
      ],
      thresholds: {
        // Coverage target: 75%. New controllers and middleware tests brought this up from 55%.
        statements: 75,
        branches: 70,
        functions: 85,
        lines: 75,
      },
    },
  },
});
