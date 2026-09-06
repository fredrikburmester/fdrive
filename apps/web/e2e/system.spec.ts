import { expect, type Page, test } from "@playwright/test";
import { loginAs } from "./support/login.js";

/**
 * Clicks the connection page's Save button by dispatching the click event
 * directly on the element rather than simulating a real pointer click.
 * Earlier specs in a full run can leave finished jobs in the account-wide
 * Activity panel (fixed bottom-right on every page), which can visually
 * overlap this card's bottom-right Save button; a real mouse click would
 * land on whichever element is topmost at that point, which is unrelated
 * to this page's own behaviour and not what this test means to exercise.
 */
async function clickSave(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Save" }).dispatchEvent("click");
}

test("alice (admin) sees System > Connection with a reachable host and can change the home template", async ({
  page,
}) => {
  await page.goto("/files");

  await expect(page.getByRole("link", { name: "Connection" })).toBeVisible();
  await page.getByRole("link", { name: "Connection" }).click();
  await expect(page).toHaveURL(/\/system\/connection$/);

  await expect(page.getByText("Host", { exact: true })).toBeVisible();
  await expect(page.getByText("Reachable", { exact: true })).toBeVisible();

  const templateInput = page.getByLabel("Template");
  const originalTemplate = await templateInput.inputValue();
  const updatedTemplate = "sftpgo:/updated/{username}";

  await templateInput.fill(updatedTemplate);
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
  await clickSave(page);
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();

  await page.reload();
  await expect(page.getByLabel("Template")).toHaveValue(updatedTemplate);

  // Restore the original template so this test stays idempotent across
  // repeated local runs against the same environment.
  await page.getByLabel("Template").fill(originalTemplate);
  await clickSave(page);
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
});

test.describe("bob (not admin)", () => {
  // bob is not in FDRIVE_ADMIN_USERS, so this spec logs in as bob itself
  // rather than reusing the alice storage state the "chromium" project
  // otherwise applies by default.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sees no System sidebar group and gets 403 from the admin connection route", async ({
    page,
  }) => {
    await loginAs(page, "bob", "bob-password");

    await expect(page.getByText("Locations")).toBeVisible();
    await expect(page.getByText("System")).toBeHidden();
    await expect(page.getByRole("link", { name: "Connection" })).toBeHidden();

    const res = await page.request.get("/api/v1/admin/connection");
    expect(res.status()).toBe(403);
  });
});
