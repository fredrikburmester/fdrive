import { expect, test } from "@playwright/test";

test("a signed-out visitor is redirected from / to /login", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/login$/);
  await expect(page).toHaveTitle("fdrive");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
