import { expect, type Page, test } from "@playwright/test";
import { dismissActivityPanel } from "./support/activity.js";

/** The General sheet, which holds the files folder's rows among the installation's settings. */
function storageCard(page: Page) {
  return page.getByRole("region", { name: "General" });
}

test("alice (admin) finds the files folder and its Trash on System > General, with nothing to add or remove", async ({
  page,
}) => {
  await page.goto("/system/general");
  await dismissActivityPanel(page);
  const card = storageCard(page);

  await expect(card.getByText("Files folder", { exact: true })).toBeVisible();
  await expect(card.getByText("Folder on this server, set by FDRIVE_STORAGE_ROOT.")).toBeVisible();
  await expect(card.getByLabel("Storage name", { exact: true })).toBeVisible();
  // The e2e folder is healthy: it says so in a word, and no health line competes for attention.
  await expect(card.getByText("Healthy", { exact: true })).toBeVisible();
  await expect(card.getByText("Unavailable")).toHaveCount(0);
  await expect(card.getByRole("alert")).toHaveCount(0);
  // Trash is always on: its one setting is how long it keeps items.
  await expect(page.getByLabel("Days in Trash")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Enable Trash" })).toHaveCount(0);
  for (const name of [/^Add provider/, /^Remove /, /^Test /, /^Edit /]) {
    await expect(page.getByRole("button", { name })).toHaveCount(0);
  }
  // Only the name changes: no type, no address.
  await expect(card.getByLabel("Address", { exact: true })).toHaveCount(0);
  await expect(card.getByLabel("Type", { exact: true })).toHaveCount(0);
});

test("alice (admin) renames the files folder on System > General and the name sticks", async ({
  page,
}) => {
  await page.goto("/system/general");
  await dismissActivityPanel(page);
  const card = storageCard(page);
  const name = card.getByLabel("Storage name", { exact: true });
  const save = card.getByRole("button", { name: "Save name" });
  await expect(name).not.toHaveValue("");
  const originalName = await name.inputValue();

  try {
    await name.fill("   ");
    await expect(card.getByText("Enter a name for this storage.")).toBeVisible();
    await expect(save).toBeDisabled();

    await name.fill("  Home server  ");
    // Dispatched: the Activity panel, fixed bottom-right, can reappear over
    // a button of the sheet after earlier specs left jobs in it.
    await save.dispatchEvent("click");
    await expect(name).toHaveValue("Home server");
    await expect(save).toBeDisabled();

    await page.reload();
    await expect(storageCard(page).getByLabel("Storage name", { exact: true })).toHaveValue(
      "Home server",
    );
    // The sidebar names the signed-in login's storage beneath the username.
    await page.goto("/account");
    await expect(
      page.locator('[data-sidebar="footer"]').getByText("Home server", { exact: true }),
    ).toBeVisible();
  } finally {
    // Restore the original name so this test stays idempotent across
    // repeated local runs against the same environment.
    await page.goto("/system/general");
    await dismissActivityPanel(page);
    const restore = storageCard(page).getByLabel("Storage name", { exact: true });
    await expect(restore).not.toHaveValue("");
    if ((await restore.inputValue()) !== originalName) {
      await restore.fill(originalName);
      await storageCard(page).getByRole("button", { name: "Save name" }).dispatchEvent("click");
      await expect(restore).toHaveValue(originalName);
    }
  }
});
