import { expect, type Locator, type Page, test } from "@playwright/test";
import { listing } from "./support/regions.js";
import { uniqueName } from "./support/unique.js";
import { uploadFiles } from "./support/upload.js";

const PRIMARY_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

async function createFolder(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Folder name").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
}

/** Creates a fresh sandbox folder under root, navigates into it, and returns its name. */
async function createSandbox(page: Page): Promise<string> {
  const sandbox = uniqueName("marquee");
  await page.goto("/files");
  await createFolder(page, sandbox);
  await listing(page).getByText(sandbox, { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}$`));
  return sandbox;
}

/** The listing row (the `[data-path]` element) for a given file's name. */
function rowFor(page: Page, name: string): Locator {
  return listing(page).locator("[data-path]").filter({ hasText: name });
}

/**
 * A point just below `row`'s own bottom edge, at its horizontal center: for
 * the last row in the listing, that is genuinely empty listing space (below
 * the last row), so pressing there arms the marquee instead of acting on
 * any row. Unlike a row's own left/right gutter, this point never depends
 * on the row's measured width, so it stays reliable regardless of how wide
 * the listing itself renders.
 */
async function belowRowPoint(row: Locator): Promise<{ x: number; y: number }> {
  const box = await row.boundingBox();
  if (box === null) {
    throw new Error("row is not visible");
  }
  return { x: box.x + box.width / 2, y: box.y + box.height + 8 };
}

async function centerPoint(row: Locator): Promise<{ x: number; y: number }> {
  const box = await row.boundingBox();
  if (box === null) {
    throw new Error("row is not visible");
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test("dragging a marquee across two rows selects them and shows 2 selected", async ({ page }) => {
  await createSandbox(page);
  const base = uniqueName("marquee");
  const fileA = `${base}-a.txt`;
  const fileB = `${base}-b.txt`;
  await uploadFiles(page, [
    { name: fileA, mimeType: "text/plain", contents: "a" },
    { name: fileB, mimeType: "text/plain", contents: "b" },
  ]);
  await expect(listing(page).getByText(fileB, { exact: true })).toBeVisible();

  const rowA = rowFor(page, fileA);
  const rowB = rowFor(page, fileB);

  // Start below the last row (genuinely empty listing space) and drag up
  // into the first row, covering both.
  const start = await belowRowPoint(rowB);
  const end = await centerPoint(rowA);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 20 });
  await page.mouse.up();

  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await expect(rowA).toHaveAttribute("data-selected", "true");
  await expect(rowB).toHaveAttribute("data-selected", "true");

  // A third file, added afterwards, starts out unselected; a Cmd/Ctrl-drag
  // over it adds it to the existing selection instead of replacing it.
  const fileC = `${base}-c.txt`;
  await uploadFiles(page, [{ name: fileC, mimeType: "text/plain", contents: "c" }]);
  const rowC = rowFor(page, fileC);
  await expect(rowC).toBeVisible();
  await expect(rowC).toHaveAttribute("data-selected", "false");

  const startC = await belowRowPoint(rowC);
  await page.keyboard.down(PRIMARY_MODIFIER);
  await page.mouse.move(startC.x, startC.y);
  await page.mouse.down();
  await page.mouse.move(startC.x, startC.y - 20, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up(PRIMARY_MODIFIER);

  await expect(page.getByText("3 selected", { exact: true })).toBeVisible();
  await expect(rowA).toHaveAttribute("data-selected", "true");
  await expect(rowB).toHaveAttribute("data-selected", "true");
  await expect(rowC).toHaveAttribute("data-selected", "true");
});

test("pressing Escape mid-drag cancels the marquee and restores the previous selection", async ({
  page,
}) => {
  await createSandbox(page);
  const base = uniqueName("marquee-esc");
  const fileA = `${base}-a.txt`;
  const fileB = `${base}-b.txt`;
  await uploadFiles(page, [
    { name: fileA, mimeType: "text/plain", contents: "a" },
    { name: fileB, mimeType: "text/plain", contents: "b" },
  ]);
  await expect(listing(page).getByText(fileB, { exact: true })).toBeVisible();

  const rowA = rowFor(page, fileA);
  const rowB = rowFor(page, fileB);

  // Select fileA alone first, as the selection a cancelled drag should restore.
  await listing(page).getByText(fileA, { exact: true }).click();
  await expect(rowA).toHaveAttribute("data-selected", "true");
  await expect(rowB).toHaveAttribute("data-selected", "false");

  const start = await belowRowPoint(rowB);
  const end = await centerPoint(rowA);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Move far enough to pass the drag threshold and cover both rows, so the
  // marquee is visibly selecting fileB too before it gets cancelled.
  await page.mouse.move(end.x, end.y, { steps: 20 });
  await expect(rowB).toHaveAttribute("data-selected", "true");

  await page.keyboard.press("Escape");
  await page.mouse.up();

  // The selection is back to just fileA, as it was before the drag started.
  await expect(rowA).toHaveAttribute("data-selected", "true");
  await expect(rowB).toHaveAttribute("data-selected", "false");
});
