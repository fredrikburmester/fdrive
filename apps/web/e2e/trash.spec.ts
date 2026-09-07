import { SEED_FILES, SEED_USERS } from "@fdrive/testkit";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type RunningEnvironment, startEnvironment } from "./support/environment.js";
import { E2E_HOST } from "./support/paths.js";
import { getFreePort } from "./support/ports.js";
import { listing } from "./support/regions.js";
import { uniqueName } from "./support/unique.js";
import { uploadFiles } from "./support/upload.js";

/**
 * `trash.spec.ts` needs an API process with `FDRIVE_SFTPGO_TRASH_PATH` set
 * and an SFTPGo container seeded with the recycle-folder Event Manager
 * rule, unlike every other e2e spec, which shares the one plain environment
 * `global-setup.ts` starts for the whole run (see `support/environment.ts`).
 * Rather than make trash the default for that shared environment (which
 * would silently change the delete dialog's copy and the context menu's
 * last item for every other spec), this file starts its own, independent
 * second environment in `test.beforeAll`, on its own free ports, and talks
 * to it with absolute URLs (`page.goto(`${webBaseUrl}/...`)`) instead of
 * relying on Playwright's configured `baseURL`. `skipStatePersist: true`
 * keeps it from overwriting the shared environment's own teardown state.
 *
 * The one test below intentionally stays a single, sequential scenario:
 * Playwright's `beforeAll` runs once per *worker process* a describe
 * block's tests land on, so splitting this into several `test()`s risks
 * two workers each booting a whole extra Postgres, SFTPGo, API, and
 * production Next.js build. A single test keeps that cost to exactly one
 * extra environment for the whole run.
 *
 * This spec can only pass once the `trash-api` chunk (API config, storage
 * factory, trash routes, fs delete/list changes) is merged; until then
 * `/api/v1/trash/status` and friends 404 and every assertion below fails
 * predictably at "appears on the Trash page" or earlier.
 */
const TRASH_PATH = "/.trash";

function trashRow(page: Page, name: string): Locator {
  return page.locator("table tbody tr").filter({ hasText: name });
}

async function loginAsAlice(page: Page, webBaseUrl: string): Promise<void> {
  await page.goto(`${webBaseUrl}/login`);
  await page.getByLabel("Username").fill("alice");
  await page.getByLabel("Password").fill("alice-password");
  await page.getByRole("button", { name: "Sign in" }).click();
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
    const apiPort = await getFreePort(E2E_HOST);
    const webPort = await getFreePort(E2E_HOST);
    environment = await startEnvironment({
      apiPort,
      webPort,
      skipStatePersist: true,
      sftpgoOptions: { users: SEED_USERS, files: SEED_FILES, trash: { path: TRASH_PATH } },
      extraApiEnv: { FDRIVE_SFTPGO_TRASH_PATH: TRASH_PATH },
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
    // Scope to the toast: the toolbar has its own "Restore to…" button.
    await expect(
      page.locator("[data-sonner-toast]").getByRole("button", { name: "Restore to…" }),
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
  });
});

test.describe("trash not configured", () => {
  test("no Trash sidebar item, and the permanent-delete dialog copy", async ({ page }) => {
    await page.goto("/files");

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
