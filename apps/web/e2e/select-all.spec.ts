import { expect, type Page, test } from "@playwright/test";
import { listing } from "./support/regions.js";
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

test("the header checkbox selects and deselects every row, and shows indeterminate for a partial selection", async ({
  page,
}) => {
  const sandbox = uniqueName("select-all");
  const folderA = uniqueName("a");
  const folderB = uniqueName("b");

  await page.goto("/files");
  await createFolder(page, sandbox);
  await listing(page).getByText(sandbox, { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}$`));

  // Creating a folder auto-selects it, so folderB starts out selected.
  await createFolder(page, folderA);
  await createFolder(page, folderB);
  await expect(listing(page).getByText(folderB, { exact: true })).toBeVisible();

  // The header checkbox is the first one in DOM order (the sticky header
  // row is rendered before any entry row), so this stays stable across its
  // "Select all"/"Deselect all" aria-label changes.
  const headerCheckbox = listing(page).locator('[data-slot="checkbox"]').first();

  await page.getByRole("button", { name: "Clear selection" }).click();
  await expect(headerCheckbox).toHaveAttribute("aria-checked", "false");

  // Selecting a single row leaves the header checkbox indeterminate.
  await listing(page).getByText(folderA, { exact: true }).click();
  await expect(headerCheckbox).toHaveAttribute("aria-checked", "mixed");

  // Clicking the header checkbox selects every row.
  await headerCheckbox.click();
  await expect(headerCheckbox).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await expect(listing(page).getByRole("checkbox", { checked: true })).toHaveCount(3);

  // Clicking it again clears the selection entirely.
  await headerCheckbox.click();
  await expect(headerCheckbox).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("2 selected", { exact: true })).toBeHidden();
  await expect(listing(page).getByRole("checkbox", { checked: true })).toHaveCount(0);

  // Clean up: select both folders and delete them, then the sandbox itself.
  await listing(page).getByText(folderA, { exact: true }).click();
  await page.keyboard.press(`${PRIMARY_MODIFIER}+a`);
  await listing(page).getByText(folderA, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirmDialog = page.getByRole("alertdialog");
  await confirmDialog.getByRole("button", { name: "Delete" }).click();
  await expect(confirmDialog).toBeHidden();

  await page.getByRole("link", { name: "Home" }).click();
  await listing(page).getByText(sandbox, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const sandboxConfirm = page.getByRole("alertdialog");
  await sandboxConfirm.getByRole("button", { name: "Delete" }).click();
  await expect(sandboxConfirm).toBeHidden();
});
