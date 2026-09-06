import { test as setup } from "@playwright/test";
import { loginAs } from "./support/login.js";
import { ALICE_STORAGE_STATE_PATH } from "./support/paths.js";

/**
 * The "setup" project's one test: logs in as alice through the real UI once
 * and saves the resulting storage state, which every "chromium" project
 * test then reuses via `use.storageState` so they start already
 * authenticated. Signed-out flows (auth.spec.ts, permissions.spec.ts,
 * smoke.spec.ts) opt back out with their own `test.use({ storageState })`.
 */
setup("authenticate as alice", async ({ page }) => {
  await loginAs(page, "alice", "alice-password");
  await page.context().storageState({ path: ALICE_STORAGE_STATE_PATH });
});
