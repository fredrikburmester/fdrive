import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["office-e2e/**/*.test.ts"],
    environment: "node",
    coverage: {
      include: [
        "office-e2e/fixture-config.ts",
        "office-e2e/process.ts",
        "office-e2e/archive.ts",
        "office-e2e/storage.ts",
        "office-e2e/state.ts",
        "office-e2e/diagnostics.ts",
      ],
      thresholds: { lines: 99, functions: 99, branches: 95 },
    },
  },
});
