import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { SEED_FILES, SEED_USERS } from "@fdrive/testkit";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type RunningEnvironment, startEnvironment } from "./support/environment.js";
import { E2E_HOST } from "./support/paths.js";
import { getFreePort } from "./support/ports.js";
import { listing } from "./support/regions.js";
import { uniqueName } from "./support/unique.js";
import { uploadFiles } from "./support/upload.js";

// An isolated, fresh installation, whose Trash is on from the start; it may
// change how long Trash keeps items without touching the shared one. One
// sequential scenario avoids starting additional Docker stacks per worker.

function trashRow(page: Page, name: string): Locator {
  return page.locator("table tbody tr").filter({ hasText: name });
}

/** The Trash section on System > General. */
function trashSettings(page: Page): Locator {
  return page
    .locator('[data-slot="setting-row"]')
    .filter({ has: page.getByLabel("Days in Trash") });
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
  // Trash needs no step: it is always on.
  await expect(page.getByLabel("Server address")).not.toHaveValue("");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.getByRole("button", { name: "Skip ONLYOFFICE" }).click();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await page.waitForURL("**/files");
  await page.getByRole("button", { name: "New" }).waitFor();
}

async function moveToTrash(page: Page, name: string, days = 30): Promise<void> {
  await listing(page).getByText(name, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  const confirmDialog = page.getByRole("alertdialog");
  await expect(confirmDialog).toContainText("Move to Trash?");
  await expect(confirmDialog).toContainText(
    `Items in Trash are deleted permanently after ${days} days.`,
  );
  await confirmDialog.getByRole("button", { name: "Move to Trash" }).click();
  await expect(confirmDialog).toBeHidden();
}

/**
 * Moves `name` to Trash while holding back the delete request, so the confirm
 * dialog's busy state is observable: the confirm button shows progressive
 * copy and is disabled, Cancel is disabled, and Escape does not dismiss the
 * dialog until the request completes.
 */
async function moveToTrashSlowly(page: Page, name: string): Promise<void> {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/fs/delete", async (route) => {
    await held;
    await route.continue();
  });
  await listing(page).getByText(name, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  const confirmDialog = page.getByRole("alertdialog");
  await confirmDialog.getByRole("button", { name: "Move to Trash" }).click();
  const busy = confirmDialog.getByRole("button", { name: "Moving to Trash…" });
  await expect(busy).toBeVisible();
  await expect(busy).toBeDisabled();
  await expect(confirmDialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(busy).toBeVisible();
  release();
  await expect(confirmDialog).toBeHidden();
  await page.unroute("**/api/v1/fs/delete");
}

/**
 * Holds back every request matching `pattern` until the returned function is
 * called, so a busy state that would otherwise flash by is observable. The
 * returned function lets the held requests through, waits for them to be
 * continued, and then removes the route.
 */
async function holdRequests(page: Page, pattern: string): Promise<() => Promise<void>> {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const continued: Promise<void>[] = [];
  await page.route(pattern, (route) => {
    continued.push(held.then(() => route.continue()));
  });
  return async () => {
    release();
    await Promise.all(continued);
    await page.unroute(pattern);
  };
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
      storage: { users: SEED_USERS, files: SEED_FILES },
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

    // Every login has Trash, from the first sign-in.
    await expect(
      page.locator('[data-slot="sidebar"]').getByRole("link", { name: "Trash", exact: true }),
    ).toBeVisible();

    const fileName = `${uniqueName("trash-me")}.txt`;
    await uploadFiles(page, [{ name: fileName, mimeType: "text/plain", contents: "trash me" }]);
    await expect(listing(page).getByText(fileName, { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    await moveToTrash(page, fileName);
    await expect(listing(page).getByText(fileName, { exact: true })).toBeHidden();
    // The toast's Undo restores it at once; then it goes to Trash again.
    await page.locator("[data-sonner-toast]").getByRole("button", { name: "Undo" }).click();
    await expect(listing(page).getByText(fileName, { exact: true })).toBeVisible();
    await moveToTrash(page, fileName);
    await expect(listing(page).getByText(fileName, { exact: true })).toBeHidden();
    // fdrive moved it into the home's own Trash folder, which the listing hides.
    await expect(listing(page).getByText(".trash", { exact: true })).toHaveCount(0);
    const home = join(environment?.storageRoot ?? "", "alice");
    expect(await readdir(home)).not.toContain(fileName);
    expect(await readdir(home)).toContain(".trash");

    // It appears on /trash with its original folder, which says when Trash deletes it.
    await page.goto(`${webBaseUrl}/trash`);
    await expect(page.getByRole("heading", { name: "Trash", exact: true })).toBeVisible();
    await expect(
      page.getByText("Items in Trash are deleted permanently after 30 days.", { exact: false }),
    ).toBeVisible();
    const row = trashRow(page, fileName);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("Home");
    // The page reads like the file list: a bar summing up what Trash holds over a table of
    // rows, and no header search, which would look through files rather than Trash.
    await expect(page.getByText("1 item", { exact: true })).toBeVisible();
    for (const column of ["Name", "Original folder", "Size", "Deleted"]) {
      await expect(page.getByRole("columnheader", { name: column, exact: true })).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Search", exact: true })).toHaveCount(0);

    // Choosing the row opens the item's sheet beside the list: where it was, when it was
    // deleted and how long Trash keeps it. That does not check the row for the bar's actions.
    await row.getByText(fileName, { exact: true }).click();
    const details = page.getByRole("region", { name: fileName, exact: true });
    await expect(details.getByText(`/${fileName}`, { exact: true })).toBeVisible();
    await expect(
      details.getByText("Restoring puts it back in Home.", { exact: true }),
    ).toBeVisible();
    for (const fact of ["Original location", "Deleted", "Size", "Kept until"]) {
      await expect(details.getByText(fact, { exact: true })).toBeVisible();
    }
    await expect(details.getByRole("button", { name: "Restore", exact: true })).toBeEnabled();
    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(row.getByRole("checkbox", { name: `Select ${fileName}` })).not.toBeChecked();
    await expect(page.getByText("1 item", { exact: true })).toBeVisible();
    // Escape closes the sheet and returns to the row.
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
    await expect(row).toBeFocused();

    // Restore returns it to the listing. The request is held back once so the
    // toolbar's busy state is observable: Restore shows progressive copy and
    // both restore buttons are disabled until it completes.
    await row.getByRole("checkbox", { name: `Select ${fileName}` }).check();
    await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
    const releaseRestore = await holdRequests(page, "**/api/v1/trash/restore");
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    const restoring = page.getByRole("button", { name: "Restoring…" });
    await expect(restoring).toBeVisible();
    await expect(restoring).toBeDisabled();
    await expect(page.getByRole("button", { name: "Restore to", exact: true })).toBeDisabled();
    await releaseRestore();
    await expect(page.getByText("Restored 1 item.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
    await expect(row).toBeHidden();

    await page.goto(`${webBaseUrl}/files`);
    await expect(listing(page).getByText(fileName, { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // Move it to Trash again, this time watching the dialog's busy state while
    // the request is held back, then recreate a file at its original path so
    // restoring the trashed copy conflicts.
    await moveToTrashSlowly(page, fileName);
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

    // An item's sheet restores it with its one primary action, and deletes it permanently
    // from its footer after asking.
    const sheetFileName = `${uniqueName("from-sheet")}.txt`;
    await page.goto(`${webBaseUrl}/files`);
    await uploadFiles(page, [{ name: sheetFileName, mimeType: "text/plain", contents: "sheet" }]);
    await expect(listing(page).getByText(sheetFileName, { exact: true })).toBeVisible();
    await moveToTrash(page, sheetFileName);
    await page.goto(`${webBaseUrl}/trash`);
    const sheetRow = trashRow(page, sheetFileName);
    await sheetRow.getByText(sheetFileName, { exact: true }).click();
    const sheet = page.getByRole("region", { name: sheetFileName, exact: true });
    await sheet.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByText("Restored 1 item.")).toBeVisible();
    await expect(sheet).toBeHidden();
    await expect(sheetRow).toBeHidden();
    await page.goto(`${webBaseUrl}/files`);
    await expect(listing(page).getByText(sheetFileName, { exact: true })).toBeVisible();
    await moveToTrash(page, sheetFileName);
    await page.goto(`${webBaseUrl}/trash`);
    await sheetRow.getByText(sheetFileName, { exact: true }).click();
    await sheet.getByRole("button", { name: "Delete permanently", exact: true }).click();
    const purge = page.getByRole("alertdialog");
    await expect(purge).toContainText("1 item will be permanently deleted.");
    await purge.getByRole("button", { name: "Delete permanently" }).click();
    await expect(page.getByText("Deleted 1 item permanently.")).toBeVisible();
    await expect(sheet).toBeHidden();
    await expect(sheetRow).toBeHidden();

    // Restore to can create a destination without leaving the Trash flow.
    const restoreFileName = `${uniqueName("restore-to")}.txt`;
    const restoreFolderName = uniqueName("restored");
    await page.goto(`${webBaseUrl}/files`);
    await uploadFiles(page, [
      { name: restoreFileName, mimeType: "text/plain", contents: "restore me" },
    ]);
    await expect(listing(page).getByText(restoreFileName, { exact: true })).toBeVisible();
    await moveToTrash(page, restoreFileName);
    await page.goto(`${webBaseUrl}/trash`);
    const restoreRow = trashRow(page, restoreFileName);
    await restoreRow.getByRole("checkbox", { name: `Select ${restoreFileName}` }).check();
    await page.getByRole("button", { name: "Restore to", exact: true }).click();
    const destination = page.getByRole("dialog", { name: "Restore to", exact: true });
    await destination.getByRole("button", { name: "New folder" }).click();
    const folderDialog = page.getByRole("dialog", { name: "New folder", exact: true });
    await folderDialog.getByLabel("Folder name").fill(restoreFolderName);
    await folderDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(folderDialog).toBeHidden();
    // The picker stays open with a busy confirm button, ignoring Escape, until
    // the held-back restore completes.
    const releaseRestoreTo = await holdRequests(page, "**/api/v1/trash/restore");
    await destination.getByRole("button", { name: "Restore here" }).click();
    const restoringHere = destination.getByRole("button", { name: "Restoring…" });
    await expect(restoringHere).toBeVisible();
    await expect(restoringHere).toBeDisabled();
    await expect(destination.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(restoringHere).toBeVisible();
    await releaseRestoreTo();
    await expect(destination).toBeHidden();
    await expect(restoreRow).toBeHidden();
    await page.goto(`${webBaseUrl}/files/${restoreFolderName}`);
    await expect(listing(page).getByText(restoreFileName, { exact: true })).toBeVisible();

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

    // How long Trash keeps items is the one setting, on System > General, and
    // applies at once; there is no way to turn Trash off or move it.
    await page.goto(`${webBaseUrl}/system/general`);
    const localTrash = trashSettings(page);
    await expect(localTrash.getByLabel("Days in Trash")).toHaveValue("30");
    await expect(page.getByRole("switch", { name: "Enable Trash" })).toHaveCount(0);
    await expect(page.getByLabel("Trash folder")).toHaveCount(0);
    await localTrash.getByLabel("Days in Trash").fill("7");
    await localTrash.getByRole("button", { name: "Save Trash settings" }).click();
    await expect(localTrash.getByRole("button", { name: "Save Trash settings" })).toBeDisabled();
    await page.reload();
    await expect(trashSettings(page).getByLabel("Days in Trash")).toHaveValue("7");
    await page.goto(`${webBaseUrl}/trash`);
    await expect(
      page.getByText("Items in Trash are deleted permanently after 7 days.", { exact: false }),
    ).toBeVisible();
    const lastFileName = `${uniqueName("week")}.txt`;
    await page.goto(`${webBaseUrl}/files`);
    await uploadFiles(page, [{ name: lastFileName, mimeType: "text/plain", contents: "week" }]);
    await expect(listing(page).getByText(lastFileName, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await moveToTrash(page, lastFileName, 7);
    await expect(
      page.locator('[data-slot="sidebar"]').getByRole("link", { name: "Trash", exact: true }),
    ).toBeVisible();
  });
});

test("every login has Trash, and the delete dialog says when it deletes items", async ({
  page,
}) => {
  // A private folder: the shared root gathers one folder per test across
  // the suite, and the virtualized listing never renders a file sorted past
  // its window, so a root upload could not be found there.
  const sandbox = `/${uniqueName("always-trash")}`;
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
    page.locator('[data-slot="sidebar"]').getByRole("link", { name: "Trash", exact: true }),
  ).toBeVisible();

  const fileName = `${uniqueName("always-trash")}.txt`;
  await uploadFiles(page, [{ name: fileName, mimeType: "text/plain", contents: "to Trash" }]);
  await expect(listing(page).getByText(fileName, { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  await listing(page).getByText(fileName, { exact: true }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Move to Trash" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await moveToTrash(page, fileName);
  await expect(listing(page).getByText(fileName, { exact: true })).toBeHidden();
});
