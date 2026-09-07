import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Pinned explicitly (rather than left to Vitest's default) because this
// config is loaded two different ways that otherwise default `root`
// differently: directly via `vitest run --config tools/deploy/vitest.config.ts`
// (root defaults to the current working directory) and as one entry of the
// root `vitest.config.ts`'s `projects` array (root defaults to this file's
// own directory). A relative `include`/`coverage.include` glob that only
// works under one of those two would silently miss every test, or the
// project mode would instead pick up the whole monorepo, under the other.
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    root,
    include: ["**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["{deploy-keys,generate-env-example}.ts"],
      reporter: ["text"],
      thresholds: { lines: 99, functions: 100, branches: 95, statements: 99 },
    },
  },
});
