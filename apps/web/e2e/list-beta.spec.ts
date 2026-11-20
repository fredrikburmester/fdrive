import { expect, type Page, test } from "@playwright/test";
import { listing } from "./support/regions.js";
import { removeSandbox } from "./support/sandbox.js";
import { createViewFolder as createFolder } from "./support/view-folder.js";

// Each test's folder sits at the shared root, whose rows other specs look for: remove it after.
let created: string | null = null;

async function createViewFolder(page: Page, seed: boolean): Promise<string> {
  created = await createFolder(page, seed);
  return created;
}

test.afterEach(async ({ page }) => {
  if (created !== null) await removeSandbox(page, created.slice(1));
  created = null;
});

/** Turns on the File list beta in this browser before any page loads. */
async function useBetaList(page: Page) {
  await page.addInitScript(() => localStorage.setItem("fdrive.list.design", '"beta"'));
}

test("the beta list opens a folder as a tree, where hovering a folder shows its chevron", async ({
  page,
}) => {
  await useBetaList(page);
  const path = await createViewFolder(page, true);
  await expect(listing(page).getByText("photo.jpg", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "View", exact: true }).click();
  await expect(page.getByRole("menuitemradio", { name: "Tree" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");

  const docsRow = listing(page).locator(`[data-path="${path}/docs"]`);
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

test("Back from a file opened in the tree returns to the tree, with the file selected", async ({
  page,
}) => {
  await useBetaList(page);
  const path = await createViewFolder(page, true);
  const docsRow = listing(page).locator(`[data-path="${path}/docs"]`);
  await docsRow.hover();
  await docsRow.getByRole("button", { name: "Expand docs" }).click();
  const readme = listing(page).locator(`[data-path="${path}/docs/readme.md"]`);
  await readme.dblclick();
  await expect(page).toHaveURL(/\/view\/.+\/docs\/readme\.md\?from=/);

  await page.keyboard.press("Escape");

  await expect(page).toHaveURL(new RegExp(`/files${path}$`));
  await expect(readme).toHaveAttribute("data-selected", "true");
  await expect(docsRow.getByRole("button", { name: "Collapse docs" })).toHaveCount(1);
});

test("a beta row's More button opens the same actions as a right-click", async ({ page }) => {
  await useBetaList(page);
  const path = await createViewFolder(page, true);
  const photoRow = listing(page).locator(`[data-path="${path}/photo.jpg"]`);
  await photoRow.hover();
  await photoRow.getByRole("button", { name: "More actions for photo.jpg" }).click();

  await expect(page.getByRole("menuitem", { name: "Move to Trash" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // Choosing from the menu neither selects nor opens the row.
  await expect(photoRow).toHaveAttribute("data-selected", "false");
  await expect(page).toHaveURL(new RegExp(`/files${path}$`));
});

test("Select shows the beta list's checkbox column, and rows click as usual", async ({ page }) => {
  await useBetaList(page);
  const path = await createViewFolder(page, true);
  const docsRow = listing(page).locator(`[data-path="${path}/docs"]`);
  const photoRow = listing(page).locator(`[data-path="${path}/photo.jpg"]`);
  await expect(photoRow).toBeVisible();
  await expect(listing(page).getByRole("checkbox")).toHaveCount(0);

  await listing(page).getByRole("button", { name: "Select", exact: true }).click();
  await expect(listing(page).getByRole("checkbox", { name: "Select all" })).toBeVisible();
  await listing(page).getByRole("checkbox", { name: "Select photo.jpg" }).check();
  await expect(photoRow).toHaveAttribute("data-selected", "true");

  // A plain click on a row still selects just that row.
  await docsRow.getByText("docs", { exact: true }).click();
  await expect(docsRow).toHaveAttribute("data-selected", "true");
  await expect(photoRow).toHaveAttribute("data-selected", "false");

  await listing(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(listing(page).getByRole("checkbox")).toHaveCount(0);
  await expect(docsRow).toHaveAttribute("data-selected", "true");
});

test("the View menu switches between the classic and the beta list, and it sticks", async ({
  page,
}) => {
  await createViewFolder(page, true);
  const selectAll = listing(page).getByRole("checkbox", { name: "Select all" });
  const selectToggle = listing(page).getByRole("button", { name: "Select", exact: true });
  await expect(selectAll).toBeVisible();
  await expect(selectToggle).toHaveCount(0);

  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: /New file list/ }).click();
  await page.keyboard.press("Escape");
  await expect(selectToggle).toBeVisible();
  await expect(selectAll).toHaveCount(0);

  await page.reload();
  await expect(selectToggle).toBeVisible();

  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: /New file list/ }).click();
  await page.keyboard.press("Escape");
  await expect(selectAll).toBeVisible();
});
