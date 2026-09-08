import { expect, test } from "@playwright/test";
import { shareImageFixture } from "./support/share-fixture.js";
import { uniqueName } from "./support/unique.js";
import { fileInputLocator } from "./support/upload.js";
import { createViewFolder } from "./support/view-folder.js";

test("an image file's grid tile shows a thumbnail that loads", async ({ page }) => {
  const path = await createViewFolder(page);

  const name = `${uniqueName("grid-thumb")}.png`;
  await fileInputLocator(page).setInputFiles({
    name,
    mimeType: "image/png",
    buffer: shareImageFixture(),
  });
  await expect(page.getByText(name, { exact: true })).toBeVisible();

  const thumbResponse = page.waitForResponse((response) => response.url().includes("/thumb"));

  await page.getByRole("button", { name: "View" }).click();
  await page.getByRole("menuitemradio", { name: "Grid" }).click();
  await expect(page.locator('[data-slot="file-grid"]')).toBeVisible();

  const tile = page.locator(`[data-path="${path}/${name}"]`);
  await expect(tile).toBeVisible();
  const img = tile.locator("img");
  await expect(img).toBeVisible();
  const response = await thumbResponse;
  expect(response.status()).toBe(200);
});
