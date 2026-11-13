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
        // Only exercised by the integration suites (a real Postgres
        // testcontainer and a local files folder), which are not part of
        // the unit coverage gate; see the api's test:integration script and
        // vitest.integration.config.ts.
        "src/composition.ts",
      ],
    },
  },
});
