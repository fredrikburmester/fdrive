import { expect, type Page, test } from "@playwright/test";
import { listing } from "./support/regions.js";
import { uniqueName } from "./support/unique.js";
import { uploadFiles } from "./support/upload.js";

const PRIMARY_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

function fileListRow(page: Page, name: string) {
  return listing(page).getByText(name, { exact: true });
}

async function createFolder(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Folder name").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
}

async function createSandbox(page: Page): Promise<string> {
  const sandbox = uniqueName("controls");
  await page.goto("/files");
  await createFolder(page, sandbox);
  await listing(page).getByText(sandbox, { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}$`));
  return sandbox;
}

test.describe("file controls ux", () => {
  test("far-offscreen reveal scrolls item into view and survives URL cleanup", async ({ page }) => {
    const sandbox = await createSandbox(page);

    // Upload 35 files so the bottom items are far beyond the virtual viewport
    const files = Array.from({ length: 35 }, (_, index) => {
      const padded = String(index).padStart(2, "0");
      return {
        name: `item-${padded}.txt`,
        mimeType: "text/plain",
        contents: `content ${padded}`,
      };
    });
    await uploadFiles(page, files);
    await expect(fileListRow(page, "item-00.txt")).toBeVisible({ timeout: 15_000 });

    // Navigate to enclosing folder with select query pointing to the last item
    const targetFile = "item-34.txt";
    await page.goto(`/files/${sandbox}?select=${targetFile}`);

    // Verify row is scrolled into view and selected
    const targetRow = page.locator(`[data-path="/${sandbox}/${targetFile}"]`);
    await expect(targetRow).toBeVisible();
    await expect(targetRow).toBeInViewport();
    await expect(targetRow).toHaveAttribute("data-selected", "true");
    await expect(page.getByText("1 selected")).toBeVisible();

    // Verify URL query parameter was cleaned up while selection persists
    await expect(page).toHaveURL(new RegExp(`/files/${sandbox}$`));
    await expect(targetRow).toHaveAttribute("data-selected", "true");
    await expect(page.getByText("1 selected")).toBeVisible();
  });

  test("repeated reveal of the same file scrolls into view after scrolling away", async ({
    page,
  }) => {
    const sandbox = await createSandbox(page);

    const files = Array.from({ length: 35 }, (_, index) => {
      const padded = String(index).padStart(2, "0");
      return {
        name: `item-${padded}.txt`,
        mimeType: "text/plain",
        contents: `content ${padded}`,
      };
    });
    await uploadFiles(page, files);
    await expect(fileListRow(page, "item-00.txt")).toBeVisible({ timeout: 15_000 });

    const targetFile = "item-34.txt";
    await page.goto(`/files/${sandbox}?select=${targetFile}`);

    const targetRow = page.locator(`[data-path="/${sandbox}/${targetFile}"]`);
    await expect(targetRow).toBeInViewport();
    await expect(page).toHaveURL(new RegExp(`/files/${sandbox}$`));

    // Scroll back to top
    await page.locator('[data-slot="file-list"]').evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(targetRow).not.toBeInViewport();

    // Reveal again through client-side navigation, retaining the mounted browser.
    await page.evaluate(
      (href) => window.history.pushState(null, "", href),
      `/files/${sandbox}?select=${targetFile}`,
    );

    // Verify it scrolled back into view
    await expect(targetRow).toBeInViewport();
    await expect(page).toHaveURL(new RegExp(`/files/${sandbox}$`));
  });

  test("ordinary keyboard selection is preserved after reveal without stale scrolling", async ({
    page,
  }) => {
    const sandbox = await createSandbox(page);

    const files = Array.from({ length: 25 }, (_, index) => {
      const padded = String(index).padStart(2, "0");
      return {
        name: `item-${padded}.txt`,
        mimeType: "text/plain",
        contents: `content ${padded}`,
      };
    });
    await uploadFiles(page, files);
    await expect(fileListRow(page, "item-00.txt")).toBeVisible({ timeout: 15_000 });

    const targetFile = "item-24.txt";
    await page.goto(`/files/${sandbox}?select=${targetFile}`);

    const targetRow = page.locator(`[data-path="/${sandbox}/${targetFile}"]`);
    await expect(targetRow).toBeInViewport();
    await expect(page).toHaveURL(new RegExp(`/files/${sandbox}$`));

    // Focus the listing host and press ArrowUp to navigate selection
    await page.locator('[data-slot="file-list"]').focus();
    await page.keyboard.press("ArrowUp");

    const prevRow = page.locator(`[data-path="/${sandbox}/item-23.txt"]`);
    await expect(prevRow).toHaveAttribute("data-selected", "true");
    await expect(page.getByText("1 selected")).toBeVisible();
  });

  test("download selected files toolbar action downloads zip for multi-selection and direct file for single", async ({
    page,
  }) => {
    await createSandbox(page);

    await uploadFiles(page, [
      { name: "first.txt", mimeType: "text/plain", contents: "first content" },
      { name: "second.txt", mimeType: "text/plain", contents: "second content" },
    ]);
    await expect(fileListRow(page, "first.txt")).toBeVisible({ timeout: 15_000 });
    await expect(fileListRow(page, "second.txt")).toBeVisible({ timeout: 15_000 });

    // Multi-selection: select first and second
    await fileListRow(page, "first.txt").click();
    await fileListRow(page, "second.txt").click({ modifiers: [PRIMARY_MODIFIER] });

    await expect(page.getByText("2 selected")).toBeVisible();

    // Click download button in the toolbar selection pill
    const downloadZipPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download" }).click();
    const zipDownload = await downloadZipPromise;
    expect(zipDownload.suggestedFilename()).toMatch(/\.zip$/);

    // Single-selection: select only first
    await fileListRow(page, "first.txt").click();
    await expect(page.getByText("1 selected")).toBeVisible();

    const downloadSinglePromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download" }).click();
    const singleDownload = await downloadSinglePromise;
    expect(singleDownload.suggestedFilename()).toBe("first.txt");
  });

  test("view menu Show thumbnails option persists across reload", async ({ page }) => {
    await page.goto("/files");
    await expect(fileListRow(page, "photo.jpg")).toBeVisible();

    // Open View dropdown menu
    await page.getByRole("button", { name: "View" }).click();
    const checkboxItem = page.getByRole("menuitemcheckbox", { name: /Show thumbnails/ });
    await expect(checkboxItem).toBeVisible();
    await expect(checkboxItem).toHaveAttribute("aria-checked", "false");

    // Enable show thumbnails
    await checkboxItem.click();

    // In list view with thumbnails enabled, photo.jpg row renders an img thumbnail
    const photoRow = page.locator('[data-path="/photo.jpg"]');
    await expect(photoRow.locator("img")).toBeVisible();

    // Reload page to verify persistence
    await page.reload();
    await expect(fileListRow(page, "photo.jpg")).toBeVisible();
    await expect(photoRow.locator("img")).toBeVisible();

    // Open View menu again to verify checkbox state persists
    await page.getByRole("button", { name: "View" }).click();
    const reloadedCheckboxItem = page.getByRole("menuitemcheckbox", { name: /Show thumbnails/ });
    await expect(reloadedCheckboxItem).toHaveAttribute("aria-checked", "true");
  });
});
