import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityFileResponse, PersonalActivityResponse } from "@fdrive/contracts";
import { expect, test } from "@playwright/test";
import { dismissActivityPanel } from "./support/activity.js";
import { homePath, journalOutsideChange } from "./support/local-folder.js";
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
  await page.goto(`/view/${folder}/renamed.txt`);
  await page.getByRole("button", { name: "Info" }).click();
  const activity = page.getByRole("region", { name: "Activity" });
  await expect(activity.getByText("Renamed", { exact: true })).toBeVisible();
  await expect(activity.getByText(`From ${name}`, { exact: true })).toBeVisible();
  await expect(activity.getByText("Uploaded", { exact: true })).toBeVisible();
  // Finished archive jobs from earlier specs reopen the Activity panel on this
  // fresh load, over the Info panel's lower half where See all sits.
  await dismissActivityPanel(page);
  await activity.getByRole("button", { name: "See all" }).click();
  await expect(page).toHaveURL(new RegExp(`/activity/files/${id}$`));
  const history = page.locator('[data-slot="personal-activity"]');
  await expect(history.getByText("Renamed", { exact: true })).toBeVisible();
  await expect(history.getByText("Uploaded", { exact: true })).toBeVisible();
  await expect(history.getByText("Finding the current location…", { exact: true })).toHaveCount(0);
  // The journey is a table of rows under the day they happened on. Choosing a row docks what
  // was recorded about it in a sheet beside the table, and Escape closes the sheet again.
  await expect(page.getByRole("heading", { name: "File journey", exact: true })).toBeVisible();
  await expect(history.locator('[data-slot="table-group-row"]').first()).toContainText("Today");
  await expect(history.getByRole("columnheader", { name: "Action", exact: true })).toBeVisible();
  // Exact, since other rows name the file, and its name holds the same word.
  const renamedRow = history
    .locator('[data-slot="activity-row"]')
    .filter({ has: page.getByText("Renamed", { exact: true }) });
  await expect(renamedRow).toHaveAttribute("aria-selected", "false");
  // The row's action, not its middle: the item's name there is a link that opens the file.
  await renamedRow.getByText("Renamed", { exact: true }).click();
  await expect(renamedRow).toHaveAttribute("aria-selected", "true");
  const eventSheet = history.getByRole("region", { name: "Renamed", exact: true });
  await expect(eventSheet).toContainText(path);
  await expect(
    eventSheet.getByRole("button", { name: "Show in folder", exact: true }),
  ).toBeEnabled();
  // Nothing opened in place: the table holds only its day rows and its events, and the page
  // still fits its window.
  await expect(
    history.locator('tbody tr:not([data-slot="activity-row"]):not([data-slot="table-group-row"])'),
  ).toHaveCount(0);
  await expect(history.locator("details")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.keyboard.press("Escape");
  await expect(eventSheet).toHaveCount(0);
  await expect(renamedRow).toHaveAttribute("aria-selected", "false");
  await expect(renamedRow).toBeFocused();
  // The file's related files and revision records are in a sheet of its own.
  await history.getByRole("button", { name: "File details", exact: true }).click();
  const fileSheet = history.getByRole("region", { name: "renamed.txt", exact: true });
  await expect(fileSheet.getByRole("link", { name: /copy.txt/ })).toBeVisible();
  await fileSheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(fileSheet).toHaveCount(0);
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
          data: { username: "bob", password: "bob-password" },
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

test("an outside disappearance and rediscovery the watcher journals keep uncertainty and a separate replacement identity", async ({
  page,
}) => {
  const path = `/${uniqueName("outside-fdrive")}.txt`;
  const away = join(tmpdir(), uniqueName("away"));
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
  const journey = async () =>
    PersonalActivityResponse.parse(
      await (await page.request.get(`/api/v1/activity/files/${id}/events`)).json(),
    );
  // A writer outside fdrive (the host, rsync) moves the file out of the files
  // folder, and the indexer's watcher journals it.
  await rename(homePath("alice", path), away);
  await journalOutsideChange("alice", path);
  await expect
    .poll(async () => (await journey()).items.map((event) => event.action))
    .toContain("observation.location_missing");
  const missing = await journey();
  expect(missing.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: "observation.location_missing",
        actorAccountId: null,
        occurredAt: null,
      }),
    ]),
  );
  expect(JSON.stringify(missing)).not.toContain(away);
  await rename(away, homePath("alice", path));
  await journalOutsideChange("alice", path);
  await expect
    .poll(async () => (await journey()).items.map((event) => event.action))
    .toContain("observation.resolved");
  const resolved = (await journey()).items.find((event) => event.action === "observation.resolved");
  const replacement = resolved?.subjects.find((subject) => subject.role === "target")?.fileId;
  expect(replacement).toBeTruthy();
  expect(replacement).not.toBe(id);
  expect(resolved?.actorAccountId).toBeNull();
  const original = ActivityFileResponse.parse(
    await (await page.request.get(`/api/v1/activity/files/${id}`)).json(),
  );
  expect(original).toMatchObject({ currentPath: null, availability: "unknown", label: "alice" });
  await page.goto(`/activity/files/${id}`);
  await expect(page.getByText(/Whether this is the earlier file remains unknown/)).toBeVisible();
  await expect(page.getByText(/^alice · Revision records describe changes/)).toBeVisible();
});
