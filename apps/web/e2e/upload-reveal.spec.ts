import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { listing } from "./support/regions.js";
import { uniqueName } from "./support/unique.js";
import { uploadFiles } from "./support/upload.js";

async function seedFolder(page: Page): Promise<string> {
  const path = `/${uniqueName("upload-reveal")}`;
  const created = await page.request.post("/api/v1/fs/mkdir", {
    data: { path },
    headers: { "x-requested-with": "fdrive" },
  });
  expect(created.ok(), await created.text()).toBe(true);
  for (let offset = 0; offset < 80; offset += 4) {
    await Promise.all(
      Array.from({ length: 4 }, async (_, i) => {
        const name = `item-${String(offset + i).padStart(2, "0")}.txt`;
        const response = await page.request.put(
          `/api/v1/fs/upload?path=${encodeURIComponent(`${path}/${name}`)}`,
          { data: name.repeat(offset + i + 1), headers: { "x-requested-with": "fdrive" } },
        );
        expect(response.ok(), await response.text()).toBe(true);
      }),
    );
  }
  await page.goto(`/files${path}`);
  await expect(listing(page).getByText("item-00.txt", { exact: true })).toBeVisible();
  return path;
}

async function dropFiles(page: Page, names: string[]): Promise<void> {
  const dataTransfer = await page.evaluateHandle((fileNames) => {
    const transfer = new DataTransfer();
    for (const name of fileNames) transfer.items.add(new File([name], name));
    return transfer;
  }, names);
  await listing(page).dispatchEvent("drop", { dataTransfer });
  await dataTransfer.dispose();
}

async function scrollToTop(page: Page): Promise<void> {
  await page
    .locator('[data-slot="file-list"], [data-slot="file-grid"] > .overflow-auto')
    .evaluate((el) => {
      el.scrollTop = 0;
    });
}

for (const mode of ["List", "Grid", "Tree"] as const) {
  test(`${mode}: dropped file scrolls into view; next batch selects all uploaded files`, async ({
    page,
  }) => {
    const path = await seedFolder(page);
    await page.getByRole("button", { name: "View", exact: true }).click();
    await page.getByRole("menuitemradio", { name: mode }).click();

    await dropFiles(page, ["z-single.txt"]);
    const single = listing(page).locator(`[data-path="${path}/z-single.txt"]`);
    await expect(single).toBeInViewport();
    await expect(single).toHaveAttribute("data-selected", "true");
    await expect(page.locator("header").getByText("1 selected", { exact: true })).toBeVisible();

    await scrollToTop(page);
    await expect(single).not.toBeInViewport();
    await uploadFiles(page, [
      { name: "a-batch.txt", mimeType: "text/plain", contents: "first" },
      { name: "z-batch.txt", mimeType: "text/plain", contents: "last" },
    ]);
    const last = listing(page).locator(`[data-path="${path}/z-batch.txt"]`);
    await expect(page.locator("header").getByText("2 selected", { exact: true })).toBeVisible();
    await expect(last).toBeInViewport();
    await expect(last).toHaveAttribute("data-selected", "true");
    await expect(single).toHaveAttribute("data-selected", "false");
    await scrollToTop(page);
    const first = listing(page).locator(`[data-path="${path}/a-batch.txt"]`);
    await expect(first).toBeInViewport();
    await expect(first).toHaveAttribute("data-selected", "true");
    await expect(last).not.toBeInViewport();
  });
}

test("a directory upload refreshes and selects its containing folder", async ({ page }) => {
  const path = await seedFolder(page);
  const temporary = await mkdtemp(join(tmpdir(), "fdrive-upload-reveal-"));
  const folder = join(temporary, "uploaded-folder");
  try {
    await mkdir(join(folder, "nested"), { recursive: true });
    await writeFile(join(folder, "a.txt"), "first");
    await writeFile(join(folder, "nested", "b.txt"), "second");
    await page.locator('input[type="file"][webkitdirectory]').setInputFiles(folder);
    const row = listing(page).locator(`[data-path="${path}/uploaded-folder"]`);
    await expect(row).toBeInViewport();
    await expect(row).toHaveAttribute("data-selected", "true");
    await expect(page.locator("header").getByText("1 selected", { exact: true })).toBeVisible();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("replacement waits for refreshed size sort before revealing the file", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("fdrive.sort", JSON.stringify({ key: "size", direction: "asc" })),
  );
  // Exercise upload completion independently of live filesystem events.
  await page.route("**/api/v1/events*", (route) => route.abort());
  const path = await seedFolder(page);
  const target = listing(page).locator(`[data-path="${path}/item-00.txt"]`);
  let hold = false;
  let blocked = false;
  const gate = Promise.withResolvers<void>();
  await page.route(
    (url) => url.pathname === "/api/v1/fs/list" && url.searchParams.get("path") === path,
    async (route) => {
      if (hold) {
        blocked = true;
        await gate.promise;
      }
      await route.continue();
    },
  );
  await page.route(
    (url) => url.pathname === "/api/v1/fs/upload",
    async (route) => {
      hold = true;
      await route.continue();
    },
  );
  try {
    await uploadFiles(page, [
      { name: "item-00.txt", mimeType: "text/plain", contents: "replacement".repeat(1000) },
    ]);
    await page.getByRole("dialog").getByRole("button", { name: "Replace", exact: true }).click();
    await expect(page.getByRole("button", { name: "1 uploaded", exact: true })).toBeVisible();
    await expect.poll(() => blocked).toBe(true);
    await expect(target).toHaveAttribute("data-selected", "false");
    gate.resolve();
    await expect(target.getByText("11 B", { exact: true })).toHaveCount(0);
    await expect(target).toBeInViewport();
    await expect(target).toHaveAttribute("data-selected", "true");
  } finally {
    gate.resolve();
  }
});

test("a successful retry selects and reveals the uploaded file", async ({ page }) => {
  const path = await seedFolder(page);
  let attempts = 0;
  await page.route(
    (url) => url.pathname === "/api/v1/fs/upload",
    async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({ status: 503, body: "Temporary upload failure" });
      } else {
        await route.continue();
      }
    },
  );
  await dropFiles(page, ["z-retry.txt"]);
  await page.getByRole("button", { name: "0 uploaded, 1 failed", exact: true }).click();
  await page.getByRole("button", { name: "Retry upload", exact: true }).click();
  const target = listing(page).locator(`[data-path="${path}/z-retry.txt"]`);
  await expect(target).toBeInViewport();
  await expect(target).toHaveAttribute("data-selected", "true");
  expect(attempts).toBe(2);
});
