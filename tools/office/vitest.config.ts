import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tools/office/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["tools/office/keys.ts", "tools/office/dev-env.ts"],
      reporter: ["text"],
      thresholds: { lines: 99, functions: 100, branches: 95, statements: 99 },
    },
  },
});
