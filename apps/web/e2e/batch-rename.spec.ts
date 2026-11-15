import { expect, test } from "@playwright/test";
import { listing } from "./support/regions.js";
import { openSandbox, removeSandbox } from "./support/sandbox.js";
import { uploadFiles } from "./support/upload.js";

const PRIMARY_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

test("F2 on several selected files renames them all from one dialog", async ({ page }) => {
  const sandbox = await openSandbox(page, "batch-rename");
  await uploadFiles(page, [
    { name: "a.txt", mimeType: "text/plain", contents: "a" },
    { name: "b.txt", mimeType: "text/plain", contents: "b" },
  ]);
  await expect(listing(page).getByText("b.txt", { exact: true })).toBeVisible();

  await listing(page).getByText("a.txt", { exact: true }).click();
  await page.keyboard.press(`${PRIMARY_MODIFIER}+a`);
  await page.keyboard.press("F2");

  const dialog = page.getByRole("dialog", { name: "Rename 2 items" });
  const rename = dialog.getByRole("button", { name: "Rename" });
  await dialog.getByLabel("Find", { exact: true }).fill("a");
  await dialog.getByLabel("Replace with").fill("b");
  await expect(dialog.getByText("Some new names are already taken.")).toBeVisible();
  await expect(rename).toBeDisabled();

  await dialog.getByRole("tab", { name: "Number" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Note");
  await expect(dialog.getByRole("listitem")).toHaveText(["a.txtNote 1.txt", "b.txtNote 2.txt"]);
  await rename.click();
  await expect(dialog).toBeHidden();

  await expect(listing(page).getByText("Note 1.txt", { exact: true })).toBeVisible();
  await expect(listing(page).getByText("Note 2.txt", { exact: true })).toBeVisible();
  await expect(listing(page).getByText("a.txt", { exact: true })).toBeHidden();

  await removeSandbox(page, sandbox);
});
