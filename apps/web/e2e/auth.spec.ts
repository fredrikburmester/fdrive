import { expect, test } from "@playwright/test";
import { fillLoginForm, loginAs } from "./support/login.js";

// The "chromium" project defaults to an authenticated storage state (see
// playwright.config.ts); every test here needs a genuinely signed-out
// browser to exercise the login flow itself.
test.use({ storageState: { cookies: [], origins: [] } });

test("wrong password shows the error line", async ({ page }) => {
  await fillLoginForm(page, "alice", "not-the-right-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  // Not `getByRole("alert")`: Next's route announcer
  // (`#__next-route-announcer__`) is also `role="alert"`, so that query
  // matches two elements. `field-error`'s own `data-slot` is unambiguous.
  const errorLine = page.locator('[data-slot="field-error"]');
  await expect(errorLine).toBeVisible();
  await expect(errorLine).toHaveText("You're signed out. Sign in to continue.");
  // The failed attempt must not have navigated away from /login.
  await expect(page).toHaveURL(/\/login$/);
});

test("correct login lands on /files with the sidebar showing alice", async ({ page }) => {
  await loginAs(page, "alice", "alice-password");

  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByText("alice", { exact: true })).toBeVisible();
});

test("Enter in the password field submits the form", async ({ page }) => {
  await fillLoginForm(page, "alice", "alice-password");
  await page.getByLabel("Password").press("Enter");

  await expect(page).toHaveURL(/\/files$/);
});

test("sign out from the account menu returns to /login", async ({ page }) => {
  await loginAs(page, "alice", "alice-password");

  // Attached before the click, not after: a crash in the account menu would
  // happen synchronously within the click's own event handling, so waiting
  // for the event only after clicking could miss it.
  const pageErrorPromise = page.waitForEvent("pageerror", { timeout: 2_000 }).catch(() => null);

  // The account menu trigger is the sidebar footer button showing the
  // signed-in username.
  await page.getByRole("button", { name: "alice" }).click();

  const error = await pageErrorPromise;
  expect(error).toBeNull();

  await page.getByRole("menuitem", { name: "Sign out" }).click();

  await expect(page).toHaveURL(/\/login$/);
});

test("/files redirects to /login once signed out", async ({ page }) => {
  await loginAs(page, "alice", "alice-password");

  // Drives the "signed out" state directly (clearing the session cookie)
  // rather than through the account menu's Sign out item, since opening
  // that menu currently crashes the app (see the previous test).
  await page.context().clearCookies();

  await page.goto("/files");
  await expect(page).toHaveURL(/\/login$/);
});
