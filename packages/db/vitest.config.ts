import { definePackageConfig } from "@fdrive/config/vitest.preset";

export default definePackageConfig({
  test: {
    // Exercise this raw SQL repository on real PostgreSQL in both the coverage
    // and integration gates. Do not exclude the new persistence boundary.
    // Those suites outlast Vitest's 5 s default on a loaded four-core CI runner.
    // Named exactly: a !(...) exclude also let in every file whose name starts
    // with a listed one, such as the million-event activity-scale benchmark,
    // which runs in the integration gate only.
    testTimeout: 30_000,
    include: [
      "src/**/*.test.ts",
      "test/*.test.ts",
      "test/integration/{desktop,desktop-effects,desktop-publish-lock,activity}.test.ts",
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
