import { expect, type Page, test } from "@playwright/test";
import { listing } from "./support/regions.js";
import { openSandbox } from "./support/sandbox.js";
import { shareImageFixture } from "./support/share-fixture.js";
import { uniqueName } from "./support/unique.js";
import { fileInputLocator, uploadFiles } from "./support/upload.js";

const PRIMARY_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

function fileListRow(page: Page, name: string) {
  return listing(page).getByText(name, { exact: true });
}

async function createSandbox(page: Page): Promise<string> {
  return openSandbox(page, "controls");
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
    await expect(page.getByText(`${files.length} selected`, { exact: true })).toBeVisible({
      timeout: 15_000,
    });

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
    await expect(page.getByText(`${files.length} selected`, { exact: true })).toBeVisible({
      timeout: 15_000,
    });

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
    await expect(page.getByText(`${files.length} selected`, { exact: true })).toBeVisible({
      timeout: 15_000,
    });

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
    const sandbox = await createSandbox(page);
    const name = `${uniqueName("list-thumb")}.png`;
    // The browser harness uses a fake indexer and never generates thumbnail files.
    await page.route(
      (url) =>
        url.pathname.endsWith("/thumb") && url.searchParams.get("path") === `/${sandbox}/${name}`,
      async (route) => {
        expect(new URL(route.request().url()).searchParams.get("size")).toBe("256");
        await route.fulfill({ contentType: "image/png", body: shareImageFixture() });
      },
    );
    await fileInputLocator(page).setInputFiles({
      name,
      mimeType: "image/png",
      buffer: shareImageFixture(),
    });
    await expect(fileListRow(page, name)).toBeVisible();

    // Open View dropdown menu
    await page.getByRole("button", { name: "View", exact: true }).click();
    const checkboxItem = page.getByRole("menuitemcheckbox", { name: /Show thumbnails/ });
    await expect(checkboxItem).toBeVisible();
    await expect(checkboxItem).toHaveAttribute("aria-checked", "false");

    // Enable show thumbnails
    await checkboxItem.click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu", { name: "View" })).toBeHidden();

    // Use a decodable image; the seeded photo.jpg intentionally contains fake bytes.
    const photoRow = page.locator(`[data-path="/${sandbox}/${name}"]`);
    await expect(photoRow.locator("img")).toBeVisible();
    await expect
      .poll(() =>
        photoRow
          .locator("img")
          .evaluate(
            (img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0,
          ),
      )
      .toBe(true);

    // Reload page to verify persistence
    await page.reload();
    await expect(fileListRow(page, name)).toBeVisible();
    await expect(photoRow.locator("img")).toBeVisible();
    await expect
      .poll(() =>
        photoRow
          .locator("img")
          .evaluate(
            (img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0,
          ),
      )
      .toBe(true);

    // Open View menu again to verify checkbox state persists
    await page.getByRole("button", { name: "View", exact: true }).click();
    const reloadedCheckboxItem = page.getByRole("menuitemcheckbox", { name: /Show thumbnails/ });
    await expect(reloadedCheckboxItem).toHaveAttribute("aria-checked", "true");
  });

  test("the details panel is open by default on a wide window, and closing it sticks", async ({
    page,
  }) => {
    // A choice saved while the panel started closed does not count: the new default shows once.
    await page.addInitScript(() => localStorage.setItem("fdrive.inspector", "false"));
    await createSandbox(page);
    const panel = page.getByRole("complementary", { name: "Info" });
    await expect(panel.getByText("No selection", { exact: true })).toBeVisible();

    // The upload becomes the selection, which the panel describes.
    await uploadFiles(page, [{ name: "notes.txt", mimeType: "text/plain", contents: "hello" }]);
    await expect(panel.getByText("notes.txt", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText("Kind", { exact: true })).toBeVisible();

    await panel.getByRole("button", { name: "Close info" }).click();
    await expect(panel).toHaveCount(0);
    await page.reload();
    await expect(fileListRow(page, "notes.txt")).toBeVisible();
    await expect(panel).toHaveCount(0);

    await page.getByRole("button", { name: "Toggle details" }).click();
    await expect(panel).toBeVisible();
    await page.reload();
    await expect(panel.getByText("No selection", { exact: true })).toBeVisible();
  });

  test("on a narrow window the details panel never opens by itself", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 720 });
    await createSandbox(page);
    await uploadFiles(page, [{ name: "notes.txt", mimeType: "text/plain", contents: "hello" }]);
    await expect(fileListRow(page, "notes.txt")).toBeVisible({ timeout: 15_000 });
    const sheet = page.getByRole("dialog", { name: "Info" });
    const panel = page.getByRole("complementary", { name: "Info" });
    await expect(sheet).toHaveCount(0);
    await expect(panel).toHaveCount(0);

    // It is a sheet here, opened when asked for.
    await page.getByRole("button", { name: "Toggle details" }).click();
    await expect(sheet.getByText("notes.txt", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    // Closing the sheet is not a choice about the side panel, which a wide window still opens;
    // narrowing the window closes it again rather than covering the listing with a sheet.
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(panel).toBeVisible();
    await page.setViewportSize({ width: 900, height: 720 });
    await expect(panel).toHaveCount(0);
    await expect(sheet).toHaveCount(0);
  });

  test("list rows are roomy by default, and Compact in the View menu brings back the tighter rows", async ({
    page,
  }) => {
    const sandbox = await createSandbox(page);
    await uploadFiles(page, [{ name: "notes.txt", mimeType: "text/plain", contents: "hello" }]);
    const row = page.locator(`[data-path="/${sandbox}/notes.txt"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    const rowHeight = async () => (await row.boundingBox())?.height;
    await expect.poll(rowHeight).toBe(64);

    await page.getByRole("button", { name: "View", exact: true }).click();
    await expect(page.getByRole("menuitemradio", { name: "Comfortable" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByRole("menuitemradio", { name: "Compact" }).click();
    await page.keyboard.press("Escape");
    await expect.poll(rowHeight).toBe(36);

    await page.reload();
    await expect(row).toBeVisible();
    await expect.poll(rowHeight).toBe(36);
  });
});
