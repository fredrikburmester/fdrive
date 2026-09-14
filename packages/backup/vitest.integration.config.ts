import { definePackageConfig } from "@fdrive/config/vitest.preset";
export default definePackageConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
