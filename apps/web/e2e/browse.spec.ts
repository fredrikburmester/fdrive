import { expect, type Page, test } from "@playwright/test";

/** The `data-path` values of every currently-rendered listing row, in DOM order. */
async function visibleRowPaths(page: Page): Promise<string[]> {
  const rows = page.locator("[data-path]");
  const paths = await rows.evaluateAll((elements) =>
    elements.map((el) => el.getAttribute("data-path")),
  );
  return paths.filter((path): path is string => path !== null);
}

test("root listing shows docs and photo.jpg", async ({ page }) => {
  await page.goto("/files");

  await expect(page.getByText("docs", { exact: true })).toBeVisible();
  await expect(page.getByText("photo.jpg", { exact: true })).toBeVisible();
});

test("folders sort first even when sorting by name descending", async ({ page }) => {
  await page.goto("/files");
  await expect(page.getByText("photo.jpg", { exact: true })).toBeVisible();

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

  await page.getByText("docs", { exact: true }).dblclick();

  await expect(page).toHaveURL(/\/files\/docs$/);
  await expect(page.getByText("readme.md", { exact: true })).toBeVisible();
  await expect(page.getByText("report.pdf", { exact: true })).toBeVisible();
});

test("clicking the Home breadcrumb returns to root", async ({ page }) => {
  await page.goto("/files/docs");
  await expect(page.getByText("readme.md", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Home" }).click();

  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByText("photo.jpg", { exact: true })).toBeVisible();
});

test("the view toggle switches to grid and back, and persists across reload", async ({ page }) => {
  await page.goto("/files");
  await expect(page.getByText("photo.jpg", { exact: true })).toBeVisible();
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
  await expect(page.getByText("report.pdf", { exact: true })).toBeVisible();

  const byName = await visibleRowPaths(page);
  expect(byName.indexOf("/docs/readme.md")).toBeLessThan(byName.indexOf("/docs/report.pdf"));

  await page.getByRole("button", { name: "Name" }).click();
  await page.getByRole("menuitemradio", { name: "Size" }).click();

  const bySize = await visibleRowPaths(page);
  expect(bySize.indexOf("/docs/report.pdf")).toBeLessThan(bySize.indexOf("/docs/readme.md"));
});
