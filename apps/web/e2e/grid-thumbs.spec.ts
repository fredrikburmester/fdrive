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

  // The browser harness has no thumbnail-generating indexer; provide the
  // uploaded image as this tile's thumbnail while exercising its real UI request.
  await page.route("**/api/v1/thumb?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("path") === `${path}/${name}`) {
      await route.fulfill({ status: 200, contentType: "image/png", body: shareImageFixture() });
    } else await route.continue();
  });
  const thumbResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith("/thumb") && url.searchParams.get("path") === `${path}/${name}`;
  });

  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Grid" }).click();
  await expect(page.locator('[data-slot="file-grid"]')).toBeVisible();

  const tile = page.locator(`[data-path="${path}/${name}"]`);
  await expect(tile).toBeVisible();
  const img = tile.locator("img");
  await expect(img).toBeVisible();
  const response = await thumbResponse;
  expect(response.status()).toBe(200);
  await expect
    .poll(() => img.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
});
