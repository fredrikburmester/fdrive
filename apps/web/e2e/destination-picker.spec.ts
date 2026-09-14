import { expect, type Page, test } from "@playwright/test";
import { listing } from "./support/regions.js";
import { uniqueName } from "./support/unique.js";
import { uploadFiles } from "./support/upload.js";

async function createFolder(page: Page, name: string) {
  const dialog = page.getByRole("dialog", { name: "New folder", exact: true });
  await dialog.getByLabel("Folder name").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function openPicker(page: Page, operation: "Move" | "Copy") {
  const sandbox = uniqueName("destination");
  await page.goto("/files");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  await createFolder(page, sandbox);
  await listing(page).getByText(sandbox, { exact: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${sandbox}$`));
  await uploadFiles(page, [
    { name: "note.txt", mimeType: "text/plain", contents: "keep these bytes" },
  ]);
  await listing(page).getByText("note.txt", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: `${operation} to`, exact: true }).click();
  const picker = page.getByRole("dialog", { name: `${operation} to`, exact: true });
  await expect(picker).toBeVisible();
  return { picker, sandbox };
}

for (const operation of ["Move", "Copy"] as const) {
  test(`${operation} into a folder created inside the destination picker`, async ({ page }) => {
    const { picker, sandbox } = await openPicker(page, operation);
    // Copy creates at root; Move proves nested creation and parent cache refresh.
    if (operation === "Copy")
      await picker.getByRole("button", { name: "Home", exact: true }).click();
    const destination = uniqueName("created-destination");
    await picker.getByRole("button", { name: "New folder" }).click();
    await createFolder(page, destination);
    await expect(picker.getByRole("link", { name: destination, exact: true })).toBeVisible();
    await expect(picker.getByRole("button", { name: "New folder" })).toBeFocused();
    const parent = operation === "Copy" ? "" : `/${sandbox}`;
    await picker
      .getByRole("button", { name: operation === "Copy" ? "Home" : sandbox, exact: true })
      .click();
    await expect(picker.getByRole("button", { name: destination, exact: true })).toBeVisible();
    await picker.getByRole("button", { name: destination, exact: true }).click();
    await picker.getByRole("button", { name: `${operation} here` }).click();
    await expect(picker).toBeHidden();
    if (operation === "Move")
      await expect(listing(page).getByText("note.txt", { exact: true })).toBeHidden();
    else await expect(listing(page).getByText("note.txt", { exact: true })).toBeVisible();
    await page.goto(`/files${parent}/${destination}`);
    await expect(listing(page).getByText("note.txt", { exact: true })).toBeVisible();
  });
}

test("folder creation keeps focus, supports cancellation, and preserves failed names for retry", async ({
  page,
}) => {
  const { picker, sandbox } = await openPicker(page, "Copy");
  const newFolder = picker.getByRole("button", { name: "New folder" });
  await newFolder.click();
  const dialog = page.getByRole("dialog", { name: "New folder", exact: true });
  const name = dialog.getByLabel("Folder name");
  await expect(name).toBeFocused();
  expect(
    await name.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]),
  ).toEqual([0, "Untitled folder".length]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(newFolder).toBeFocused();
  await expect(picker.getByRole("link", { name: sandbox, exact: true })).toBeVisible();

  await newFolder.click();
  await name.fill("../escape");
  await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  const attemptedName = uniqueName("retry");
  await name.fill(attemptedName);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/fs/mkdir", async (route) => {
    await held;
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "permission_denied", message: "Folder creation denied" },
      }),
    });
  });
  try {
    await name.press("Enter");
    await expect(dialog.getByRole("button", { name: "Creating…" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
  } finally {
    release();
  }
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toBeVisible();
  await expect(name).toHaveValue(attemptedName);
  await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
  await page.unroute("**/api/v1/fs/mkdir");
  await name.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(picker.getByRole("link", { name: attemptedName, exact: true })).toBeVisible();
  await picker.getByRole("button", { name: sandbox, exact: true }).click();
  await newFolder.click();
  await name.fill(attemptedName);
  const response = page.waitForResponse(
    (res) => res.url().endsWith("/api/v1/fs/mkdir") && res.request().method() === "POST",
  );
  await name.press("Enter");
  expect((await response).ok()).toBe(false);
  await expect(dialog).toBeVisible();
  await expect(name).toHaveValue(attemptedName);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await picker.getByRole("button", { name: "Cancel" }).click();
});

test("destination and folder dialogs fit mobile and desktop with long paths in both themes", async ({
  page,
}, testInfo) => {
  const { picker } = await openPicker(page, "Copy");
  const longName = "long-folder-name-".repeat(10);
  await picker.getByRole("button", { name: "New folder" }).click();
  await createFolder(page, longName);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  for (const width of [320, 402, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(picker).toHaveCSS("width", `${width < 640 ? width - 32 : 448}px`);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveClass(new RegExp(theme));
      const metrics = await picker.evaluate((element) => ({
        width: element.clientWidth,
        scroll: element.scrollWidth,
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
        maxWidth: getComputedStyle(element).maxWidth,
        buttons: Array.from(element.querySelectorAll("button")).map((button) => ({
          label: button.textContent,
          classes: button.className,
          height: getComputedStyle(button).height,
          minHeight: getComputedStyle(button).minHeight,
        })),
      }));
      await testInfo.attach(`layout-${width}-${theme}`, {
        body: JSON.stringify(metrics, null, 2),
        contentType: "application/json",
      });
      expect(metrics.scroll).toBeLessThanOrEqual(metrics.width + 1);
      expect(metrics.left).toBeGreaterThanOrEqual(0);
      expect(metrics.right).toBeLessThanOrEqual(width);
      if (width < 640) {
        for (const label of ["New folder", "Copy here", "Cancel"]) {
          await expect(picker.getByRole("button", { name: label, exact: true })).toHaveCSS(
            "height",
            "44px",
          );
        }
      }
      await page.screenshot({
        path: testInfo.outputPath(`picker-${width}-${theme}.png`),
        animations: "disabled",
      });
      await picker.getByRole("button", { name: "New folder" }).click();
      const dialog = page.getByRole("dialog", { name: "New folder", exact: true });
      await expect(dialog.getByLabel("Folder name")).toBeFocused();
      await dialog.getByLabel("Folder name").fill(longName);
      expect(
        await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`new-folder-${width}-${theme}.png`),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
  }
});
