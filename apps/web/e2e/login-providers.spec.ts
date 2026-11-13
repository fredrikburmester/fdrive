import { type APIRequestContext, expect, test } from "@playwright/test";
import { otherLoopback, webdavUrl } from "./support/local-folder.js";
import { loginAs } from "./support/login.js";
import { getAliceStorageStatePath, getWebBaseUrl } from "./support/paths.js";

// The login page must be exercised signed out; the admin API calls that
// add and remove the second provider use their own context signed in as
// alice (an admin), so the page's own storage state stays empty.
test.use({ storageState: { cookies: [], origins: [] } });

interface AdminProviderRow {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly managedByEnv: boolean;
}

const SECOND_LABEL = "e2e-second-server";
const MUTATION_HEADERS = { "x-requested-with": "fdrive" };

async function listProviders(admin: APIRequestContext): Promise<AdminProviderRow[]> {
  const response = await admin.get("/api/v1/admin/providers");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { providers: AdminProviderRow[] }).providers;
}

async function removeSecondProvider(admin: APIRequestContext): Promise<void> {
  for (const provider of await listProviders(admin)) {
    if (provider.label === SECOND_LABEL) {
      const response = await admin.delete(`/api/v1/admin/providers/${provider.id}`, {
        headers: MUTATION_HEADERS,
      });
      expect(response.ok()).toBe(true);
    }
  }
}

test("the login page shows no server picker with one provider and a picker with two", async ({
  page,
  playwright,
}) => {
  const admin = await playwright.request.newContext({
    baseURL: getWebBaseUrl(),
    storageState: getAliceStorageStatePath(),
  });
  try {
    // A leftover from an aborted run must not break this one.
    await removeSecondProvider(admin);

    await page.goto("/login");
    await expect(page.getByLabel("Username")).toBeVisible();
    await expect(page.getByLabel("Server")).toHaveCount(0);
    // A local login has a username and a password, nothing more.
    await expect(page.getByLabel(/one-time code/i)).toHaveCount(0);
    // The local folder has no admin-set name, and its accounts are fdrive's
    // own, so the page names the product only.
    await expect(page.getByText("Sign in with your fdrive account", { exact: true })).toBeVisible();

    // alice's WebDAV server becomes a second enabled provider, spelled with
    // the other loopback name so it never collides with the rows the WebDAV
    // specs add.
    const [seeded] = await listProviders(admin);
    if (seeded === undefined) throw new Error("no seeded provider");
    const created = await admin.post("/api/v1/admin/providers", {
      headers: MUTATION_HEADERS,
      data: { type: "webdav", label: SECOND_LABEL, baseUrl: otherLoopback(webdavUrl()) },
    });
    expect(created.ok(), await created.text()).toBe(true);

    await page.goto("/login");
    await expect(page.getByText("Choose a server and sign in")).toBeVisible();
    const picker = page.getByLabel("Server");
    await expect(picker).toBeVisible();
    await picker.click();
    await expect(page.getByRole("option", { name: new RegExp(SECOND_LABEL) })).toBeVisible();
    // Signing in through the first (seeded) provider still works with the
    // picker present and sends that provider's id. The local folder is
    // listed by product name alone: the admin view's label is not public.
    await page.getByRole("option", { name: "fdrive", exact: true }).click();
    // The closed picker names the chosen server, never its provider id.
    await expect(picker).toHaveText(/fdrive/);
    await expect(picker).not.toContainText(seeded.id);
    const loginRequest = page.waitForRequest(
      (request) => request.url().endsWith("/api/v1/auth/login") && request.method() === "POST",
    );
    await loginAs(page, "alice", "alice-password");
    expect((await loginRequest).postDataJSON()).toEqual({
      providerId: seeded.id,
      credential: { username: "alice", password: "alice-password" },
    });
    await expect(page).toHaveURL(/\/files$/);
  } finally {
    await removeSecondProvider(admin);
    await admin.dispose();
  }
});
