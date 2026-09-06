import { defineConfig } from "vitest/config";

/**
 * Standalone Vitest config for `tools/perf`'s unit tests (the pure
 * functions the harness is built from). Not part of the root config's
 * `apps/*`/`packages/*` project globs, so it is run separately via
 * `pnpm test:tools`. No coverage gate: `tools/**` is a script, not a
 * package with an enforced threshold, but every pure function still gets a
 * test.
 */
export default defineConfig({
  test: {
    include: ["tools/perf/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
