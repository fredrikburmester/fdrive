import { definePackageConfig } from "@fdrive/config/vitest.preset";

export default definePackageConfig({
  test: {
    // Import-heavy files can exceed the 5 s default when the host is loaded by
    // parallel workers. The extra headroom only covers startup, not logic.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        // Only fixture barrels are excluded; auth/index.ts wiring is measured
        // (routes.test.ts and isolation-regressions.test.ts exercise it).
        "src/**/test-fixtures/index.ts",
        "src/main.ts",
        // Only exercised by test/integration/composition.test.ts (a real
        // Postgres testcontainer plus a fake SFTPGo server), which is not
        // part of the unit coverage gate; see the api's test:integration
        // script and vitest.integration.config.ts.
        "src/composition.ts",
        // The backup recovery boundary is container-only too:
        // test/integration/recovery.test.ts (Postgres testcontainer) drives
        // command.ts, module.ts and recovery.ts. They moved out of the unit
        // gate so a testcontainer suite with 5 s defaults cannot flake it;
        // run `pnpm --filter @fdrive/api test:integration` to exercise them.
        "src/backups/command.ts",
        "src/backups/module.ts",
        "src/backups/recovery.ts",
      ],
    },
  },
});
