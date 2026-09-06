import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    coverage: {
      enabled: false,
    },
  },
});
