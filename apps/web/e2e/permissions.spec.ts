import { expect, test } from "@playwright/test";
import { loginAs } from "./support/login.js";
import { uniqueName } from "./support/unique.js";

// bob has different permissions than alice (list/download at root, but
// upload/create_dirs only inside /inbox), so this spec logs in as bob
// itself rather than reusing the alice storage state the "chromium"
// project otherwise applies by default.
test.use({ storageState: { cookies: [], origins: [] } });

test("bob cannot create a folder at root, but can inside /inbox", async ({ page }) => {
  await loginAs(page, "bob", "bob-password");
  await expect(page).toHaveURL(/\/files$/);

  const rootAttemptName = uniqueName("bob-root-folder");
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  const rootDialog = page.getByRole("dialog");
  await rootDialog.getByLabel("Folder name").fill(rootAttemptName);
  await rootDialog.getByRole("button", { name: "Create" }).click();

  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toBeVisible();
  // The mutation failed, so the dialog never closes and the folder never
  // shows up in the listing.
  await expect(rootDialog).toBeVisible();
  await expect(page.getByText(rootAttemptName, { exact: true })).toBeHidden();
  await rootDialog.getByRole("button", { name: "Cancel" }).click();

  await page.goto("/files/inbox");
  const inboxFolderName = uniqueName("bob-inbox-folder");
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  const inboxDialog = page.getByRole("dialog");
  await inboxDialog.getByLabel("Folder name").fill(inboxFolderName);
  await inboxDialog.getByRole("button", { name: "Create" }).click();
  await expect(inboxDialog).toBeHidden();

  await expect(page.getByText(inboxFolderName, { exact: true })).toBeVisible();
});
