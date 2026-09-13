import { DESKTOP_API, DesktopPairResult, MeResponse } from "@fdrive/contracts";
import { expect, test } from "@playwright/test";
import { dismissActivityPanel } from "./support/activity.js";
import { startEnvironment } from "./support/environment.js";
import { E2E_HOST } from "./support/paths.js";
import { getFreePort } from "./support/ports.js";

test.use({ storageState: { cookies: [], origins: [] } });

test("names storage during setup and propagates a label-only rename to logins and Mac approval", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const env = await startEnvironment({
    apiPort: await getFreePort(E2E_HOST),
    webPort: await getFreePort(E2E_HOST),
    skipStatePersist: true,
    extraApiEnv: {
      SFTPGO_URL: "",
      FDRIVE_ADMIN_USERS: "",
      FDRIVE_SETUP_TOKEN: "provider-name-test-token",
    },
  });
  const url = (path: string) => env.webBaseUrl + path;
  const headers = { "x-requested-with": "fdrive" };
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    await page.goto(url("/setup"));
    await page.getByLabel("Setup token").fill("provider-name-test-token");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByText("Shown when choosing storage and in Finder.")).toBeVisible();
    await page.getByLabel("SFTPGo URL").fill(env.sftpgoUrl);
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByText("Reachable", { exact: true })).toBeVisible();
    await page.getByLabel("Storage name").fill("   ");
    await expect(page.getByText("Enter a name for this storage.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
    await page.getByLabel("Storage name").fill("  Initial storage  ");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByLabel("SFTPGo file-user username").fill("alice");
    await page.getByLabel("Password", { exact: true }).fill("alice-password");
    await page.getByRole("button", { name: "Continue setup" }).click();
    await expect(page.getByText("Step 4 of 13 · Thumbnails")).toBeVisible();
    const before = MeResponse.parse(await (await page.request.get(url("/api/v1/auth/me"))).json());
    expect(before.identities[0]?.providerLabel).toBe("Initial storage");
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
    const providerId = before.identities[0]?.providerId;
    if (!providerId) throw new Error("missing setup provider");
    const pair = await (
      await page.request.post(url(`${DESKTOP_API}/pairings`), {
        headers,
        data: { deviceName: "Rename test Mac" },
      })
    ).json();
    const approval = await page.context().newPage();
    await approval.goto(url(`/desktop/connect?request=${pair.id}`));
    await expect(
      approval.getByRole("checkbox", { name: "Initial storage alice", exact: true }),
    ).toBeVisible();
    await page.bringToFront();
    await page.goto(url("/system/storage"));
    await dismissActivityPanel(page);
    await page.getByRole("button", { name: "Edit Initial storage", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Address", { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel("Name", { exact: true })).toBeEnabled();
    await expect(dialog.getByText("Shown when choosing storage and in Finder.")).toBeVisible();
    await dialog.getByLabel("Name", { exact: true }).fill("  Home storage  ");
    const patch = page.waitForRequest(
      (request) =>
        request.url().endsWith(`/admin/providers/${providerId}`) && request.method() === "PATCH",
    );
    const refreshedMe = page.waitForResponse(
      (response) => response.url().endsWith("/auth/me") && response.status() === 200,
    );
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    expect((await patch).postDataJSON()).toEqual({ label: "Home storage" });
    await refreshedMe;
    await expect(dialog).toBeHidden();
    await approval.bringToFront();
    // Headless pages stay visible across bringToFront; emit the browser tab-return event.
    const approvalMe = approval.waitForResponse(
      (response) => response.url().endsWith("/auth/me") && response.status() === 200,
    );
    await approval.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await approvalMe;
    await expect(
      approval.getByRole("checkbox", { name: "Home storage alice", exact: true }),
    ).toBeVisible();
    await expect(approval.getByText("alice", { exact: true })).toBeVisible();
    await approval.getByRole("checkbox").check();
    await approval.getByRole("button", { name: "Allow selected logins" }).click();
    await expect(approval.getByText("Connection approved", { exact: true })).toBeVisible();
    const connected = DesktopPairResult.parse(
      await (
        await page.request.post(url(`${DESKTOP_API}/pairings/${pair.id}/poll`), {
          headers,
          data: { secret: pair.secret },
        })
      ).json(),
    );
    expect(connected).toMatchObject({
      status: "connected",
      credentials: [{ location: { displayName: "Home storage", username: "alice", providerId } }],
    });
    await page.request.post(url(`${DESKTOP_API}/pairings/${pair.id}/cancel`), {
      headers,
      data: { secret: pair.secret },
    });
    await page.goto(url("/account"));
    await expect(page.getByRole("main").getByText("Home storage", { exact: true })).toBeVisible();
    const after = MeResponse.parse(await (await page.request.get(url("/api/v1/auth/me"))).json());
    expect(after).toEqual({
      ...before,
      identities: before.identities.map((identity) => ({
        ...identity,
        providerLabel: "Home storage",
      })),
    });
    const login = await anonymous.newPage();
    await login.goto(url("/login"));
    await expect(login.getByText(/Home storage/)).toBeVisible();
    await expect(login.getByLabel("Username", { exact: true })).toBeVisible();
  } finally {
    await anonymous.close();
    await env.stop();
  }
});
