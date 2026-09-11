import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    // The real-server suite lands with the testkit's WebDAV binding; until
    // then an empty run must not fail the workspace-wide integration gate.
    passWithNoTests: true,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
