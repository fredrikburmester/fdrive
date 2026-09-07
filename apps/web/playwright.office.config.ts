import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./office-e2e",
  testMatch:
    process.env.OFFICE_E2E_PRODUCT === "collabora"
      ? /collabora\.spec\.ts/
      : /(?:editor|readonly|operations|external)\.spec\.ts/,
  globalSetup: "./office-e2e/setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 600_000,
  expect: { timeout: 30_000 },
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? 39422}`,
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
