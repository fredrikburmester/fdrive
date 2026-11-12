import { stat } from "node:fs/promises";
import { join } from "node:path";
import { MeResponse } from "@fdrive/contracts";
import { expect, test } from "@playwright/test";
import { startEnvironment } from "./support/environment.js";
import { E2E_HOST } from "./support/paths.js";
import { getFreePort } from "./support/ports.js";

test.use({ storageState: { cookies: [], origins: [] } });

const TOKEN = "local-setup-test-token";
const OWNER = { username: "owner", password: "owner-test-password" };

test("setup on a fresh local folder creates the owner's account, which becomes the administrator", async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  // A local folder nobody has an account on yet: setup creates the first one.
  const env = await startEnvironment({
    apiPort: await getFreePort(E2E_HOST),
    webPort: await getFreePort(E2E_HOST),
    skipStatePersist: true,
    storage: { users: [], files: {} },
    createUsers: false,
    extraApiEnv: { FDRIVE_ADMIN_USERS: "", FDRIVE_SETUP_TOKEN: TOKEN },
  });
  const url = (path: string) => env.webBaseUrl + path;
  const headers = { "x-requested-with": "fdrive" };
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const status = await (await page.request.get(url("/api/v1/setup/status"))).json();
    expect(status).toMatchObject({ required: true, mode: "local", types: [] });

    await page.goto(url("/login"));
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByText("Step 1 of 12")).toBeVisible();
    await page.getByLabel("Setup token").fill(TOKEN);
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    // No storage to connect: the folder is the deployment's. Only the account.
    await expect(page.getByText("Create your account")).toBeVisible();
    await expect(page.getByText("Step 2 of 12")).toBeVisible();
    await expect(page.getByLabel("Storage type")).toHaveCount(0);
    const create = page.getByRole("button", { name: "Create account", exact: true });
    await page.getByLabel("Username").fill("not a name");
    await expect(
      page.getByText("Use letters, digits and . _ @ ~ - only, starting with a letter or digit."),
    ).toBeVisible();
    await page.getByLabel("Username").fill(OWNER.username);
    await expect(page.getByText("Also the name of your folder on this server.")).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill("short");
    await expect(page.getByText("Use at least 8 characters.")).toBeVisible();
    await expect(create).toBeDisabled();
    await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
    await page.getByLabel("Confirm password").fill(`${OWNER.password}-typo`);
    await expect(page.getByText("The passwords don't match.")).toBeVisible();
    await expect(create).toBeDisabled();
    await page.getByLabel("Confirm password").fill(OWNER.password);
    await create.click();

    // The account is signed in and continues straight into the walkthrough.
    await expect(page.getByText("Step 3 of 12 · Thumbnails")).toBeVisible();
    const me = MeResponse.parse(await (await page.request.get(url("/api/v1/auth/me"))).json());
    expect(me.isAdmin).toBe(true);
    expect(me.identities).toEqual([
      expect.objectContaining({ providerType: "local", username: OWNER.username }),
    ]);
    const after = await (await page.request.get(url("/api/v1/setup/status"))).json();
    expect(after.required).toBe(false);

    const features = await (await page.request.get(url("/api/v1/system/features"))).json();
    expect(
      (
        await page.request.put(url("/api/v1/system/features"), {
          headers,
          data: {
            revision: features.configuration.revision,
            values: features.configuration.values,
            walkthroughComplete: true,
          },
        })
      ).ok(),
    ).toBe(true);

    // The owner's files are a folder of their own under the storage root.
    await page.goto(url("/files"));
    await page.getByRole("button", { name: "New" }).waitFor();
    await expect
      .poll(async () =>
        (await stat(join(env.storageRoot ?? "", OWNER.username)).catch(() => null))?.isDirectory(),
      )
      .toBe(true);

    // The owner is the one user System > Users lists, and cannot demote themselves.
    await page.goto(url("/system/users"));
    const row = page.getByRole("row").filter({ hasText: OWNER.username });
    await expect(row.getByText("You", { exact: true })).toBeVisible();
    await expect(row.getByText("Admin", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: `Actions for ${OWNER.username}` })).toHaveCount(0);

    // Setup is over: the token no longer opens it, and the account signs in.
    const login = await anonymous.newPage();
    await login.goto(url("/login"));
    await expect(login).toHaveURL(/\/login$/);
    await expect(
      login.getByText("Sign in with your fdrive account", { exact: true }),
    ).toBeVisible();
    await login.getByLabel("Username").fill(OWNER.username);
    await login.getByLabel("Password").fill(OWNER.password);
    await login.getByRole("button", { name: "Sign in" }).click();
    await login.waitForURL("**/files");
    await login.getByRole("button", { name: "New" }).waitFor();
  } finally {
    await anonymous.close();
    await env.stop();
  }
});
