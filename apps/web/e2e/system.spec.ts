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

test("alice (admin) sees the Indexer, Search, OCR, and Thumbnails pages as not configured in the e2e stack", async ({
  page,
}) => {
  await page.goto("/files");

  for (const label of ["Indexer", "Search", "OCR", "Thumbnails"]) {
    await expect(page.getByRole("link", { name: label })).toBeVisible();
  }

  // No indexer, OCR, embedding, or thumbnails sidecar runs in the e2e
  // stack, so every page's own "not configured" state should render
  // rather than an error.
  await page.getByRole("link", { name: "Indexer" }).click();
  await expect(page).toHaveURL(/\/system\/indexer$/);
  await expect(page.getByText("Not configured")).toBeVisible();

  await page.getByRole("link", { name: "Search" }).click();
  await expect(page).toHaveURL(/\/system\/search$/);
  await expect(page.getByText("Not configured")).toBeVisible();

  await page.getByRole("link", { name: "OCR" }).click();
  await expect(page).toHaveURL(/\/system\/ocr$/);
  await expect(page.getByText("Not configured")).toBeVisible();

  await page.getByRole("link", { name: "Thumbnails" }).click();
  await expect(page).toHaveURL(/\/system\/thumbnails$/);
  await expect(page.getByText("Not configured")).toBeVisible();
});

test("alice (admin) can save the indexer's settings even while the indexer sidecar is unreachable", async ({
  page,
}) => {
  await page.goto("/system/indexer");

  const workersInput = page.getByLabel("Workers");
  await expect(workersInput).toBeVisible();
  const originalWorkers = await workersInput.inputValue();
  const updatedWorkers = "7";

  await workersInput.fill(updatedWorkers);
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
  await clickSave(page);
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();

  await page.reload();
  await expect(page.getByLabel("Workers")).toHaveValue(updatedWorkers);

  // Restore the original value so this test stays idempotent across
  // repeated local runs against the same environment.
  await page.getByLabel("Workers").fill(originalWorkers);
  await clickSave(page);
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
});

test.describe("bob (not admin)", () => {
  // bob is not in FDRIVE_ADMIN_USERS, so this spec logs in as bob itself
  // rather than reusing the alice storage state the "chromium" project
  // otherwise applies by default.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sees no System sidebar group and gets 403 from the admin connection and system routes", async ({
    page,
  }) => {
    await loginAs(page, "bob", "bob-password");

    await expect(page.getByText("Locations")).toBeVisible();
    await expect(page.getByText("System")).toBeHidden();
    await expect(page.getByRole("link", { name: "Connection" })).toBeHidden();
    await expect(page.getByRole("link", { name: "Indexer" })).toBeHidden();
    await expect(page.getByRole("link", { name: "Search" })).toBeHidden();
    await expect(page.getByRole("link", { name: "OCR" })).toBeHidden();
    await expect(page.getByRole("link", { name: "Thumbnails" })).toBeHidden();

    const connectionRes = await page.request.get("/api/v1/admin/connection");
    expect(connectionRes.status()).toBe(403);

    for (const path of [
      "/api/v1/system/indexer",
      "/api/v1/system/search",
      "/api/v1/system/ocr",
      "/api/v1/system/thumbnails",
    ]) {
      const res = await page.request.get(path);
      expect(res.status()).toBe(403);
    }
  });
});
