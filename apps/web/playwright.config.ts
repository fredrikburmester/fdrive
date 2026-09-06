import { defineConfig, devices } from "@playwright/test";
import { getAliceStorageStatePath, getWebBaseUrl } from "./e2e/support/paths.js";

// Read lazily (as functions, not the frozen constants also exported by
// `support/paths.ts`) so this resolves correctly however this config module
// ends up getting (re-)evaluated: Playwright loads it once, in its main
// process, before `globalSetup` has resolved this run's actual port and
// state directory (see `global-setup.ts`), and then again, fresh, in every
// worker process it forks afterwards (workers inherit that same process's
// `process.env`, already updated by `globalSetup` by the time they start).
// A plain constant computed at the first, "too early" evaluation would be
// safe in the worker case (a fresh process re-evaluates the whole module
// graph) but calling the getters directly makes that not matter either way.
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? getWebBaseUrl();

// `globalSetup` owns the whole stack's lifecycle (Postgres, SFTPGo, the API,
// and the web app), since it has several independently-started parts;
// Playwright's built-in `webServer` option only manages one process.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: [["html", { open: "never" }]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 30_000,
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      testMatch: /.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], storageState: getAliceStorageStatePath() },
      dependencies: ["setup"],
    },
  ],
});
