import { expect, type Locator, type Page, test } from "@playwright/test";
import { breadcrumb, listing } from "./support/regions.js";
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

async function uploadTextFile(page: Page, name: string, contents: string): Promise<void> {
  await uploadFiles(page, [{ name, mimeType: "text/plain", contents }]);
  await expect(listing(page).getByText(name, { exact: true })).toBeVisible();
}

/** Creates a fresh sandbox folder under root, navigates into it, and returns its name. */
async function createSandbox(page: Page): Promise<string> {
  const sandbox = uniqueName("move-copy");
  await page.goto("/files");
  await createFolder(page, sandbox);
  await listing(page).getByText(sandbox, { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}$`));
  return sandbox;
}

test("Move to moves a file into the chosen folder", async ({ page }) => {
  const sandbox = await createSandbox(page);
  const destination = uniqueName("destination");
  await createFolder(page, destination);
  await uploadTextFile(page, "move-me.txt", "please move me");

  await listing(page).getByText("move-me.txt", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to" }).click();

  const dialog = page.getByRole("dialog").filter({ hasText: "Move to" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: destination }).click();
  await dialog.getByRole("button", { name: "Move here" }).click();
  await expect(dialog).toBeHidden();

  await expect(listing(page).getByText("move-me.txt", { exact: true })).toBeHidden();

  await page.goto(`/files/${sandbox}/${destination}`);
  await expect(listing(page).getByText("move-me.txt", { exact: true })).toBeVisible();
});

test("Copy to leaves the original file in place", async ({ page }) => {
  const sandbox = await createSandbox(page);
  const destination = uniqueName("destination");
  await createFolder(page, destination);
  await uploadTextFile(page, "copy-me.txt", "please copy me");

  await listing(page).getByText("copy-me.txt", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy to" }).click();

  const dialog = page.getByRole("dialog").filter({ hasText: "Copy to" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: destination }).click();
  await dialog.getByRole("button", { name: "Copy here" }).click();
  await expect(dialog).toBeHidden();

  // The original stays in the sandbox root...
  await expect(listing(page).getByText("copy-me.txt", { exact: true })).toBeVisible();

  // ...and a copy now exists in the destination too.
  await page.goto(`/files/${sandbox}/${destination}`);
  await expect(listing(page).getByText("copy-me.txt", { exact: true })).toBeVisible();
});

test("dragging a file row onto a folder row moves it there", async ({ page }) => {
  const sandbox = await createSandbox(page);
  const destination = uniqueName("dropzone");
  await createFolder(page, destination);
  await uploadTextFile(page, "drag-me.txt", "please drag me");

  const source = listing(page).getByText("drag-me.txt", { exact: true });
  const target = listing(page).getByText(destination, { exact: true });

  await source.dragTo(target);

  await page.goto(`/files/${sandbox}/${destination}`);
  await expect(listing(page).getByText("drag-me.txt", { exact: true })).toBeVisible();
});

/**
 * Holds the pointer over `point`, nudging it by a pixel a few times with
 * short pauses in between. Chromium throttles and coalesces `dragover`
 * dispatch during an HTML5 drag, so a single jump to the target (even with
 * many interpolated `steps`) can leave the drag still mid-flight through
 * whatever elements were between source and target when the button is
 * released; a few real, separate mouse moves at the destination give it
 * time to actually settle there.
 */
async function settleDragAt(page: Page, point: { x: number; y: number }): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(point.x + (i % 2), point.y);
    await page.waitForTimeout(75);
  }
}

/** Manually drives a drag from `source` to `target`, optionally holding a
 * modifier key throughout, the way `Locator.dragTo` does internally but
 * with control over modifier keys, which `dragTo` does not expose, and with
 * an explicit settle (see `settleDragAt`) before releasing. */
async function dragWithModifier(
  page: Page,
  source: Locator,
  target: Locator,
  modifier?: "Alt",
): Promise<void> {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (sourceBox === null || targetBox === null) {
    throw new Error("drag source or target is not visible");
  }
  const targetPoint = {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + targetBox.height / 2,
  };
  if (modifier !== undefined) {
    await page.keyboard.down(modifier);
  }
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 20 });
  await settleDragAt(page, targetPoint);
  await page.mouse.up();
  if (modifier !== undefined) {
    await page.keyboard.up(modifier);
  }
}

test("dropping a file onto a breadcrumb ancestor moves it up out of the current folder", async ({
  page,
}) => {
  const sandbox = await createSandbox(page);
  const nested = uniqueName("nested");
  await createFolder(page, nested);
  await listing(page).getByText(nested, { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}/${nested}$`));
  await uploadTextFile(page, "up-me.txt", "please move me up");

  const source = listing(page).getByText("up-me.txt", { exact: true });
  const ancestorCrumb = breadcrumb(page).getByRole("link", { name: sandbox });

  await dragWithModifier(page, source, ancestorCrumb);

  await expect(listing(page).getByText("up-me.txt", { exact: true })).toBeHidden();

  await page.goto(`/files/${sandbox}`);
  await expect(listing(page).getByText("up-me.txt", { exact: true })).toBeVisible();
});

test("Alt-dropping a file onto a breadcrumb ancestor copies it instead of moving it", async ({
  page,
}) => {
  const sandbox = await createSandbox(page);
  const nested = uniqueName("nested");
  await createFolder(page, nested);
  await listing(page).getByText(nested, { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}/${nested}$`));
  await uploadTextFile(page, "copy-up.txt", "please copy me up");

  const source = listing(page).getByText("copy-up.txt", { exact: true });
  const ancestorCrumb = breadcrumb(page).getByRole("link", { name: sandbox });

  await dragWithModifier(page, source, ancestorCrumb, "Alt");

  // The original stays in the nested folder...
  await expect(listing(page).getByText("copy-up.txt", { exact: true })).toBeVisible();

  // ...and a copy now exists in the ancestor too.
  await page.goto(`/files/${sandbox}`);
  await expect(listing(page).getByText("copy-up.txt", { exact: true })).toBeVisible();
});

test("dragging a file over its own parent's breadcrumb shows no drop highlight", async ({
  page,
}) => {
  await createSandbox(page);
  await uploadTextFile(page, "stay-here.txt", "no highlight please");

  const source = listing(page).getByText("stay-here.txt", { exact: true });
  // The current folder is the file's own parent: it renders as the last,
  // non-linked breadcrumb segment (`BreadcrumbPage`, `role="link"` with
  // `aria-disabled`), so it is targeted by its accessible name too.
  const ownParentCrumb = breadcrumb(page).getByRole("link", { name: /move-copy/ });

  const sourceBox = await source.boundingBox();
  const targetBox = await ownParentCrumb.boundingBox();
  if (sourceBox === null || targetBox === null) {
    throw new Error("drag source or target is not visible");
  }
  const targetPoint = {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + targetBox.height / 2,
  };

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 20 });
  await settleDragAt(page, targetPoint);

  await expect(ownParentCrumb).not.toHaveAttribute("data-drop-target", "true");

  await page.mouse.up();
});
