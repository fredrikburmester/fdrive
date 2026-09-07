import { expect, type Page, test } from "@playwright/test";
import { listing, sidebar } from "./support/regions.js";
import { uniqueName } from "./support/unique.js";

/** The `[data-slot="tree-row-skeleton"]` shown for a sidebar tree row still
 * waiting on its listing after `SKELETON_DELAY_MS` (see `folder-tree.tsx`). */
function sidebarSkeleton(page: Page) {
  return sidebar(page).locator('[data-slot="tree-row-skeleton"]');
}

async function createFolder(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Folder name").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
}

test("the sidebar tree shows seeded folders, navigates on click, and highlights the current folder", async ({
  page,
}) => {
  await page.goto("/files");

  // The tree starts collapsed; expanding "Files" reveals the seeded top-level folders.
  await page.getByRole("button", { name: "Expand Files" }).click();

  // Scoped to the sidebar, not just `page`: the current folder's breadcrumb
  // crumb (`BreadcrumbPage`) also has `role="link"` (shadcn's convention for
  // marking it non-navigable via `aria-disabled`), so an unscoped query for
  // "docs" resolves to two elements once the browser navigates there.
  const docsLink = sidebar(page).getByRole("link", { name: "docs", exact: true });
  await expect(docsLink).toBeVisible();
  await expect(docsLink).not.toHaveAttribute("data-active", "");

  await docsLink.click();

  await expect(page).toHaveURL(/\/files\/docs$/);
  await expect(docsLink).toHaveAttribute("data-active", "");
});

test("creating a folder in the listing makes it appear in the sidebar tree", async ({ page }) => {
  const name = uniqueName("tree-sync");
  await page.goto("/files");
  await page.getByRole("button", { name: "Expand Files" }).click();

  await expect(sidebar(page).getByRole("link", { name })).toBeHidden();

  await createFolder(page, name);

  await expect(listing(page).getByText(name, { exact: true })).toBeVisible();
  await expect(sidebar(page).getByRole("link", { name })).toBeVisible();

  // Clean up: the folder is created directly under alice's shared root.
  await listing(page).getByText(name, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirmDialog = page.getByRole("alertdialog");
  await confirmDialog.getByRole("button", { name: "Delete" }).click();
  await expect(confirmDialog).toBeHidden();
});

test("a folder with only files shows no chevron once its listing is known", async ({ page }) => {
  await page.goto("/files");
  await page.getByRole("button", { name: "Expand Files" }).click();

  // Seeded "docs" holds only readme.md and report.pdf (see testkit's
  // SEED_FILES): once its own listing has been prefetched in the
  // background, it is known to have no subfolders, so its row shows no
  // chevron at all (clicking the row still just navigates into it).
  const docsRow = sidebar(page).locator('[data-path="/docs"]');
  await expect(docsRow).toBeVisible();
  await expect(docsRow.getByRole("button")).toHaveCount(0);
  await expect(docsRow.getByRole("link", { name: "docs", exact: true })).toBeVisible();
});

test("a folder with subfolders shows a chevron and expands without a skeleton flash", async ({
  page,
}) => {
  const parent = uniqueName("tree-parent");
  const child = uniqueName("tree-child");

  await page.goto("/files");
  await createFolder(page, parent);
  await listing(page).getByText(parent, { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${parent}$`));
  await createFolder(page, child);

  // Navigating into `parent` above already expanded "Files" in the sidebar
  // (it auto-expands every ancestor of the current route), so it stays
  // expanded on the way back and `parent`'s row is already visible.
  await sidebar(page).getByRole("link", { name: "Files" }).click();
  await expect(page).toHaveURL(/\/files$/);

  const parentRow = sidebar(page).locator(`[data-path="/${parent}"]`);
  await expect(parentRow).toBeVisible();
  const chevron = parentRow.getByRole("button", { name: `Expand ${parent}` });
  await expect(chevron).toBeVisible();

  await chevron.click();

  // Sample repeatedly through the delay window the skeleton would need to
  // clear (see `SKELETON_DELAY_MS` in `folder-tree.tsx`): the child's
  // listing was already prefetched once `parent` became visible above, so
  // expanding it never shows a loading skeleton at any sampled moment.
  const deadline = Date.now() + 150;
  while (Date.now() < deadline) {
    await expect(sidebarSkeleton(page)).toHaveCount(0);
    await page.waitForTimeout(20);
  }

  await expect(sidebar(page).getByRole("link", { name: child })).toBeVisible();

  // Clean up: deleting the parent removes both folders. Still on the Files
  // root listing from the navigation above.
  await expect(listing(page).getByText(parent, { exact: true })).toBeVisible();
  await listing(page).getByText(parent, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirmDialog = page.getByRole("alertdialog");
  await confirmDialog.getByRole("button", { name: "Delete" }).click();
  await expect(confirmDialog).toBeHidden();
});
