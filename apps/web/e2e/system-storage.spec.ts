import { expect, type Page, test } from "@playwright/test";
import { dismissActivityPanel } from "./support/activity.js";
import { otherLoopback, webdavUrl } from "./support/local-folder.js";

/** The labels this spec creates; anything left over from an aborted run is removed first. */
const SPARE_LABELS = ["Second", "Second renamed"];

interface ProviderRow {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly managedByEnv: boolean;
}

async function listProviders(page: Page): Promise<ProviderRow[]> {
  const response = await page.request.get("/api/v1/admin/providers");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { providers: ProviderRow[] };
  return body.providers;
}

/** Removes the rows this spec owns, so a run aborted midway does not poison the next one. */
async function removeSpareProviders(page: Page): Promise<void> {
  for (const provider of await listProviders(page)) {
    if (SPARE_LABELS.includes(provider.label)) {
      const response = await page.request.delete(`/api/v1/admin/providers/${provider.id}`, {
        headers: { "x-requested-with": "fdrive" },
      });
      expect(response.ok(), `remove spare provider ${provider.label}`).toBeTruthy();
    }
  }
}

/**
 * alice's WebDAV server spelled with the other loopback name, so the new
 * row's `(type, baseUrl)` pair does not collide with the rows the WebDAV
 * specs add while still pointing at a server the probe can actually reach.
 */
function spareAddress(): string {
  return otherLoopback(webdavUrl());
}

test("cleanup removes a spare provider left by an interrupted run", async ({ page }) => {
  await removeSpareProviders(page);
  try {
    const response = await page.request.post("/api/v1/admin/providers", {
      headers: { "x-requested-with": "fdrive" },
      data: { type: "webdav", label: "Second", baseUrl: spareAddress() },
    });
    expect(response.ok()).toBe(true);
    expect((await listProviders(page)).some((provider) => provider.label === "Second")).toBe(true);
    await removeSpareProviders(page);
    expect(
      (await listProviders(page)).some((provider) => SPARE_LABELS.includes(provider.label)),
    ).toBe(false);
  } finally {
    await removeSpareProviders(page);
  }
});

test("alice (admin) can add, test, rename, disable and remove a storage provider", async ({
  page,
}) => {
  await removeSpareProviders(page);
  const seeded = (await listProviders(page)).find((provider) => provider.managedByEnv);
  expect(seeded, "the e2e stack seeds the FDRIVE_STORAGE_ROOT folder").toBeDefined();
  const address = spareAddress();
  const cards = page.getByRole("main").locator('[data-slot="card"]');

  try {
    await page.goto("/system/storage");
    await dismissActivityPanel(page);
    // Other specs may leave a disabled WebDAV row behind (a login binds it,
    // so it cannot be removed); count relative to what is already there.
    await expect(cards.first()).toBeVisible();
    const initial = await cards.count();

    await page.getByRole("button", { name: "Add provider" }).click();
    const dialog = page.getByRole("dialog");
    // Only storage at an address can be added: the local folder is the deployment's.
    await dialog.getByLabel("Type").click();
    await expect(page.getByRole("option", { name: /Local folder/ })).toHaveCount(0);
    await page.getByRole("option", { name: "WebDAV", exact: true }).click();
    // The closed Type trigger shows the type's label, not its raw value.
    await expect(dialog.getByLabel("Type")).toHaveText(/WebDAV/);
    await expect(dialog.getByLabel("Type")).not.toContainText("webdav");
    await dialog.getByLabel("Name").fill("Second");
    await dialog.getByLabel("Address").fill(address);
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(cards).toHaveCount(initial + 1);

    // The row's own probe, against the freshly stored address.
    const second = cards.filter({ hasText: "Second" });
    await expect(second.getByText(address)).toBeVisible();
    await expect(second.getByText("Settings", { exact: true })).toBeVisible();
    await dismissActivityPanel(page);
    await second.getByRole("button", { name: "Test Second" }).dispatchEvent("click");
    await expect(second.getByText("Reachable", { exact: true })).toBeVisible();

    await second.getByRole("button", { name: "Edit Second" }).click();
    await expect(dialog.getByLabel("Address")).toHaveValue(address);
    await dialog.getByLabel("Name").fill("Second renamed");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    const renamed = cards.filter({ hasText: "Second renamed" });
    await expect(renamed).toHaveCount(1);

    // Another provider stays enabled, so turning this one off needs no
    // confirmation: nobody loses the ability to sign in.
    const toggle = renamed.getByRole("switch", { name: "Enable Second renamed" });
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();

    // No login uses this provider, so it can be removed after confirming.
    await renamed.getByRole("button", { name: "Remove Second renamed" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(cards).toHaveCount(initial);
    await expect(page.getByText("Second")).toHaveCount(0);
  } finally {
    await removeSpareProviders(page);
  }
});

test("an admin can disable the last provider, reload, and enable it again", async ({ page }) => {
  await removeSpareProviders(page);
  const seeded = (await listProviders(page)).find((provider) => provider.managedByEnv);
  if (seeded === undefined) throw new Error("missing environment provider");
  try {
    await page.goto("/system/storage");
    await dismissActivityPanel(page);
    const toggle = page.getByRole("switch", { name: `Enable ${seeded.label}`, exact: true });
    await toggle.click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Disable", exact: true })
      .click();
    await expect(toggle).not.toBeChecked();
    await page.reload();
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
    expect((await page.request.get("/api/v1/auth/me")).ok()).toBe(true);
    await toggle.click();
    await expect(toggle).toBeChecked();
  } finally {
    const restored = await page.request.patch(`/api/v1/admin/providers/${seeded.id}`, {
      headers: { "x-requested-with": "fdrive" },
      data: { enabled: true },
    });
    expect(restored.ok()).toBe(true);
  }
});
