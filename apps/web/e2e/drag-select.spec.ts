import { expect, type Locator, type Page, test } from "@playwright/test";
import { listing } from "./support/regions.js";
import { uniqueName } from "./support/unique.js";
import { uploadFiles } from "./support/upload.js";

async function createFolder(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Folder name").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
}

/** Creates a fresh sandbox folder under root, navigates into it, and returns its name. */
async function createSandbox(page: Page, prefix: string): Promise<string> {
  const sandbox = uniqueName(prefix);
  await page.goto("/files");
  await createFolder(page, sandbox);
  await listing(page).getByText(sandbox, { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}$`));
  return sandbox;
}

/** The listing row or tile (the `[data-path]` element) for a given file's name. */
function entryFor(page: Page, name: string): Locator {
  return listing(page).locator("[data-path]").filter({ hasText: name });
}

async function boundingBoxOf(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error("locator is not visible");
  }
  return box;
}

async function centerPoint(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await boundingBoxOf(locator);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * A point just below `entry`'s own bottom edge, at its horizontal center:
 * for the last row in list view, that is genuinely empty listing space
 * (below the last row). Used as a drag's start point, mirroring where a
 * Finder-style marquee drag used to start before drag-to-select was removed.
 */
async function belowPoint(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await boundingBoxOf(locator);
  return { x: box.x + box.width / 2, y: box.y + box.height + 8 };
}

async function switchToGrid(page: Page): Promise<void> {
  await page.getByRole("button", { name: "View" }).click();
  await page.getByRole("menuitemradio", { name: "Grid" }).click();
  await expect(page.locator('[data-slot="file-grid"]')).toBeVisible();
}

test("dragging the pointer across two rows in list view leaves the selection unchanged", async ({
  page,
}) => {
  await createSandbox(page, "drag-list");
  const base = uniqueName("drag-list");
  const fileA = `${base}-a.txt`;
  const fileB = `${base}-b.txt`;
  await uploadFiles(page, [
    { name: fileA, mimeType: "text/plain", contents: "a" },
    { name: fileB, mimeType: "text/plain", contents: "b" },
  ]);
  await expect(listing(page).getByText(fileB, { exact: true })).toBeVisible();

  const rowA = entryFor(page, fileA);
  const rowB = entryFor(page, fileB);
  await expect(rowA).toHaveAttribute("data-selected", "false");
  await expect(rowB).toHaveAttribute("data-selected", "false");

  // Start below the last row (what used to be empty listing space a marquee
  // could arm from) and drag up across both rows.
  const start = await belowPoint(rowB);
  const end = await centerPoint(rowA);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 20 });
  await page.mouse.up();

  await expect(rowA).toHaveAttribute("data-selected", "false");
  await expect(rowB).toHaveAttribute("data-selected", "false");
  await expect(page.getByText("2 selected", { exact: true })).toBeHidden();
});

test("dragging the pointer across two tiles in grid view leaves the selection unchanged", async ({
  page,
}) => {
  await createSandbox(page, "drag-grid");
  const base = uniqueName("drag-grid");
  const fileA = `${base}-a.txt`;
  const fileB = `${base}-b.txt`;
  await uploadFiles(page, [
    { name: fileA, mimeType: "text/plain", contents: "a" },
    { name: fileB, mimeType: "text/plain", contents: "b" },
  ]);
  await expect(listing(page).getByText(fileB, { exact: true })).toBeVisible();

  await switchToGrid(page);

  const tileA = entryFor(page, fileA);
  const tileB = entryFor(page, fileB);
  await expect(tileA).toHaveAttribute("data-selected", "false");
  await expect(tileB).toHaveAttribute("data-selected", "false");

  const start = await belowPoint(tileB);
  const end = await centerPoint(tileA);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 20 });
  await page.mouse.up();

  await expect(tileA).toHaveAttribute("data-selected", "false");
  await expect(tileB).toHaveAttribute("data-selected", "false");
});

test("shift-clicking a second row still selects the inclusive range", async ({ page }) => {
  await createSandbox(page, "shift-range");
  const base = uniqueName("shift-range");
  const fileA = `${base}-a.txt`;
  const fileB = `${base}-b.txt`;
  const fileC = `${base}-c.txt`;
  await uploadFiles(page, [
    { name: fileA, mimeType: "text/plain", contents: "a" },
    { name: fileB, mimeType: "text/plain", contents: "b" },
    { name: fileC, mimeType: "text/plain", contents: "c" },
  ]);
  await expect(listing(page).getByText(fileC, { exact: true })).toBeVisible();

  const rowA = entryFor(page, fileA);
  const rowB = entryFor(page, fileB);
  const rowC = entryFor(page, fileC);

  await listing(page).getByText(fileA, { exact: true }).click();
  await expect(rowA).toHaveAttribute("data-selected", "true");

  await listing(page)
    .getByText(fileC, { exact: true })
    .click({ modifiers: ["Shift"] });

  await expect(rowA).toHaveAttribute("data-selected", "true");
  await expect(rowB).toHaveAttribute("data-selected", "true");
  await expect(rowC).toHaveAttribute("data-selected", "true");
  await expect(page.getByText("3 selected", { exact: true })).toBeVisible();
});
