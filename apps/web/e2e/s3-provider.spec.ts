import { type MinioContainer, startMinio } from "@fdrive/testkit";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { dismissActivityPanel } from "./support/activity.js";
import { getAliceStorageStatePath, getWebBaseUrl } from "./support/paths.js";
import { uploadFiles } from "./support/upload.js";

/**
 * A MinIO bucket this file starts for itself is the real S3 target these
 * specs add as a third provider type. People sign in to it with an access
 * key and secret rather than a username and password. The shared
 * environment never starts one, so the other specs pay nothing for it.
 */
let minio: MinioContainer | undefined;

test.beforeAll(async () => {
  // The first run pulls the image, which the default hook timeout does not cover.
  test.setTimeout(180_000);
  minio = await startMinio();
});

test.afterAll(async () => {
  await minio?.stop();
});

function bucket(): MinioContainer {
  if (minio === undefined) throw new Error("fdrive e2e: MinIO did not start");
  return minio;
}

/**
 * The bucket address spelled with the IPv4 loopback address. `localhost`
 * can resolve to `::1` first on a CI runner where Docker publishes ports on
 * IPv4 only, and the API probes a candidate before adding it.
 */
function loopbackBucketUrl(): string {
  const url = new URL(bucket().baseUrl);
  url.hostname = "127.0.0.1";
  return `${url.origin}${url.pathname}`;
}

/** The row added through the UI; the trailing slash keeps its `(type, baseUrl)` apart from the login row's. */
function uiAddress(): string {
  return `${loopbackBucketUrl()}/`;
}

/** The row a login binds; it persists (disabled) across runs, so it never shares the UI row's address. */
function loginAddress(): string {
  return loopbackBucketUrl();
}

interface ProviderRow {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly enabled: boolean;
}

/** Added through the UI and always removed again: no login ever binds it. */
const UI_LABEL = "e2e-s3-ui";
/** Bound by a login, so it cannot be removed; it is disabled again after the spec. */
const LOGIN_LABEL = "e2e-s3-login";
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

test("alice (admin) adds a MinIO bucket as an S3 provider, tests it and removes it", async ({
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
    await page.getByRole("option", { name: "S3", exact: true }).click();
    await dialog.getByLabel("Name").fill(UI_LABEL);
    await dialog.getByLabel("Address").fill(uiAddress());
    // The type's own configuration field renders with its one-line help.
    await expect(dialog.getByLabel("Region")).toBeVisible();
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(cards).toHaveCount(initial + 1);

    const card = cards.filter({ hasText: UI_LABEL });
    await expect(card.getByRole("img", { name: "S3" })).toBeVisible();
    await expect(card.getByText(uiAddress())).toBeVisible();
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

test.describe("signing in through S3", () => {
  // The login page must be exercised signed out; the admin calls that
  // prepare the row use their own context signed in as alice.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a person signs in with an access key, browses and uploads", async ({
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
          data: { type: "s3", label: LOGIN_LABEL, baseUrl: loginAddress() },
        });
        expect(created.ok(), await created.text()).toBe(true);
        row = (await created.json()) as ProviderRow;
      } else if (!row.enabled) {
        await setEnabled(admin, row.id, true);
      }

      await page.goto("/login");
      await expect(page.getByText("Choose a server and sign in")).toBeVisible();
      await page.getByLabel("Server").click();
      await page.getByRole("option", { name: new RegExp(LOGIN_LABEL) }).click();
      // The credential form uses the type's own labels.
      await page.getByLabel("Access key ID").fill(bucket().writer.accessKeyId);
      await page.getByLabel("Secret key").fill(bucket().writer.secretAccessKey);
      const loginRequest = page.waitForRequest(
        (request) => request.url().endsWith("/api/v1/auth/login") && request.method() === "POST",
      );
      await page.getByRole("button", { name: "Sign in" }).click();
      expect((await loginRequest).postDataJSON()).toMatchObject({ providerId: row.id });
      await page.waitForURL("**/files");
      await page.getByRole("button", { name: "New" }).waitFor();

      await expect(
        page.getByRole("button", {
          name: new RegExp(`${bucket().writer.accessKeyId} S3 ${LOGIN_LABEL}`),
        }),
      ).toBeVisible();
      const me = (await (await page.request.get("/api/v1/auth/me")).json()) as {
        identities: { providerType: string; capabilities: { zip: boolean; atomicMove: boolean } }[];
      };
      expect(me.identities[0]).toMatchObject({
        providerType: "s3",
        capabilities: { zip: false, atomicMove: false },
      });

      // The bucket is shared with every other spec's leftovers, so work
      // inside a fresh folder where the upload is the only entry.
      const folder = `/s3-e2e-${Date.now().toString(36)}`;
      const made = await page.request.post("/api/v1/fs/mkdir", {
        headers: MUTATION_HEADERS,
        data: { path: folder },
      });
      expect(made.ok()).toBe(true);
      await page.goto(`/files${folder}`);
      await page.getByRole("button", { name: "New" }).waitFor();
      const name = "hello-over-s3.txt";
      await uploadFiles(page, [{ name, mimeType: "text/plain", contents: "hello over s3" }]);
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
      await expect
        .poll(
          async () =>
            (
              await page.request.get(
                `/api/v1/fs/stat?path=${encodeURIComponent(`${folder}/${name}`)}`,
              )
            ).status(),
          { timeout: 15_000 },
        )
        .toBe(200);
      const removed = await page.request.post("/api/v1/fs/delete", {
        headers: MUTATION_HEADERS,
        data: { items: [{ path: folder, kind: "dir" }] },
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
