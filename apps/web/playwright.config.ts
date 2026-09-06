import { defineConfig, devices } from "@playwright/test";
import { ALICE_STORAGE_STATE_PATH, WEB_BASE_URL } from "./e2e/support/paths.js";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? WEB_BASE_URL;

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
      use: { ...devices["Desktop Chrome"], storageState: ALICE_STORAGE_STATE_PATH },
      dependencies: ["setup"],
    },
  ],
});
