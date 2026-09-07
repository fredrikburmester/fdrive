import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "apps/*/vitest.config.ts",
      "packages/*/vitest.config.ts",
      "tools/deploy/vitest.config.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      include: ["**/src/**"],
      exclude: [
        "**/src/**/*.test.ts",
        "**/src/**/*.config.*",
        "**/src/**/*.d.ts",
        "**/src/**/index.ts",
        "**/node_modules/**",
        "**/dist/**",
      ],
    },
  },
});
