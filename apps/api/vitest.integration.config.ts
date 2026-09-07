import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Each file starts its own Postgres and SFTPGo containers; running them in parallel
    // under Docker Desktop load produced rotating "container stopped" failures.
    fileParallelism: false,
  },
});
