import { type APIRequestContext, expect, test } from "@playwright/test";
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
    await expect(page.getByText(/Sign in with your SFTPGo account on/)).toBeVisible();

    // The same SFTPGo server through another host spelling is a new
    // (type, baseUrl) pair, so it becomes a second enabled provider.
    const [seeded] = await listProviders(admin);
    if (seeded === undefined) throw new Error("no seeded provider");
    const created = await admin.post("/api/v1/admin/providers", {
      headers: MUTATION_HEADERS,
      data: {
        type: "sftpgo",
        label: SECOND_LABEL,
        baseUrl: seeded.baseUrl.includes("localhost")
          ? seeded.baseUrl.replace("localhost", "127.0.0.1")
          : seeded.baseUrl.replace("127.0.0.1", "localhost"),
      },
    });
    expect(created.ok(), await created.text()).toBe(true);

    await page.goto("/login");
    await expect(page.getByText("Choose a server and sign in")).toBeVisible();
    const picker = page.getByLabel("Server");
    await expect(picker).toBeVisible();
    await picker.click();
    await expect(page.getByRole("option", { name: new RegExp(SECOND_LABEL) })).toBeVisible();
    // Signing in through the first (seeded) provider still works with the
    // picker present and sends that provider's id.
    await page.getByRole("option", { name: new RegExp(seeded.label) }).click();
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
