import { expect, type Page, test } from "@playwright/test";
import { listing } from "./support/regions.js";
import { uniqueName } from "./support/unique.js";
import { uploadFiles } from "./support/upload.js";

const PRIMARY_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

/**
 * The listing row for `name`, scoped to the file listing rather than a bare
 * `getByText`. This avoids two different sources of false positives: the
 * upload panel shows the same filename as its own row while an upload is in
 * flight (an unscoped query could resolve to that transient element instead
 * of the actual listing row, making a wait "succeed" before the listing has
 * actually updated), and the sidebar's folder tree can show the same name
 * as a link once it auto-expands to the current folder.
 */
function fileListRow(page: Page, name: string) {
  return listing(page).getByText(name, { exact: true });
}

/**
 * Matches the upload panel in any of its states: the expanded card while
 * uploading ("Uploading N items"), the expanded card once finished
 * ("Uploaded N"), or the collapsed pill it becomes almost immediately after
 * finishing for tiny local files ("N uploaded"). Kept loose on purpose: the
 * exact wording/phase visible at assertion time is inherently racy for
 * uploads this small, so this only confirms the panel showed up at all. The
 * file's own row appearing in the listing is the reliable completion
 * signal used everywhere else in this file.
 */
const UPLOAD_PANEL_TEXT = /uploading \d+ item|uploaded/i;

test.describe("uploads and downloads", () => {
  test.beforeEach(async ({ page }) => {
    // Every test in this file gets its own sandbox folder so parallel
    // workers uploading/downloading at the same time never collide.
    const sandbox = uniqueName("transfer");
    await page.goto("/files");
    await page.getByRole("button", { name: "New" }).click();
    await page.getByRole("menuitem", { name: "New folder" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Folder name").fill(sandbox);
    await dialog.getByRole("button", { name: "Create" }).click();
    await expect(dialog).toBeHidden();
    await listing(page).getByText(sandbox, { exact: true }).dblclick();
    await expect(page).toHaveURL(new RegExp(`/files/${sandbox}$`));
  });

  test("uploading files shows progress and completion, and they appear in the listing", async ({
    page,
  }) => {
    await uploadFiles(page, [
      { name: "a.txt", mimeType: "text/plain", contents: "first uploaded file" },
      { name: "b.txt", mimeType: "text/plain", contents: "second uploaded file" },
    ]);

    await expect(page.getByText(UPLOAD_PANEL_TEXT).first()).toBeVisible();
    await expect(fileListRow(page, "a.txt")).toBeVisible({ timeout: 15_000 });
    await expect(fileListRow(page, "b.txt")).toBeVisible({ timeout: 15_000 });
  });

  test("uploading a file that already exists offers Replace or Skip", async ({ page }) => {
    await uploadFiles(page, [
      { name: "dup.txt", mimeType: "text/plain", contents: "original content" },
    ]);
    await expect(fileListRow(page, "dup.txt")).toBeVisible({ timeout: 15_000 });

    await uploadFiles(page, [
      { name: "dup.txt", mimeType: "text/plain", contents: "replacement content" },
    ]);

    const conflictDialog = page.getByRole("dialog").filter({ hasText: "already exist" });
    await expect(conflictDialog).toBeVisible();
    await expect(conflictDialog.getByRole("button", { name: "Replace" })).toBeVisible();
    await expect(conflictDialog.getByRole("button", { name: "Skip" })).toBeVisible();

    await conflictDialog.getByRole("button", { name: "Skip" }).click();
    await expect(conflictDialog).toBeHidden();
  });

  test("dropping an external file uploads it", async ({ page }) => {
    // Seed one file first so `[data-slot="file-list"]` exists to dispatch
    // the drop onto (an empty folder renders `EmptyState` instead).
    await uploadFiles(page, [{ name: "seed.txt", mimeType: "text/plain", contents: "seed" }]);
    await expect(fileListRow(page, "seed.txt")).toBeVisible({ timeout: 15_000 });

    const dataTransfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["dropped file contents"], "dropped.txt", { type: "text/plain" }));
      return dt;
    });

    await page.dispatchEvent('[data-slot="file-list"]', "drop", { dataTransfer });

    const droppedRow = fileListRow(page, "dropped.txt");
    await expect(droppedRow).toBeVisible({ timeout: 5_000 });
  });

  test("downloading a single file suggests its own filename", async ({ page }) => {
    await uploadFiles(page, [
      { name: "single.txt", mimeType: "text/plain", contents: "solo file" },
    ]);
    await expect(fileListRow(page, "single.txt")).toBeVisible({ timeout: 15_000 });

    await fileListRow(page, "single.txt").click({ button: "right" });
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Download" }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe("single.txt");
  });

  test("downloading two selected files zips them", async ({ page }) => {
    await uploadFiles(page, [
      { name: "one.txt", mimeType: "text/plain", contents: "one" },
      { name: "two.txt", mimeType: "text/plain", contents: "two" },
    ]);
    await expect(fileListRow(page, "one.txt")).toBeVisible({ timeout: 15_000 });
    await expect(fileListRow(page, "two.txt")).toBeVisible({ timeout: 15_000 });

    await fileListRow(page, "one.txt").click();
    await fileListRow(page, "two.txt").click({ modifiers: [PRIMARY_MODIFIER] });

    await fileListRow(page, "two.txt").click({ button: "right" });
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Download" }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/\.zip$/);
  });

  test("right-clicking a folder offers Download as zip and downloads it as a zip", async ({
    page,
  }) => {
    const folderName = uniqueName("subfolder");
    await page.getByRole("button", { name: "New" }).click();
    await page.getByRole("menuitem", { name: "New folder" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Folder name").fill(folderName);
    await dialog.getByRole("button", { name: "Create" }).click();
    await expect(dialog).toBeHidden();
    await expect(fileListRow(page, folderName)).toBeVisible();

    await fileListRow(page, folderName).click({ button: "right" });
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Download as zip" }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/\.zip$/);
  });
});
