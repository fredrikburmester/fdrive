import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Pure gates and bounded stream helpers have blocking coverage. Docker/Next/browser
 * orchestration is exercised by the complete diagnostic and strict fixture runs. */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL("../../", import.meta.url)),
    include: ["tools/perf/**/*.test.ts", "apps/web/perf/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      include: [
        "tools/perf/{args,budgets,results,format,byte-generator,concurrency,cookie,seed-plan,stack-env,lifecycle,measure,search-fixture,browser-output,tei-runtime}.ts",
      ],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 99, functions: 100, branches: 95, statements: 99 },
    },
  },
});
