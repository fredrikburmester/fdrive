import { expect, test } from "@playwright/test";

test("home page has the fdrive title and heading", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("fdrive");
  await expect(page.getByRole("heading", { name: "fdrive" })).toBeVisible();
});
