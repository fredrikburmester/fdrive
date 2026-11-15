import { expect, test } from "@playwright/test";
import { dismissActivityPanel } from "./support/activity.js";
import { loginAs } from "./support/login.js";
import { uniqueName } from "./support/unique.js";
import { uploadFiles } from "./support/upload.js";

test("alice opens Storage from her account menu, sees her folder by kind and reveals a large file", async ({
  page,
}) => {
  await page.goto("/files");
  await page.getByRole("button", { name: "alice" }).click();
  await page.getByRole("menuitem", { name: "Storage" }).click();
  await expect(page).toHaveURL(/\/storage$/);

  // Her seeded files are in the index: documents and one picture.
  await expect(page.getByText(/^[\d.,]+ (B|KB) used$/)).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Storage used" })).toHaveCount(0);
  for (const kind of ["Images", "Videos", "Documents", "Audio", "Other"]) {
    await expect(page.getByText(kind, { exact: true })).toBeVisible();
  }
  await expect(page.getByText(/Counted from the search index/)).toBeVisible();

  // Earlier specs' finished jobs can cover the list's reveal buttons.
  await dismissActivityPanel(page);
  await page.getByRole("button", { name: "Reveal readme.md in folder" }).click();
  await expect(page).toHaveURL(/\/files\/docs\?select=readme\.md$/);
});

test("a user finds two identical files under Duplicates and moves one to Trash", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    ...(baseURL === undefined ? {} : { baseURL }),
  });
  const page = await context.newPage();
  try {
    await loginAs(page, "storage_dupes", "storage-dupes-test-password");
    await page.goto("/storage");
    const duplicates = page
      .locator('[data-slot="card"]')
      .filter({ has: page.getByText("Duplicates", { exact: true }) });
    await expect(duplicates.getByText(/^2 copies, 22 B wasted$/)).toBeVisible();
    await expect(duplicates.getByRole("listitem")).toHaveCount(2);
    await expect(duplicates.getByText("notes.txt")).toHaveCount(0);

    await duplicates
      .getByRole("listitem")
      .filter({ hasText: "/Backup" })
      .getByRole("button", { name: "Move beach.txt to Trash" })
      .click();
    const confirm = page.getByRole("alertdialog");
    await confirm.getByRole("button", { name: "Move to Trash" }).click();
    await expect(confirm).toBeHidden();
    // One copy left: nothing is duplicated any more.
    await expect(duplicates.getByText("No identical files in your folder.")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("an administrator sets a storage limit, and an upload over it is refused", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  const username = uniqueName("limited");
  const password = "limited-password-1";
  const created = await page.request.post("/api/v1/admin/users", {
    data: { username, password },
    headers: { "x-requested-with": "fdrive" },
  });
  expect(created.status()).toBe(201);

  await page.goto("/system/users");
  const row = page.getByRole("row").filter({ has: page.getByText(username, { exact: true }) });
  // Once the list is in, so the Activity panel is there to close before it covers the row.
  await expect(row).toBeVisible();
  await dismissActivityPanel(page);
  // The person's own signed-out browser, on the same web app.
  const person = await (
    await browser.newContext({
      storageState: { cookies: [], origins: [] },
      baseURL: new URL(page.url()).origin,
    })
  ).newPage();
  try {
    // About 1 KB, as GB counts it.
    await row.getByRole("button", { name: `Actions for ${username}` }).click();
    await page.getByRole("menuitem", { name: "Storage limit", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `Storage limit for ${username}` });
    await dialog.getByLabel("Limit in GB").fill("0.000001");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(`Set the storage limit of ${username}.`)).toBeVisible();
    await expect(row.getByText(/of 1\.0 KB$/)).toBeVisible();

    await loginAs(person, username, password);
    await uploadFiles(person, [{ name: "small.txt", mimeType: "text/plain", contents: "fits" }]);
    await expect(person.getByText("small.txt", { exact: true }).first()).toBeVisible();
    await uploadFiles(person, [
      { name: "large.txt", mimeType: "text/plain", contents: "x".repeat(4096) },
    ]);
    // The dock says one failed; opening it says why.
    await person.getByRole("button", { name: "1 uploaded, 1 failed" }).click();
    await expect(person.getByText("Storage limit reached").first()).toBeVisible();

    await person.goto("/storage");
    await expect(person.getByText(/^0 B of 1\.0 KB used$/)).toBeVisible();
    await expect(person.getByRole("progressbar", { name: "Storage used" })).toBeVisible();
  } finally {
    await person.context().close();
    await page.request.delete(`/api/v1/admin/users/${username}`, {
      headers: { "x-requested-with": "fdrive" },
    });
  }
});
