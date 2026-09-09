import { SEED_FILES, SEED_USERS } from "@fdrive/testkit";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type RunningEnvironment, startEnvironment } from "./support/environment.js";
import { E2E_HOST } from "./support/paths.js";
import { getFreePort } from "./support/ports.js";
import { listing } from "./support/regions.js";
import { uniqueName } from "./support/unique.js";
import { uploadFiles } from "./support/upload.js";

// Isolated SFTPGo fixture with recycle rules. Enable fdrive Trash through onboarding.
// One sequential scenario avoids starting additional Docker stacks per worker.
const TRASH_PATH = "/.trash";

function trashRow(page: Page, name: string): Locator {
  return page.locator("table tbody tr").filter({ hasText: name });
}

async function loginAsAlice(page: Page, webBaseUrl: string): Promise<void> {
  await page.goto(`${webBaseUrl}/login`);
  await page.getByLabel("Username").fill("alice");
  await page.getByLabel("Password").fill("alice-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/setup");
  for (const label of [
    "Enable thumbnails",
    "Enable full-text search",
    "Enable search ocr",
    "Enable semantic search",
    "Enable image search",
    "Enable searchable pdfs",
  ]) {
    await expect(page.getByRole("switch", { name: label })).toBeVisible();
    await page.getByRole("button", { name: "Skip this feature" }).click();
  }
  await page.getByRole("switch", { name: "Enable Trash" }).click();
  await expect(page.getByRole("button", { name: "Save and continue" })).toBeDisabled();
  await page.getByRole("checkbox", { name: /I configured and tested/ }).check();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByLabel("fdrive public address")).not.toHaveValue("");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.getByRole("button", { name: "Skip ONLYOFFICE" }).click();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await page.waitForURL("**/files");
  await page.getByRole("button", { name: "New" }).waitFor();
}

