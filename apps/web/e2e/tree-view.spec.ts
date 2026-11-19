import { expect, test } from "@playwright/test";
import { listing } from "./support/regions.js";
import { createViewFolder } from "./support/view-folder.js";

test("a folder opens in tree view, where hovering a folder shows the chevron that expands it", async ({
  page,
}) => {
  const path = await createViewFolder(page, true);
  await expect(listing(page).getByText("photo.jpg", { exact: true })).toBeVisible();

  // Tree is the default: nothing to switch.
  await page.getByRole("button", { name: "View", exact: true }).click();
  await expect(page.getByRole("menuitemradio", { name: "Tree" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");

  const docsRow = listing(page).locator(`[data-path="${path}/docs"]`);
  await expect(docsRow).toBeVisible();
  await expect(listing(page).getByText("readme.md", { exact: true })).toBeHidden();

  // The chevron takes the folder icon's place only while the row is hovered.
  const chevron = docsRow.getByRole("button", { name: "Expand docs" });
  await expect(chevron).toHaveCSS("opacity", "0");
  await docsRow.hover();
  await expect(chevron).toHaveCSS("opacity", "1");
  await chevron.click();

  await expect(listing(page).getByText("readme.md", { exact: true })).toBeVisible();
  await expect(listing(page).getByText("report.pdf", { exact: true })).toBeVisible();
  await expect(docsRow).toHaveAttribute("data-selected", "false");
});

test("a row's More button opens the same actions as a right-click", async ({ page }) => {
  const path = await createViewFolder(page, true);
  const photoRow = listing(page).locator(`[data-path="${path}/photo.jpg"]`);
  await photoRow.hover();
  await photoRow.getByRole("button", { name: "More actions for photo.jpg" }).click();

  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Move to Trash" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // Choosing from the menu neither selects nor opens the row.
  await expect(page).toHaveURL(new RegExp(`/files${path}$`));
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
