import { expect, test } from "@playwright/test";
import { loginAs } from "./support/login.js";
import { READ_ONLY_GUEST, READ_ONLY_OWNER } from "./support/people-fixture.js";
import { listing } from "./support/regions.js";
import { uniqueName } from "./support/unique.js";

// handbook_reader has its own files and, from the seed, handbook_owner's
// Handbook shared to view only. It logs in as itself rather than reusing
// the alice storage state the "chromium" project otherwise applies.
test.use({ storageState: { cookies: [], origins: [] } });

test("a folder shared to view only refuses new files and folders, while the reader's own files take them", async ({
  page,
}) => {
  await loginAs(page, READ_ONLY_GUEST.username, READ_ONLY_GUEST.password);
  await expect(page).toHaveURL(/\/files$/);

  const reason = `${READ_ONLY_OWNER.username} shares this folder with you to view only.`;
  await page.goto("/files/Shared%20with%20me/Handbook");
  await expect(listing(page).getByText("policy.txt", { exact: true })).toBeVisible();
  // New and Upload are off here, with the reason as their tooltip.
  const create = page.getByRole("button", { name: "New" });
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute("title", reason);
  const upload = page.getByRole("button", { name: "Upload", exact: true });
  await expect(upload).toBeDisabled();
  await expect(upload).toHaveAttribute("title", reason);

  // The API refuses what the toolbar no longer offers.
  const refused = await page.request.post("/api/v1/fs/mkdir", {
    headers: { "x-requested-with": "fdrive" },
    data: { path: `/Shared with me/Handbook/${uniqueName("refused")}` },
  });
  expect(refused.ok()).toBe(false);
  expect(refused.status()).toBe(403);

  // The reader's own files take a new folder.
  await page.goto("/files");
  const ownFolderName = uniqueName("reader-folder");
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Folder name").fill(ownFolderName);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
  await expect(listing(page).getByText(ownFolderName, { exact: true })).toBeVisible();
});
