import { expect, type Page, test } from "@playwright/test";
import { listing, sidebar } from "./support/regions.js";
import { removeSandbox } from "./support/sandbox.js";
import { uniqueName } from "./support/unique.js";
import { createViewFolder } from "./support/view-folder.js";

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

test("navigating, even into Shared with me, leaves the sidebar tree as the user left it", async ({
  page,
}) => {
  const docsLink = sidebar(page).getByRole("link", { name: "docs", exact: true });

  await page.goto("/files/docs");
  await expect(listing(page).getByText("readme.md", { exact: true })).toBeVisible();
  await page.goto("/files/Shared%20with%20me");
  await expect(page).toHaveURL(/\/files\/Shared%20with%20me$/);
  await expect(page.getByRole("button", { name: "Expand Files" })).toBeVisible();
  await expect(docsLink).toBeHidden();

  // Opened by hand, it stays open across navigation and reload.
  await page.getByRole("button", { name: "Expand Files" }).click();
  await expect(docsLink).toBeVisible();
  await page.goto("/files/docs");
  await page.reload();
  await expect(docsLink).toBeVisible();

  // Expanding a folder in the listing's tree (the beta list's default) never opens it in the
  // sidebar. In a folder of its own: the shared root has too many rows to find docs in.
  await page.getByRole("button", { name: "Collapse Files" }).click();
  await page.evaluate(() => localStorage.setItem("fdrive.list.design", '"beta"'));
  const path = await createViewFolder(page, true);
  const listedDocs = listing(page).locator(`[data-path="${path}/docs"]`);
  await listedDocs.hover();
  await listedDocs.getByRole("button", { name: "Expand docs" }).click();
  await expect(listing(page).getByText("readme.md", { exact: true })).toBeVisible();
  await page.reload();
  await expect(listing(page).getByText("readme.md", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Expand Files" })).toBeVisible();
  await expect(docsLink).toBeHidden();
  await removeSandbox(page, path.slice(1));
});

test("the fdrive wordmark returns to the root of Files from a nested folder", async ({ page }) => {
  await page.goto("/files/docs");
  await expect(listing(page).getByText("readme.md", { exact: true })).toBeVisible();

  await sidebar(page).getByRole("link", { name: "fdrive", exact: true }).click();

  await expect(page).toHaveURL(/\/files$/);
  await expect(listing(page).getByText("docs", { exact: true })).toBeVisible();
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
  await removeSandbox(page, name);
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
  // By URL: a new folder is selected, not scrolled to, and the shared root's
  // virtualized listing may not render its row.
  await page.goto(`/files/${parent}`);
  await expect(page).toHaveURL(new RegExp(`/files/${parent}$`));
  await createFolder(page, child);

  await sidebar(page).getByRole("link", { name: "Files" }).click();
  await expect(page).toHaveURL(/\/files$/);
  await page.getByRole("button", { name: "Expand Files" }).click();

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

  // Clean up: deleting the parent removes both folders.
  await removeSandbox(page, parent);
});
