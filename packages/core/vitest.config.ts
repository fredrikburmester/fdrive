import { definePackageConfig } from "@fdrive/config/vitest.preset";

export default definePackageConfig({
  test: {
    coverage: {
      thresholds: {
        functions: 100,
        lines: 100,
        branches: 98,
        statements: 100,
      },
    },
  },
});
