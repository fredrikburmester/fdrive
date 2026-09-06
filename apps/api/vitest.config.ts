import { definePackageConfig } from "@fdrive/config/vitest.preset";

export default definePackageConfig({
  test: {
    coverage: {
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.config.*",
        "src/**/*.d.ts",
        "src/**/index.ts",
        "src/main.ts",
        // Only exercised by test/integration/composition.test.ts (a real
        // Postgres testcontainer plus a fake SFTPGo server), which is not
        // part of the unit coverage gate; see the api's test:integration
        // script and vitest.integration.config.ts.
        "src/composition.ts",
      ],
    },
  },
});
