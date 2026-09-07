import { definePackageConfig } from "@fdrive/config/vitest.preset";

export default definePackageConfig({
  test: {
    coverage: {
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.config.*",
        "src/**/*.d.ts",
        "src/**/index.ts",
        "src/schema/**",
        "src/bin/**",
        "src/repos/drizzle.ts",
        "src/repos/index-queries.ts",
        "src/repos/wopi-locks.ts",
        "src/repos/office-files.ts",
        "src/repos/office-write-scope.ts",
        "src/repos/identity-links.ts",
        "src/repos/shares.ts",
      ],
    },
  },
});
