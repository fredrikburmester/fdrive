import { definePackageConfig } from "@fdrive/config/vitest.preset";

export default definePackageConfig({
  test: {
    coverage: {
      include: ["src/**"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.config.*",
        "src/**/*.d.ts",
        "src/index.ts",
        "src/containers/**",
      ],
    },
  },
});
