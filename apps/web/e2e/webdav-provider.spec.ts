import { type APIRequestContext, expect, test } from "@playwright/test";
import { dismissActivityPanel } from "./support/activity.js";
import { getAliceStorageStatePath, getWebBaseUrl } from "./support/paths.js";
import { uploadFiles } from "./support/upload.js";

/**
 * SFTPGo's own WebDAV binding, started by `global-setup.ts` next to its
 * REST API, is the real class 1 server these specs add as a second
 * provider type. The same seeded users and files answer over both.
 */
function webdavUrl(): string {
  const url = process.env.E2E_SFTPGO_WEBDAV_URL;
  if (url === undefined || url === "") {
    throw new Error("fdrive e2e: E2E_SFTPGO_WEBDAV_URL is not set; global-setup exports it");
  }
  return url;
}

/** The other loopback spelling, so two rows for the same server never share a `(type, baseUrl)`. */
function otherSpelling(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.hostname = url.hostname === "localhost" ? "127.0.0.1" : "localhost";
  return url.origin;
}

interface ProviderRow {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly enabled: boolean;
}

/** Added through the UI and always removed again: no login ever binds it. */
const UI_LABEL = "e2e-webdav-ui";
/** Bound by a login, so it cannot be removed; it is disabled again after the spec. */
const LOGIN_LABEL = "e2e-webdav-login";
const MUTATION_HEADERS = { "x-requested-with": "fdrive" };

async function listProviders(admin: APIRequestContext): Promise<ProviderRow[]> {
  const response = await admin.get("/api/v1/admin/providers");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { providers: ProviderRow[] }).providers;
}

async function removeByLabel(admin: APIRequestContext, label: string): Promise<void> {
  for (const provider of await listProviders(admin)) {
    if (provider.label === label) {
      const response = await admin.delete(`/api/v1/admin/providers/${provider.id}`, {
        headers: MUTATION_HEADERS,
      });
      expect(response.ok(), `remove ${label}`).toBe(true);
    }
  }
}

async function setEnabled(admin: APIRequestContext, id: string, enabled: boolean): Promise<void> {
  const response = await admin.patch(`/api/v1/admin/providers/${id}`, {
    headers: MUTATION_HEADERS,
    data: { enabled },
  });
  expect(response.ok()).toBe(true);
}

test("alice (admin) adds SFTPGo's WebDAV binding as a provider, tests it and removes it", async ({
  page,
}) => {
  await removeByLabel(page.request, UI_LABEL);
  const cards = page.getByRole("main").locator('[data-slot="card"]');
  try {
    await page.goto("/system/storage");
    await dismissActivityPanel(page);
    await expect(cards.first()).toBeVisible();
    const initial = await cards.count();

    await page.getByRole("button", { name: "Add provider" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Type").click();
    await page.getByRole("option", { name: "WebDAV", exact: true }).click();
    await dialog.getByLabel("Name").fill(UI_LABEL);
    await dialog.getByLabel("Address").fill(webdavUrl());
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(cards).toHaveCount(initial + 1);

    const card = cards.filter({ hasText: UI_LABEL });
    // The row names the product with its icon (labelled for screen readers) and shows the address.
    await expect(card.getByRole("img", { name: "WebDAV" })).toBeVisible();
    await expect(card.getByText(webdavUrl())).toBeVisible();
    await dismissActivityPanel(page);
    await card.getByRole("button", { name: `Test ${UI_LABEL}` }).dispatchEvent("click");
    await expect(card.getByText("Reachable", { exact: true })).toBeVisible();

    await card.getByRole("button", { name: `Remove ${UI_LABEL}` }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(cards).toHaveCount(initial);
  } finally {
    await removeByLabel(page.request, UI_LABEL);
  }
});

test.describe("signing in through WebDAV", () => {
  // The login page must be exercised signed out; the admin calls that
  // prepare the row use their own context signed in as alice.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a person signs in through the WebDAV provider, browses and uploads", async ({
    page,
    playwright,
  }) => {
    const admin = await playwright.request.newContext({
      baseURL: getWebBaseUrl(),
      storageState: getAliceStorageStatePath(),
    });
    let row: ProviderRow | undefined;
    try {
      row = (await listProviders(admin)).find((provider) => provider.label === LOGIN_LABEL);
      if (row === undefined) {
        const created = await admin.post("/api/v1/admin/providers", {
          headers: MUTATION_HEADERS,
          data: { type: "webdav", label: LOGIN_LABEL, baseUrl: otherSpelling(webdavUrl()) },
        });
        expect(created.ok(), await created.text()).toBe(true);
        row = (await created.json()) as ProviderRow;
      } else if (!row.enabled) {
        await setEnabled(admin, row.id, true);
      }

      await page.goto("/login");
      await expect(page.getByText("Choose a server and sign in")).toBeVisible();
      await page.getByLabel("Server").click();
      // The option names the row and its type ("e2e-webdav-login WebDAV").
      await page.getByRole("option", { name: new RegExp(LOGIN_LABEL) }).click();
      await page.getByLabel("Username").fill("alice");
      await page.getByLabel("Password").fill("alice-password");
      const loginRequest = page.waitForRequest(
        (request) => request.url().endsWith("/api/v1/auth/login") && request.method() === "POST",
      );
      await page.getByRole("button", { name: "Sign in" }).click();
      expect((await loginRequest).postDataJSON()).toMatchObject({ providerId: row.id });
      await page.waitForURL("**/files");
      await page.getByRole("button", { name: "New" }).waitFor();

      // The seeded home, read over WebDAV this time.
      await expect(page.getByText("photo.jpg", { exact: true }).first()).toBeVisible();
      const me = (await (await page.request.get("/api/v1/auth/me")).json()) as {
        identities: { providerType: string; capabilities: { zip: boolean; atomicMove: boolean } }[];
      };
      expect(me.identities[0]).toMatchObject({
        providerType: "webdav",
        capabilities: { zip: false, atomicMove: true },
      });

      const name = `webdav-upload-${Date.now().toString(36)}.txt`;
      await uploadFiles(page, [{ name, mimeType: "text/plain", contents: "hello over webdav" }]);
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
      const stat = await page.request.get(`/api/v1/fs/stat?path=${encodeURIComponent(`/${name}`)}`);
      expect(stat.ok()).toBe(true);
      const removed = await page.request.post("/api/v1/fs/delete", {
        headers: MUTATION_HEADERS,
        data: { items: [{ path: `/${name}`, kind: "file" }] },
      });
      expect(removed.ok()).toBe(true);
    } finally {
      // The login above binds an identity to the row, so it cannot be
      // removed; disabling it keeps the public provider list to the seeded
      // SFTPGo row for the other specs.
      if (row !== undefined) await setEnabled(admin, row.id, false);
      await admin.dispose();
    }
  });
});
