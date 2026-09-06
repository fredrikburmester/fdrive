import { expect, type Page, test } from "@playwright/test";
import { listing } from "./support/regions.js";
import { uniqueName } from "./support/unique.js";

/** The `data-path` values of every currently-rendered listing row, in DOM order. */
async function visibleRowPaths(page: Page): Promise<string[]> {
  const rows = listing(page).locator("[data-path]");
  const paths = await rows.evaluateAll((elements) =>
    elements.map((el) => el.getAttribute("data-path")),
  );
  return paths.filter((path): path is string => path !== null);
}

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
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirmDialog = page.getByRole("alertdialog");
  await confirmDialog.getByRole("button", { name: "Delete" }).click();
  await expect(confirmDialog).toBeHidden();
}

test("root listing shows docs and photo.jpg", async ({ page }) => {
  await page.goto("/files");

  await expect(listing(page).getByText("docs", { exact: true })).toBeVisible();
  await expect(listing(page).getByText("photo.jpg", { exact: true })).toBeVisible();
});

test("folders sort first even when sorting by name descending", async ({ page }) => {
  await page.goto("/files");
  await expect(listing(page).getByText("photo.jpg", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Name" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Descending" }).click();

  const paths = await visibleRowPaths(page);
  const docsIndex = paths.indexOf("/docs");
  const photoIndex = paths.indexOf("/photo.jpg");
  expect(docsIndex).toBeGreaterThanOrEqual(0);
  expect(photoIndex).toBeGreaterThan(docsIndex);
});

test("double-clicking docs navigates into it and shows its contents", async ({ page }) => {
  await page.goto("/files");

  await listing(page).getByText("docs", { exact: true }).dblclick();

  await expect(page).toHaveURL(/\/files\/docs$/);
  await expect(listing(page).getByText("readme.md", { exact: true })).toBeVisible();
  await expect(listing(page).getByText("report.pdf", { exact: true })).toBeVisible();
});

test("clicking the Home breadcrumb returns to root", async ({ page }) => {
  await page.goto("/files/docs");
  await expect(listing(page).getByText("readme.md", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Home" }).click();

  await expect(page).toHaveURL(/\/files$/);
  await expect(listing(page).getByText("photo.jpg", { exact: true })).toBeVisible();
});

test("the view toggle switches to grid and back, and persists across reload", async ({ page }) => {
  await page.goto("/files");
  await expect(listing(page).getByText("photo.jpg", { exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="file-list"]')).toBeVisible();

  await page.getByRole("button", { name: "Grid view" }).click();
  await expect(page.locator('[data-slot="file-grid"]')).toBeVisible();

  await page.reload();
  await expect(page.locator('[data-slot="file-grid"]')).toBeVisible();

  await page.getByRole("button", { name: "List view" }).click();
  await expect(page.locator('[data-slot="file-list"]')).toBeVisible();
});

test("sorting by size flips the order of docs' contents", async ({ page }) => {
  await page.goto("/files/docs");
  await expect(listing(page).getByText("report.pdf", { exact: true })).toBeVisible();

  const byName = await visibleRowPaths(page);
  expect(byName.indexOf("/docs/readme.md")).toBeLessThan(byName.indexOf("/docs/report.pdf"));

  await page.getByRole("button", { name: "Name" }).click();
  await page.getByRole("menuitemradio", { name: "Size" }).click();

  const bySize = await visibleRowPaths(page);
  expect(bySize.indexOf("/docs/report.pdf")).toBeLessThan(bySize.indexOf("/docs/readme.md"));
});

test("a very long folder name never widens the page past the viewport", async ({ page }) => {
  // 120 characters, no spaces, so it cannot wrap: exactly the shape that
  // exposed the missing `min-w-0` in the shell's flex chain, which let a
  // single unbreakable name push `<main>` wider than the viewport.
  const name = uniqueName("very-long-folder-name-for-overflow-test").padEnd(120, "x");
  await page.goto("/files");

  await createFolder(page, name);
  await listing(page).getByText(name, { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${name}$`));

  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);

  await page.getByRole("link", { name: "Home" }).click();
  await deleteEntry(page, name);
});
