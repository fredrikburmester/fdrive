import { expect, type Page, test } from "@playwright/test";
import { listing, sidebar } from "./support/regions.js";
import { uniqueName } from "./support/unique.js";
import { uploadFiles } from "./support/upload.js";

async function createFolder(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Folder name").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
  const row = listing(page).getByText(name, { exact: true });
  await expect(row).toBeVisible({ timeout: 15_000 });
}

/** Uploads `name` and waits for the completion refresh to show its row. */
async function uploadTextFile(page: Page, name: string, contents: string): Promise<void> {
  await uploadFiles(page, [{ name, mimeType: "text/plain", contents }]);
  const row = listing(page).getByText(name, { exact: true });
  await expect(row).toBeVisible({ timeout: 15_000 });
}

/** Opens `name`'s row context menu, hovers the "Tags" submenu, clicks
 * "Edit tags", creates a brand new tag `tagName` inline, and closes the
 * dialog. Returns once the dialog is gone, with the tag now applied. */
async function tagFileWithNewTag(page: Page, name: string, tagName: string): Promise<void> {
  await listing(page).getByText(name, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Tags", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Edit tags" }).click();

  const dialog = page.getByRole("dialog").filter({ hasText: "Edit tags" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("Find or create a tag").fill(tagName);
  await dialog.getByRole("button", { name: `Create tag "${tagName}"` }).click();
  await dialog.getByLabel("Name").fill(tagName);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  await expect(dialog.getByText(tagName, { exact: true })).toBeVisible();
  const tag = dialog.getByRole("option", { name: tagName, exact: true });
  await expect(tag.getByRole("checkbox")).toBeChecked();
  await tag.click();
  await expect(tag.getByRole("checkbox")).not.toBeChecked();
  await tag.click();
  await expect(tag.getByRole("checkbox")).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

test("tagging a file from the context menu shows a dot, and the tag page lists it", async ({
  page,
}) => {
  const fileName = `${uniqueName("tag-me")}.txt`;
  const tagName = uniqueName("proj");
  await page.goto("/files");
  await uploadTextFile(page, fileName, "tag me please");

  await tagFileWithNewTag(page, fileName, tagName);

  const row = listing(page).locator(`[data-path="/${fileName}"]`);
  await expect(row.locator(`[aria-label*="${tagName}"]`)).toBeVisible();

  await sidebar(page).getByRole("link", { name: tagName }).click();
  await expect(page).toHaveURL(/\/tags\//);
  await expect(listing(page).getByText(fileName, { exact: true })).toBeVisible();

  // Cleanup: delete the file so later runs of this spec against the same
  // seeded root never see a duplicate.
  await page.goto("/files");
  await listing(page).getByText(fileName, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
});

test("favoriting a file from the context menu shows it in the sidebar, and removing it clears it", async ({
  page,
}) => {
  const fileName = `${uniqueName("fav-me")}.txt`;
  await page.goto("/files");
  await uploadTextFile(page, fileName, "favorite me please");

  await listing(page).getByText(fileName, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add to Favorites" }).click();

  await expect(sidebar(page).getByRole("link", { name: fileName })).toBeVisible();

  await sidebar(page).getByRole("link", { name: fileName }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove" }).click();
  await expect(sidebar(page).getByRole("link", { name: fileName })).toBeHidden();

  await listing(page).getByText(fileName, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
});

test("a tag survives renaming its enclosing folder", async ({ page }) => {
  const folderName = uniqueName("tag-folder");
  const fileName = "inside.txt";
  const renamedFolder = uniqueName("renamed-folder");
  const tagName = uniqueName("survives");

  await page.goto("/files");
  await createFolder(page, folderName);
  await listing(page).getByText(folderName, { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${folderName}$`));
  await uploadTextFile(page, fileName, "rename tracking test");

  await tagFileWithNewTag(page, fileName, tagName);

  await page.goto("/files");
  await listing(page).getByText(folderName, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const renameDialog = page.getByRole("dialog");
  await renameDialog.getByLabel("New name").fill(renamedFolder);
  await renameDialog.getByRole("button", { name: "Rename" }).click();
  await expect(renameDialog).toBeHidden();

  await sidebar(page).getByRole("link", { name: tagName }).click();
  await expect(page).toHaveURL(/\/tags\//);
  // A fresh navigation forces a refetch of this tag's file list, so it
  // reflects the renamed folder's new path rather than a stale cached one.
  await page.reload();
  await expect(listing(page).getByText(fileName, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(listing(page).getByText("no longer exists")).toHaveCount(0);
});

test("opening a preview adds the file to Recents", async ({ page }) => {
  const fileName = `${uniqueName("recent-me")}.txt`;
  await page.goto("/files");
  await uploadTextFile(page, fileName, "open me for recents");

  await listing(page).getByText(fileName, { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/view/${fileName}$`));

  await expect(sidebar(page).getByRole("link", { name: fileName })).toBeVisible();

  await page.goto("/files");
  await listing(page).getByText(fileName, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
});