async function moveToTrash(page: Page, name: string): Promise<void> {
  await listing(page).getByText(name, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  const confirmDialog = page.getByRole("alertdialog");
  await expect(confirmDialog).toContainText("Move to Trash?");
  await confirmDialog.getByRole("button", { name: "Move to Trash" }).click();
  await expect(confirmDialog).toBeHidden();
}

test.describe("trash available", () => {
  test.describe.configure({ timeout: 300_000 });
  test.use({ storageState: { cookies: [], origins: [] } });

  let environment: RunningEnvironment | undefined;
  let webBaseUrl = "";

  test.beforeAll(async () => {
    // `describe.configure({ timeout })` covers tests, not this hook, which
    // boots a second Docker stack and overran the default 30s on CI runners.
    test.setTimeout(300_000);
    const apiPort = await getFreePort(E2E_HOST);
    const webPort = await getFreePort(E2E_HOST);
    environment = await startEnvironment({
      apiPort,
      webPort,
      skipStatePersist: true,
      sftpgoOptions: { users: SEED_USERS, files: SEED_FILES, trash: { path: TRASH_PATH } },
    });
    webBaseUrl = environment.webBaseUrl;
  });

  test.afterAll(async () => {
    await environment?.stop();
  });

  test("delete moves a file to Trash; restore, a restore conflict, permanent delete, and Empty Trash all work", async ({
    page,
  }) => {
    await loginAsAlice(page, webBaseUrl);

    // The sidebar shows Trash once the identity's storage exposes one.
    await expect(
      page.locator('[data-slot="sidebar"]').getByRole("link", { name: "Trash" }),
    ).toBeVisible();

    const fileName = `${uniqueName("trash-me")}.txt`;
    await uploadFiles(page, [{ name: fileName, mimeType: "text/plain", contents: "trash me" }]);
    await expect(listing(page).getByText(fileName, { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    await moveToTrash(page, fileName);
    await expect(listing(page).getByText(fileName, { exact: true })).toBeHidden();

    // It appears on /trash with its original folder.
    await page.goto(`${webBaseUrl}/trash`);
    const row = trashRow(page, fileName);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("Home");

    // Restore returns it to the listing.
    await row.getByRole("checkbox", { name: `Select ${fileName}` }).check();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByText("Restored 1 item.")).toBeVisible();
    await expect(row).toBeHidden();

    await page.goto(`${webBaseUrl}/files`);
    await expect(listing(page).getByText(fileName, { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // Move it to Trash again, then recreate a file at its original path so
    // restoring the trashed copy conflicts.
    await moveToTrash(page, fileName);
    await uploadFiles(page, [{ name: fileName, mimeType: "text/plain", contents: "conflict" }]);
    await expect(listing(page).getByText(fileName, { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    await page.goto(`${webBaseUrl}/trash`);
    const conflictRow = trashRow(page, fileName);
    await expect(conflictRow).toBeVisible({ timeout: 15_000 });
    await conflictRow.getByRole("checkbox", { name: `Select ${fileName}` }).check();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByText(new RegExp(`Could not restore "${fileName}"`))).toBeVisible();
    // Scope to the toast: the toolbar has its own "Restore to" button.
    await expect(
      page.locator("[data-sonner-toast]").getByRole("button", { name: "Restore to" }),
    ).toBeVisible();
    // The conflicting restore never removed the trash entry.
    await expect(conflictRow).toBeVisible();

    // Delete permanently removes it from the trash listing.
    await page.getByRole("button", { name: "Delete permanently" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete permanently" }).click();
    await expect(conflictRow).toBeHidden();

    // Empty Trash clears whatever remains.
    const secondFileName = `${uniqueName("empty-me")}.txt`;
    await page.goto(`${webBaseUrl}/files`);
    await uploadFiles(page, [
      { name: secondFileName, mimeType: "text/plain", contents: "empty me" },
    ]);
    await expect(listing(page).getByText(secondFileName, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await moveToTrash(page, secondFileName);

    await page.goto(`${webBaseUrl}/trash`);
    const secondRow = trashRow(page, secondFileName);
    await expect(secondRow).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Empty Trash" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Empty Trash" }).click();
    await expect(page.getByText(/Trash emptied\./)).toBeVisible();
    await expect(secondRow).toBeHidden();

    // Settings apply live: disabling removes Trash without restarting the API.
    await page.goto(`${webBaseUrl}/system/general`);
    await page.getByRole("switch", { name: "Enable Trash" }).click();
    await page.getByRole("button", { name: "Save Trash settings" }).click();
    await expect(
      page.locator('[data-slot="sidebar"]').getByRole("link", { name: "Trash" }),
    ).toBeHidden();
    await page.reload();
    await expect(page.getByRole("switch", { name: "Enable Trash" })).not.toBeChecked();
  });
});

test.describe("trash not configured", () => {
  test("no Trash sidebar item, and the permanent-delete dialog copy", async ({ page }) => {
    // A private folder: the shared root gathers one folder per test across
    // the suite, and the virtualized listing never renders a file sorted past
    // its window, so a root upload could not be found there.
    const sandbox = `/${uniqueName("no-trash")}`;
    expect(
      (
        await page.request.post("/api/v1/fs/mkdir", {
          headers: { "x-requested-with": "fdrive" },
          data: { path: sandbox },
        })
      ).ok(),
    ).toBe(true);
    await page.goto(`/files${sandbox}`);

    await expect(
      page.locator('[data-slot="sidebar"]').getByRole("link", { name: "Trash" }),
    ).toBeHidden();

    const fileName = `${uniqueName("no-trash")}.txt`;
    await uploadFiles(page, [
      { name: fileName, mimeType: "text/plain", contents: "no trash here" },
    ]);
    await expect(listing(page).getByText(fileName, { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    await listing(page).getByText(fileName, { exact: true }).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Delete" }).click();

    const confirmDialog = page.getByRole("alertdialog");
    await expect(confirmDialog).toContainText("permanently deleted");
    await confirmDialog.getByRole("button", { name: "Delete" }).click();
    await expect(confirmDialog).toBeHidden();
    await expect(listing(page).getByText(fileName, { exact: true })).toBeHidden();
  });
});
