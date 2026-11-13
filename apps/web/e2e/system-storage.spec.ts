import { expect, type Page, test } from "@playwright/test";
import { dismissActivityPanel } from "./support/activity.js";

/** The files folder's card on System > General. */
function storageCard(page: Page) {
  return page
    .getByRole("main")
    .locator('[data-slot="card"]')
    .filter({ hasText: "Folder on this server, set by FDRIVE_STORAGE_ROOT." });
}

test("alice (admin) finds the files folder and its Trash on System > General, with nothing to add or remove", async ({
  page,
}) => {
  await page.goto("/system/general");
  await dismissActivityPanel(page);
  const card = storageCard(page);

  await expect(card.getByText("Storage", { exact: true })).toBeVisible();
  await expect(card.getByLabel("Name", { exact: true })).toBeVisible();
  // The e2e folder is reachable, so no reachability line competes for attention.
  await expect(card.getByText("Unreachable")).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Enable Trash" })).toBeVisible();
  for (const name of [/^Add provider/, /^Remove /, /^Test /, /^Edit /]) {
    await expect(page.getByRole("button", { name })).toHaveCount(0);
  }
  // Only the name changes: no type, no address.
  await expect(card.getByLabel("Address")).toHaveCount(0);
  await expect(card.getByLabel("Type")).toHaveCount(0);
});

test("alice (admin) renames the files folder on System > General and the name sticks", async ({
  page,
}) => {
  await page.goto("/system/general");
  await dismissActivityPanel(page);
  const card = storageCard(page);
  const name = card.getByLabel("Name", { exact: true });
  const save = card.getByRole("button", { name: "Save name" });
  await expect(name).not.toHaveValue("");
  const originalName = await name.inputValue();

  try {
    await name.fill("   ");
    await expect(card.getByText("Enter a name for this storage.")).toBeVisible();
    await expect(save).toBeDisabled();

    await name.fill("  Home server  ");
    // Dispatched: the Activity panel, fixed bottom-right, can reappear over
    // the card's bottom-right button after earlier specs left jobs in it.
    await save.dispatchEvent("click");
    await expect(name).toHaveValue("Home server");
    await expect(save).toBeDisabled();

    await page.reload();
    await expect(storageCard(page).getByLabel("Name", { exact: true })).toHaveValue("Home server");
    await page.goto("/account");
    await expect(page.getByRole("main").getByText("Home server", { exact: true })).toBeVisible();
  } finally {
    // Restore the original name so this test stays idempotent across
    // repeated local runs against the same environment.
    await page.goto("/system/general");
    await dismissActivityPanel(page);
    const restore = storageCard(page).getByLabel("Name", { exact: true });
    await expect(restore).not.toHaveValue("");
    if ((await restore.inputValue()) !== originalName) {
      await restore.fill(originalName);
      await storageCard(page).getByRole("button", { name: "Save name" }).dispatchEvent("click");
      await expect(restore).toHaveValue(originalName);
    }
  }
});
