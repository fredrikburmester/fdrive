import { DESKTOP_API, DesktopPairResult, MeResponse } from "@fdrive/contracts";
import { expect, test } from "@playwright/test";
import { dismissActivityPanel } from "./support/activity.js";
import { startEnvironment } from "./support/environment.js";
import { E2E_HOST } from "./support/paths.js";
import { getFreePort } from "./support/ports.js";

test.use({ storageState: { cookies: [], origins: [] } });

test("a storage rename on System > General reaches the login page, logins and Mac approval", async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  // Its own stack: a name, once given, cannot be taken back to none, and the
  // shared run's login page must keep naming the product alone.
  const env = await startEnvironment({
    apiPort: await getFreePort(E2E_HOST),
    webPort: await getFreePort(E2E_HOST),
    skipStatePersist: true,
  });
  const url = (path: string) => env.webBaseUrl + path;
  const headers = { "x-requested-with": "fdrive" };
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    // alice is the deployment's administrator; a fresh installation sends
    // her into the walkthrough, which the API marks finished.
    await page.goto(url("/login"));
    await page.getByLabel("Username").fill("alice");
    await page.getByLabel("Password").fill("alice-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/setup");
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

    const before = MeResponse.parse(await (await page.request.get(url("/api/v1/auth/me"))).json());
    const providerId = before.identities[0]?.providerId;
    if (!providerId) throw new Error("missing the files folder's storage row");
    const pair = await (
      await page.request.post(url(`${DESKTOP_API}/pairings`), {
        headers,
        data: { deviceName: "Rename test Mac" },
      })
    ).json();
    const approval = await page.context().newPage();
    await approval.goto(url(`/desktop/connect?request=${pair.id}`));
    await expect(approval.getByRole("checkbox", { name: /alice$/ })).toBeVisible();

    await page.bringToFront();
    await page.goto(url("/system/general"));
    await dismissActivityPanel(page);
    const name = page.getByLabel("Name", { exact: true });
    await expect(page.getByText("Shown on the login page and in Finder.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save name" })).toBeDisabled();
    await name.fill("   ");
    await expect(page.getByText("Enter a name for this storage.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save name" })).toBeDisabled();
    await name.fill("  Home storage  ");
    const patch = page.waitForRequest(
      (request) =>
        request.url().endsWith(`/admin/providers/${providerId}`) && request.method() === "PATCH",
    );
    const refreshedMe = page.waitForResponse(
      (response) => response.url().endsWith("/auth/me") && response.status() === 200,
    );
    await page.getByRole("button", { name: "Save name" }).click();
    expect((await patch).postDataJSON()).toEqual({ label: "Home storage" });
    await refreshedMe;
    await expect(name).toHaveValue("Home storage");
    await expect(page.getByRole("button", { name: "Save name" })).toBeDisabled();

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
    await expect(
      login.getByText("Sign in with your fdrive account on Home storage", { exact: true }),
    ).toBeVisible();
    await expect(login.getByLabel("Server")).toHaveCount(0);
    await expect(login.getByLabel("Username", { exact: true })).toBeVisible();
  } finally {
    await anonymous.close();
    await env.stop();
  }
});
