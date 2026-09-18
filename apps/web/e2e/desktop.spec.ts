import { DESKTOP_API } from "@fdrive/contracts";
import { expect, test } from "@playwright/test";

test("approves only the selected login without putting credentials in the browser", async ({
  page,
}) => {
  const created = await page.request.post(`${DESKTOP_API}/pairings`, {
    headers: { "x-requested-with": "fdrive" },
    data: { deviceName: "Finder test Mac" },
  });
  expect(created.status()).toBe(201);
  const pair = (await created.json()) as { id: string; code: string; secret: string };
  await page.goto(`/desktop/connect?request=${pair.id}`);
  await expect(page.getByRole("status", { name: "Connection code" })).toHaveText(pair.code);
  await expect(page.getByRole("button", { name: "Allow selected logins" })).toBeDisabled();
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "Allow selected logins" }).click();
  await expect(page.getByText("Connection approved", { exact: true })).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain(pair.secret);
  expect(page.url()).not.toContain("fdd_");
  const result = await page.request.post(`${DESKTOP_API}/pairings/${pair.id}/poll`, {
    headers: { "x-requested-with": "fdrive" },
    data: { secret: pair.secret },
  });
  expect(await result.json()).toMatchObject({
    status: "connected",
    credentials: [{ location: { readOnly: true } }],
  });
  await page.request.post(`${DESKTOP_API}/pairings/${pair.id}/cancel`, {
    headers: { "x-requested-with": "fdrive" },
    data: { secret: pair.secret },
  });
});

test("returns to the connection request after signing in", async ({ page }) => {
  const created = await page.request.post(`${DESKTOP_API}/pairings`, {
    headers: { "x-requested-with": "fdrive" },
    data: { deviceName: "Login test Mac" },
  });
  const pair = (await created.json()) as { id: string; secret: string };
  await page.context().clearCookies();
  await page.goto(`/desktop/connect?request=${pair.id}`);
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await page.getByLabel("Username", { exact: true }).fill("alice");
  await page.getByLabel("Password", { exact: true }).fill("alice-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Connect fdrive for Mac", { exact: true })).toBeVisible();
  await page.request.post(`${DESKTOP_API}/pairings/${pair.id}/cancel`, {
    headers: { "x-requested-with": "fdrive" },
    data: { secret: pair.secret },
  });
});

test("requires an explicit write grant and keeps an unsupported backend read-only", async ({
  page,
}) => {
  const api = "/api/v2/desktop";
  const created = await page.request.post(`${api}/pairings`, {
    headers: { "x-requested-with": "fdrive" },
    data: { deviceName: "Write test Mac" },
  });
  expect(created.status()).toBe(201);
  const pair = (await created.json()) as { id: string; code: string; secret: string };
  await page.goto(`/desktop/connect?request=${pair.id}`);
  await expect(page.getByRole("status", { name: "Connection code" })).toHaveText(pair.code);
  await page.getByRole("checkbox").first().check();
  const access = page.getByRole("combobox");
  await expect(access).toHaveValue("read");
  await access.selectOption("full");
  await page.getByRole("button", { name: "Allow selected logins" }).click();
  await expect(page.getByText("Connection approved", { exact: true })).toBeVisible();
  const response = await page.request.post(`${api}/pairings/${pair.id}/poll`, {
    headers: { "x-requested-with": "fdrive" },
    data: { secret: pair.secret },
  });
  expect(await response.json()).toMatchObject({
    status: "connected",
    credentials: [
      {
        location: {
          protocolVersion: 2,
          readOnly: true,
          capabilities: { create: false, update: false },
          // Stock SFTPGo without FDRIVE_DESKTOP_STATE_DIR: both unmet gates are named.
          writeUnavailableReason:
            'Read-only until an administrator sets "Native write enforcement" to verified-optimistic on this SFTPGo server (System › Storage) and sets FDRIVE_DESKTOP_STATE_DIR on this server.',
        },
      },
    ],
  });
  await page.request.post(`${api}/pairings/${pair.id}/cancel`, {
    headers: { "x-requested-with": "fdrive" },
    data: { secret: pair.secret },
  });
});
