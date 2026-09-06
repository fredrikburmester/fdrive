import { expect, test } from "@playwright/test";

// The "chromium" project defaults to an authenticated storage state (see
// playwright.config.ts); this test needs a genuinely signed-out browser.
test.use({ storageState: { cookies: [], origins: [] } });

test("a signed-out visitor is redirected from / to /login", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/login$/);
  await expect(page).toHaveTitle("fdrive");
  // Not `getByRole("heading", ...)`: `CardTitle` (src/components/ui/card.tsx)
  // renders a plain `<div>`, not a heading element, so "Sign in" has no
  // heading role for assistive technology to pick up. Scoped to the card
  // title specifically since the submit button is also labelled "Sign in".
  await expect(page.locator('[data-slot="card-title"]', { hasText: "Sign in" })).toBeVisible();
});
