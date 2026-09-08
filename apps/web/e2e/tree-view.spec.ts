import { expect, test } from "@playwright/test";
import { listing } from "./support/regions.js";
import { createViewFolder } from "./support/view-folder.js";

test("switching to tree view and expanding a folder row shows its children inline", async ({
  page,
}) => {
  const path = await createViewFolder(page, true);
  await expect(listing(page).getByText("photo.jpg", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Tree" }).click();

  const docsRow = listing(page).locator(`[data-path="${path}/docs"]`);
  await expect(docsRow).toBeVisible();
  await expect(listing(page).getByText("readme.md", { exact: true })).toBeHidden();

  await docsRow.getByRole("button", { name: "Expand docs" }).click();

  await expect(listing(page).getByText("readme.md", { exact: true })).toBeVisible();
  await expect(listing(page).getByText("report.pdf", { exact: true })).toBeVisible();
});

test("tree view expansion persists across reload", async ({ page }) => {
  const path = await createViewFolder(page, true);

  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Tree" }).click();
  const docsRow = listing(page).locator(`[data-path="${path}/docs"]`);
  await expect(docsRow).toBeVisible();
  await docsRow.getByRole("button", { name: "Expand docs" }).click();
  await expect(listing(page).getByText("readme.md", { exact: true })).toBeVisible();

  await page.reload();

  // Still in tree view with docs expanded: its children are visible inline,
  // at the top level, without navigating into the folder.
  await expect(listing(page).getByText("readme.md", { exact: true })).toBeVisible();
  await expect(listing(page).getByText("report.pdf", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/files${path}$`));
});

test("double-clicking the disclosure chevron toggles the row without navigating into it", async ({
  page,
}) => {
  const path = await createViewFolder(page, true);
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Tree" }).click();

  const docsRow = listing(page).locator(`[data-path="${path}/docs"]`);
  await expect(docsRow).toBeVisible();
  const chevron = docsRow.getByRole("button", { name: "Expand docs" });

  await chevron.dblclick();

  // A double-click toggles twice (expand, then collapse), ending up
  // collapsed again, and never navigates into the folder: docs' own
  // children never appear, and the URL stays put.
  await expect(listing(page).getByText("readme.md", { exact: true })).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/files${path}$`));
});
