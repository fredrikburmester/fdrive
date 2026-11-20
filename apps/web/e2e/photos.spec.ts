import { expect, test } from "@playwright/test";

// Alice's seeded photo.jpg is indexed with the EXIF details `global-setup.ts` gives it.

test("Photos shows a photo under the month it was taken and opens it in the viewer", async ({
  page,
}) => {
  await page.goto("/files");
  await page.getByRole("link", { name: "Photos", exact: true }).click();
  await expect(page).toHaveURL(/\/photos$/);
  // The bar under the header counts what the grid holds; a month's strip titles its photos.
  await expect(page.getByText(/^\d+\+? photos?$/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "May 2024", exact: true })).toBeVisible();

  await page
    .getByRole("region", { name: "May 2024" })
    .getByRole("link", { name: "photo.jpg" })
    .click();

  await expect(page).toHaveURL(/\/view\/photo\.jpg$/);
});

test("the Info panel shows a photo's details", async ({ page }) => {
  await page.goto("/view/photo.jpg");
  await page.getByRole("button", { name: "Info" }).click();

  await expect(page.getByText("Taken", { exact: true })).toBeVisible();
  await expect(page.getByText("Apple iPhone 15 Pro", { exact: true })).toBeVisible();
  await expect(page.getByText("4032 × 3024", { exact: true })).toBeVisible();
  await expect(page.getByText("59.32930, 18.06860", { exact: true })).toBeVisible();
});
