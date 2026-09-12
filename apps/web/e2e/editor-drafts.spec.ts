import { expect, test } from "@playwright/test";
import { uniqueName } from "./support/unique.js";

test("an unsaved editor draft survives sidebar navigation and can be saved", async ({ page }) => {
  const name = `${uniqueName("draft")}.txt`;
  const path = `/${name}`;
  expect(
    (
      await page.request.put(`/api/v1/fs/upload?path=${encodeURIComponent(path)}`, {
        data: "original",
        headers: { "x-requested-with": "fdrive" },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/edit${path}`);
  const editor = page.locator(".cm-content:visible");
  await expect(editor).toHaveText("original");
  await editor.fill("unsaved draft");
  await page.getByRole("link", { name: "Files", exact: true }).click();
  await expect(page).toHaveURL(/\/files$/);
  await page.getByRole("link", { name, exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(editor).toHaveText("unsaved draft");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const response = await page.request.get(`/api/v1/fs/download?path=${encodeURIComponent(path)}`);
  expect(await response.text()).toBe("unsaved draft");
});
