import { expect, type Page, test } from "@playwright/test";
import { breadcrumb, listing } from "./support/regions.js";
import { openSandbox } from "./support/sandbox.js";
import { uploadFiles } from "./support/upload.js";

const PRIMARY_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

async function createFolder(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Folder name").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
}

/** Opens `name` by double-click, a client-side navigation that keeps fdrive's clipboard. */
async function openFolder(page: Page, sandbox: string, name: string): Promise<void> {
  await listing(page).getByText(name, { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}/${name}$`));
}

test("copy and cut paste into another folder, and Undo moves the cut file back", async ({
  page,
}) => {
  const sandbox = await openSandbox(page, "clipboard");
  await createFolder(page, "target");
  await uploadFiles(page, [
    { name: "copied.txt", mimeType: "text/plain", contents: "copy me" },
    { name: "cut.txt", mimeType: "text/plain", contents: "cut me" },
  ]);
  await expect(listing(page).getByText("cut.txt", { exact: true })).toBeVisible();

  await listing(page).getByText("copied.txt", { exact: true }).click();
  await page.keyboard.press(`${PRIMARY_MODIFIER}+c`);
  await openFolder(page, sandbox, "target");
  await expect(page.getByText("This folder is empty")).toBeVisible();
  await page.keyboard.press(`${PRIMARY_MODIFIER}+v`);
  await expect(listing(page).getByText("copied.txt", { exact: true })).toBeVisible();

  await breadcrumb(page).getByRole("link", { name: sandbox }).click();
  await listing(page).getByText("cut.txt", { exact: true }).click();
  await page.keyboard.press(`${PRIMARY_MODIFIER}+x`);
  await openFolder(page, sandbox, "target");
  await expect(listing(page).getByText("copied.txt", { exact: true })).toBeVisible();
  await page.keyboard.press(`${PRIMARY_MODIFIER}+v`);
  await expect(listing(page).getByText("cut.txt", { exact: true })).toBeVisible();

  await page.locator("[data-sonner-toast]").getByRole("button", { name: "Undo" }).click();
  await expect(listing(page).getByText("cut.txt", { exact: true })).toBeHidden();
  await page.goto(`/files/${sandbox}`);
  await expect(listing(page).getByText("cut.txt", { exact: true })).toBeVisible();
  await expect(listing(page).getByText("copied.txt", { exact: true })).toBeVisible();
});

test("the undo shortcut renames a file back", async ({ page }) => {
  await openSandbox(page, "undo-rename");
  await uploadFiles(page, [{ name: "before.txt", mimeType: "text/plain", contents: "name me" }]);
  await listing(page).getByText("before.txt", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Rename", exact: true });
  await dialog.getByLabel("New name").fill("after.txt");
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.getByText('Renamed to "after.txt"')).toBeVisible();

  await listing(page).getByText("after.txt", { exact: true }).click();
  await page.keyboard.press(`${PRIMARY_MODIFIER}+z`);
  await expect(listing(page).getByText("before.txt", { exact: true })).toBeVisible();
  await expect(listing(page).getByText("after.txt", { exact: true })).toBeHidden();
});

test("pasting a file from the system clipboard uploads it into the folder", async ({ page }) => {
  await openSandbox(page, "paste-upload");
  await expect(page.getByText("This folder is empty")).toBeVisible();
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(["pixels"], "image.png", { type: "image/png" }));
    document.body.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true }),
    );
  });
  await expect(listing(page).getByText("image.png", { exact: true })).toBeVisible();
});

test("dragging a file out of the browser carries a download URL for it", async ({ page }) => {
  await openSandbox(page, "drag-out");
  await uploadFiles(page, [{ name: "out.txt", mimeType: "text/plain", contents: "dragged out" }]);
  const name = listing(page).getByText("out.txt", { exact: true });
  await expect(name).toBeVisible();

  const downloadUrl = await name.evaluate((element) => {
    const source = element.closest('[draggable="true"]');
    const data = new DataTransfer();
    source?.dispatchEvent(new DragEvent("dragstart", { dataTransfer: data, bubbles: true }));
    source?.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
    return data.getData("DownloadURL");
  });
  const [, fileName, ...url] = downloadUrl.split(":");
  expect(fileName).toBe("out.txt");
  const response = await page.request.get(url.join(":"));
  expect(await response.text()).toBe("dragged out");
});
