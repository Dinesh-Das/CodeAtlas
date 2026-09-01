import { defineConfig } from "vitest/config";

const coverageRun = process.argv.includes("--coverage");

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // V8 instrumentation adds measurable overhead to the full-rebuild fixtures.
    testTimeout: coverageRun ? 40_000 : 20_000,
    hookTimeout: coverageRun ? 40_000 : 20_000,
    coverage: {
      reporter: ["text", "html"],
      thresholds: {
        statements: 84,
        branches: 71,
        functions: 84,
        lines: 86,
      },
    },
  },
});
