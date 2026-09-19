import { ActivityFileResponse, PersonalActivityResponse } from "@fdrive/contracts";
import { expect, test } from "@playwright/test";
import { uniqueName } from "./support/unique.js";
import { uploadFiles } from "./support/upload.js";

test("upload completion leads to a durable journey, copies branch and exports keep the selected scope", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  const folder = uniqueName("journey");
  const headers = { "x-requested-with": "fdrive" };
  const mkdir = await page.request.post("/api/v1/fs/mkdir", {
    headers,
    data: { path: `/${folder}` },
  });
  expect(mkdir.ok()).toBe(true);
  await page.goto(`/files/${folder}`);
  const name = "old-report.txt",
    path = `/${folder}/${name}`;
  await uploadFiles(page, [{ name, mimeType: "text/plain", contents: "Find this upload again" }]);
  // The transfer panel folds itself into a pill once nothing is in flight.
  await page.getByRole("button", { name: /uploaded/ }).click();
  const panel = page.locator('[data-slot="activity-panel"]');
  await expect(panel.getByText("Uploaded", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Show in folder" }).click();
  await expect(page.locator(`[data-path="${path}"]`).first()).toBeVisible();
  await panel.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/view/${folder}/${name}$`));
  await expect(page.getByText("Find this upload again", { exact: false }).first()).toBeVisible();
  const feed = PersonalActivityResponse.parse(
    await (await page.request.get(`/api/v1/activity?q=${folder}`)).json(),
  );
  const uploaded = feed.items.find(
    (event) => event.action === "file.upload" && event.stage === "outcome",
  );
  expect(uploaded?.fileId).toBeTruthy();
  const id = uploaded?.fileId as string;
  const target = `/${folder}/renamed.txt`;
  expect(
    (
      await page.request.post("/api/v1/fs/rename", {
        headers,
        data: { path, newName: "renamed.txt" },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post("/api/v1/fs/copy", {
        headers,
        data: { path: target, target: `/${folder}/copy.txt` },
      })
    ).ok(),
  ).toBe(true);
  const current = ActivityFileResponse.parse(
    await (await page.request.get(`/api/v1/activity/files/${id}`)).json(),
  );
  expect(current.currentPath).toBe(target);
  await page.goto(`/activity/files/${id}`);
  const history = page.locator('[data-slot="personal-activity"]');
  await expect(history.getByText("Renamed", { exact: true })).toBeVisible();
  await expect(history.getByText("Uploaded", { exact: true })).toBeVisible();
  await expect(history.getByText("Finding the current location…", { exact: true })).toHaveCount(0);
  await history.getByText("Related files", { exact: true }).click();
  await expect(history.getByRole("link", { name: /copy.txt/ })).toBeVisible();
  await page.reload();
  await expect(history.getByText("Uploaded", { exact: true })).toBeVisible();
  for (const width of [320, 393, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.classList.toggle("dark", value === "dark");
      }, theme);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
  }
  await history.getByRole("button", { name: /Export JSON/ }).click();
  const download = history.getByRole("link", { name: /Download export/ });
  await expect(download).toBeVisible();
  const exported = await (
    await page.request.get((await download.getAttribute("href")) as string)
  ).json();
  expect(exported.events.length).toBeGreaterThan(0);
  expect(
    exported.events.every(
      (event: { fileId: string; subjects: { fileId: string }[] }) =>
        event.fileId === id || event.subjects.some((subject) => subject.fileId === id),
    ),
  ).toBe(true);
  const foreign = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    baseURL: new URL(page.url()).origin,
  });
  try {
    expect(
      (
        await foreign.request.post("/api/v1/auth/login", {
          headers,
          data: { credential: { username: "bob", password: "bob-password" } },
        })
      ).ok(),
    ).toBe(true);
    expect((await foreign.request.get(`/api/v1/activity/files/${id}`)).status()).toBe(404);
    const other = PersonalActivityResponse.parse(
      await (await foreign.request.get(`/api/v1/activity?q=${folder}`)).json(),
    );
    expect(other.items).toEqual([]);
  } finally {
    await foreign.close();
  }
});

test("external disappearance and rediscovery preserve uncertainty and separate replacement identity", async ({
  page,
}) => {
  const root = process.env.E2E_SFTPGO_WEBDAV_URL;
  if (!root) throw Error("missing disposable SFTPGo WebDAV endpoint");
  const path = `/${uniqueName("outside-fdrive")}.txt`;
  const destination = `${path}.moved`;
  const headers = { "x-requested-with": "fdrive" };
  expect(
    (
      await page.request.put(`/api/v1/fs/upload?path=${encodeURIComponent(path)}`, {
        headers,
        data: Buffer.from("external change fixture"),
      })
    ).ok(),
  ).toBe(true);
  const feed = PersonalActivityResponse.parse(
    await (await page.request.get(`/api/v1/activity?q=${encodeURIComponent(path)}`)).json(),
  );
  const id = feed.items.find(
    (event) => event.action === "file.upload" && event.stage === "outcome",
  )?.fileId;
  expect(id).toBeTruthy();
  const base = root.endsWith("/") ? root : `${root}/`;
  async function externalMove(from: string, to: string) {
    const result = await page.request.fetch(new URL(from.slice(1), base).href, {
      method: "MOVE",
      headers: {
        authorization: `Basic ${Buffer.from("alice:alice-password").toString("base64")}`,
        destination: new URL(to.slice(1), base).href,
      },
    });
    expect(result.ok(), await result.text()).toBe(true);
  }
  await externalMove(path, destination);
  expect((await page.request.post(`/api/v1/activity/files/${id}/recheck`, { headers })).ok()).toBe(
    true,
  );
  const missing = PersonalActivityResponse.parse(
    await (await page.request.get(`/api/v1/activity/files/${id}/events`)).json(),
  );
  expect(missing.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: "observation.location_missing",
        actorAccountId: null,
        occurredAt: null,
      }),
    ]),
  );
  expect(JSON.stringify(missing)).not.toContain(destination);
  await externalMove(destination, path);
  expect((await page.request.post(`/api/v1/activity/files/${id}/recheck`, { headers })).ok()).toBe(
    true,
  );
  const resolved = PersonalActivityResponse.parse(
    await (await page.request.get(`/api/v1/activity/files/${id}/events`)).json(),
  ).items.find((event) => event.action === "observation.resolved");
  const replacement = resolved?.subjects.find((subject) => subject.role === "target")?.fileId;
  expect(replacement).toBeTruthy();
  expect(replacement).not.toBe(id);
  expect(resolved?.actorAccountId).toBeNull();
  const original = ActivityFileResponse.parse(
    await (await page.request.get(`/api/v1/activity/files/${id}`)).json(),
  );
  expect(original).toMatchObject({ currentPath: null, availability: "unknown" });
  await page.goto(`/activity/files/${id}`);
  await expect(page.getByText(/Whether this is the earlier file remains unknown/)).toBeVisible();
});
