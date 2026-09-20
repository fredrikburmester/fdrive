import { definePackageConfig } from "@fdrive/config/vitest.preset";

export default definePackageConfig({
  test: {
    // Explicit allow-list: the default coverage gate runs exactly these five
    // raw-SQL persistence boundaries against real PostgreSQL. `activity-scale`
    // is the deliberate million-event regression from
    // docs/plans/RECENT-ACTIVITY-COVERAGE.md:95; it costs about three minutes,
    // so treat it as an intentional part of the gate, not an accident. A new
    // integration file joins the gate only by being listed here (or via
    // vitest.integration.config.ts, which runs all of them).
    include: [
      "src/**/*.test.ts",
      "test/*.test.ts",
      "test/integration/{activity,activity-scale,desktop,desktop-effects,desktop-publish-lock}.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.config.*",
        "src/**/*.d.ts",
        "src/**/index.ts",
        "src/schema/**",
        "src/bin/**",
        "src/repos/ai-chats.ts",
        "src/repos/drizzle.ts",
        "src/repos/index-queries.ts",
        "src/repos/wopi-locks.ts",
        "src/repos/office-files.ts",
        "src/repos/office-write-scope.ts",
        "src/repos/identity-links.ts",
        "src/repos/shares.ts",
        "src/repos/system-events.ts",
      ],
    },
  },
});
