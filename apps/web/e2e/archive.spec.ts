import { expect, type Page, test } from "@playwright/test";
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

async function uploadTextFile(page: Page, name: string, contents: string): Promise<void> {
  await uploadFiles(page, [{ name, mimeType: "text/plain", contents }]);
  await expect(listing(page).getByText(name, { exact: true })).toBeVisible();
}

/** Creates a fresh sandbox folder under root, navigates into it, and returns its name. */
async function createSandbox(page: Page): Promise<string> {
  const sandbox = uniqueName("archive");
  await page.goto("/files");
  await createFolder(page, sandbox);
  await listing(page).getByText(sandbox, { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}$`));
  return sandbox;
}

test("Duplicate creates a copy with a unique name", async ({ page }) => {
  await createSandbox(page);
  await uploadTextFile(page, "readme.md", "hello");

  await listing(page).getByText("readme.md", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate" }).click();

  await expect(listing(page).getByText("readme copy.md", { exact: true })).toBeVisible();
});

test("Compress builds a zip that shows as a job in the Activity panel and appears in the listing", async ({
  page,
}) => {
  const sandbox = await createSandbox(page);
  await createFolder(page, "docs");
  await listing(page).getByText("docs", { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}/docs$`));
  await uploadTextFile(page, "note.txt", "a note");
  await page.getByRole("link", { name: "Home" }).click();
  await listing(page).getByText(sandbox, { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}$`));

  await listing(page).getByText("docs", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Compress" }).click();

  const dialog = page.getByRole("dialog").filter({ hasText: "Compress" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Compress" }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByText(/Compressing/i).first()).toBeVisible();
  await expect(listing(page).getByText("docs.zip", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
});

test("Compress also works with the tar.gz format", async ({ page }) => {
  const sandbox = await createSandbox(page);
  await createFolder(page, "docs");
  await listing(page).getByText("docs", { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}/docs$`));
  await uploadTextFile(page, "note.txt", "a note");
  await page.getByRole("link", { name: "Home" }).click();
  await listing(page).getByText(sandbox, { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}$`));

  await listing(page).getByText("docs", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Compress" }).click();

  const dialog = page.getByRole("dialog").filter({ hasText: "Compress" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: /Tar\.gz/ }).click();
  await dialog.getByRole("button", { name: "Compress" }).click();
  await expect(dialog).toBeHidden();

  await expect(listing(page).getByText("docs.tar.gz", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
});

test("Extract to unpacks the archive into a new folder under the chosen destination", async ({
  page,
}) => {
  const sandbox = await createSandbox(page);
  await createFolder(page, "docs");
  await listing(page).getByText("docs", { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}/docs$`));
  await uploadTextFile(page, "note.txt", "a note");
  await page.getByRole("link", { name: "Home" }).click();
  await listing(page).getByText(sandbox, { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}$`));

  await listing(page).getByText("docs", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Compress" }).click();
  const compressDialog = page.getByRole("dialog").filter({ hasText: "Compress" });
  await compressDialog.getByRole("button", { name: "Compress" }).click();
  await expect(compressDialog).toBeHidden();
  await expect(listing(page).getByText("docs.zip", { exact: true })).toBeVisible({
    timeout: 20_000,
  });

  await createFolder(page, "extracted");

  await listing(page).getByText("docs.zip", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Extract to" }).click();

  const extractDialog = page.getByRole("dialog").filter({ hasText: "Extract to" });
  await expect(extractDialog).toBeVisible();
  await extractDialog.getByRole("button", { name: "extracted" }).click();
  await extractDialog.getByRole("button", { name: "Extract here" }).click();
  await expect(extractDialog).toBeHidden();

  // Navigate to the (already existing, currently empty) "extracted" folder
  // and wait for its "docs" subfolder to show up via the live SSE update
  // once the extract job finishes, rather than racing a fixed-time
  // navigation against the still-running job.
  await page.goto(`/files/${sandbox}/extracted`);
  await expect(listing(page).getByText("docs", { exact: true })).toBeVisible({ timeout: 20_000 });

  // Compressing a folder nests its contents under its own name inside the
  // archive ("docs/note.txt"), and the default extraction destination is
  // itself a folder named after the archive ("docs"), so unpacking
  // "docs.zip" this way lands the original folder one level further down:
  // "extracted/docs/docs/note.txt".
  await listing(page).getByText("docs", { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}/extracted/docs$`));
  await listing(page).getByText("docs", { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}/extracted/docs/docs$`));
  await expect(listing(page).getByText("note.txt", { exact: true })).toBeVisible();
});
