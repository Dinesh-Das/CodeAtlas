import { defineConfig } from "vitest/config";

const coverageRun = process.argv.includes("--coverage");

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Compiler-backed fixtures are CPU- and memory-heavy. A small worker cap prevents shared
    // Windows runners from starving several large TypeScript programs until they time out.
    maxWorkers: 2,
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
