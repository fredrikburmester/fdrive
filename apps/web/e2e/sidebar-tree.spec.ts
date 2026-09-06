import { expect, test } from "@playwright/test";
import { listing, sidebar } from "./support/regions.js";
import { uniqueName } from "./support/unique.js";

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
  const docsLink = sidebar(page).getByRole("link", { name: "docs" });
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

  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Folder name").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();

  await expect(listing(page).getByText(name, { exact: true })).toBeVisible();
  await expect(sidebar(page).getByRole("link", { name })).toBeVisible();

  // Clean up: the folder is created directly under alice's shared root.
  await listing(page).getByText(name, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirmDialog = page.getByRole("alertdialog");
  await confirmDialog.getByRole("button", { name: "Delete" }).click();
  await expect(confirmDialog).toBeHidden();
});
