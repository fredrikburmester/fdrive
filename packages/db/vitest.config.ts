import { definePackageConfig } from "@fdrive/config/vitest.preset";

export default definePackageConfig({
  test: {
    // Exercise this raw SQL repository on real PostgreSQL in both the coverage
    // and integration gates. Do not exclude the new persistence boundary.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "test/integration/!(desktop|desktop-effects|desktop-publish-lock|activity).test.ts",
    ],
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
