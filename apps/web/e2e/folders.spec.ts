import { expect, type Page, test } from "@playwright/test";
import { listing } from "./support/regions.js";
import { openSandbox, removeSandbox } from "./support/sandbox.js";
import { uniqueName } from "./support/unique.js";

const PRIMARY_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

async function createFolder(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Folder name").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
}

async function deleteEntry(page: Page, name: string): Promise<void> {
  await listing(page).getByText(name, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  const confirmDialog = page.getByRole("alertdialog");
  await confirmDialog.getByRole("button", { name: "Move to Trash" }).click();
  await expect(confirmDialog).toBeHidden();
}

test("the New folder dialog creates a folder that appears in the list", async ({ page }) => {
  const name = uniqueName("new-folder");
  const sandbox = await openSandbox(page, "folders");

  await createFolder(page, name);

  await expect(listing(page).getByText(name, { exact: true })).toBeVisible();

  await deleteEntry(page, name);
  await removeSandbox(page, sandbox);
});

test("renaming a folder via the context menu updates its name in the list", async ({ page }) => {
  const originalName = uniqueName("rename-me");
  const newName = uniqueName("renamed");
  const sandbox = await openSandbox(page, "folders");
  await createFolder(page, originalName);

  await listing(page).getByText(originalName, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("New name").fill(newName);
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(dialog).toBeHidden();

  await expect(listing(page).getByText(newName, { exact: true })).toBeVisible();
  await expect(listing(page).getByText(originalName, { exact: true })).toBeHidden();

  await deleteEntry(page, newName);
  await removeSandbox(page, sandbox);
});

test("deleting a folder via the context menu asks for confirmation, then removes it", async ({
  page,
}) => {
  const name = uniqueName("delete-me");
  const sandbox = await openSandbox(page, "folders");
  await createFolder(page, name);
  await expect(listing(page).getByText(name, { exact: true })).toBeVisible();

  await listing(page).getByText(name, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();

  const confirmDialog = page.getByRole("alertdialog");
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText(name);

  await confirmDialog.getByRole("button", { name: "Move to Trash" }).click();

  await expect(listing(page).getByText(name, { exact: true })).toBeHidden();
  await removeSandbox(page, sandbox);
});

test("keyboard navigation: arrow down moves focus, Enter opens a folder, and select-all checks every row", async ({
  page,
}) => {
  const folderA = uniqueName("folder-a");
  const folderB = uniqueName("folder-b");

  const sandbox = await openSandbox(page, "keyboard-sandbox");

  await createFolder(page, folderA);
  await createFolder(page, folderB);
  await expect(listing(page).getByText(folderB, { exact: true })).toBeVisible();

  // Click folder A: selects and focuses it, and gives the listing container
  // keyboard focus (clicking a non-focusable row delegates focus to its
  // nearest focusable ancestor, the listing container).
  await listing(page).getByText(folderA, { exact: true }).click();

  await page.keyboard.press("ArrowDown");
  await expect(page.locator(`[data-path$="/${folderB}"][data-focused="true"]`)).toHaveCount(1);

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}/${folderB}$`));

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}$`));

  await listing(page).getByText(folderA, { exact: true }).click();
  await page.keyboard.press(`${PRIMARY_MODIFIER}+a`);

  await expect(listing(page).locator('[data-selected="true"]')).toHaveCount(2);

  // Both folders are still multi-selected here, so a single Delete (right-
  // clicking either row acts on the whole selection, not just that row)
  // removes them both; calling `deleteEntry` per-name again would target
  // the same now-multi-selected pair a second time and hang waiting for a
  // row that is already gone.
  await deleteEntry(page, folderA);
  await removeSandbox(page, sandbox);
});

test("select-all checkbox keeps its native Space key behavior", async ({ page }) => {
  await page.goto("/files/docs");
  await listing(page).getByRole("button", { name: "Select", exact: true }).click();
  const checkbox = listing(page).getByRole("checkbox", { name: "Select all", exact: true });
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(
    listing(page).getByRole("checkbox", { name: "Deselect all", exact: true }),
  ).toBeChecked();
  await expect(page).toHaveURL(/\/files\/docs$/);
  await expect(page.getByRole("dialog")).toBeHidden();
});
