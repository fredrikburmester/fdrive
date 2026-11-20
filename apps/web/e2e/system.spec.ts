import { SystemIndexerResponse } from "@fdrive/contracts";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { dismissActivityPanel } from "./support/activity.js";
import { loginAs } from "./support/login.js";
import { sidebar } from "./support/regions.js";

/** A named value in a sheet: the `dd` beside the `dt` with that label. */
function fact(scope: Locator, label: string): Locator {
  return scope.locator(`dt:text-is("${label}") + dd`);
}

/** The list of areas on the System page: General, Users, each feature, About. */
function systemAreas(page: Page): Locator {
  return page.getByRole("navigation", { name: "System areas" });
}

/**
 * Clicks a settings sheet's Save button by dispatching the click event
 * directly on the element rather than simulating a real pointer click.
 * Earlier specs in a full run can leave finished jobs in the account-wide
 * Activity panel (fixed bottom-right on every page), which can visually
 * overlap that bottom-right Save button; a real mouse click would
 * land on whichever element is topmost at that point, which is unrelated
 * to this page's own behaviour and not what this test means to exercise.
 */
async function clickSave(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Save", exact: true }).dispatchEvent("click");
}

test("alice (admin) finds the files folder under System > General", async ({ page }) => {
  await page.goto("/files");

  // System is one row in the sidebar. Its areas are listed on the System page itself, which
  // opens on the first of them.
  await expect(sidebar(page).getByRole("link", { name: "General" })).toHaveCount(0);
  await sidebar(page).getByRole("link", { name: "System", exact: true }).click();
  await expect(page).toHaveURL(/\/system$/);
  await expect(page.getByRole("heading", { level: 1, name: "General" })).toBeVisible();
  // The files folder is the only storage, so System has no Storage area.
  await expect(systemAreas(page).getByRole("link", { name: "Storage", exact: true })).toHaveCount(
    0,
  );
  await systemAreas(page).getByRole("link", { name: "General", exact: true }).click();
  await expect(page).toHaveURL(/\/system\/general$/);
  await expect(page.getByText("Folder on this server, set by FDRIVE_STORAGE_ROOT.")).toBeVisible();
});

test("alice (admin) sees every System area in order, with General first and About last", async ({
  page,
}) => {
  await page.goto("/system");

  await expect(systemAreas(page).getByRole("link")).toHaveText([
    /^General/,
    /^Users/,
    /^Backups/,
    /^Thumbnails/,
    /^Full-text search/,
    /^Semantic search/,
    /^Searchable PDFs/,
    /^Image search/,
    /^Office/,
    /^AI/,
    /^About/,
  ]);
  // The Features page is gone: each feature is switched in its own area.
  await expect(systemAreas(page).getByRole("link", { name: "Features" })).toHaveCount(0);
  await expect(
    systemAreas(page).getByRole("link", { name: "General", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

test("alice (admin) sees the Search embedding server and OCR as not configured in the e2e stack", async ({
  page,
}) => {
  await page.goto("/system");

  for (const label of ["Full-text search", "Semantic search", "Searchable PDFs", "Thumbnails"]) {
    await expect(systemAreas(page).getByRole("link", { name: label, exact: true })).toBeVisible();
  }

  // No embedding server or OCR sidecar runs in the e2e stack (unlike the
  // indexer, which `global-setup.ts` fakes; see the "configured and
  // reachable" tests below), so their own "not configured" state should
  // render rather than an error, naming exactly which variable to set.
  await systemAreas(page).getByRole("link", { name: "Semantic search", exact: true }).click();
  await expect(page).toHaveURL(/\/system\/search$/);
  await expect(page.getByText("Not configured", { exact: true })).toBeVisible();
  await expect(page.getByText("Not configured: set FDRIVE_ML_URL.")).toBeVisible();

  await systemAreas(page).getByRole("link", { name: "Searchable PDFs", exact: true }).click();
  await expect(page).toHaveURL(/\/system\/ocr$/);
  await expect(page.getByText("Not configured", { exact: true })).toBeVisible();
});

test("alice (admin) sees the Indexer page render the fake indexer's watcher, counts, last scan, and errors sample", async ({
  page,
}) => {
  await page.goto("/system/indexer");
  const sheet = page.getByRole("region", { name: "Full-text search", exact: true });

  await expect(sheet.getByText("Reachable", { exact: true })).toBeVisible();
  await expect(sheet.getByText("Watcher on", { exact: true })).toBeVisible();

  // Files by status: one bar per status from the fake's `GET /stats`,
  // including the "indexed" count this bug's symptom curl showed.
  const indexedBar = sheet.locator('[data-slot="bar-list"] li').filter({ hasText: /^Indexed/ });
  await expect(indexedBar).toBeVisible();
  await expect(indexedBar.getByText("10", { exact: true })).toBeVisible();

  // Last scan, as named values.
  await expect(sheet.getByRole("heading", { name: "Last scan" })).toBeVisible();
  await expect(fact(sheet, "Seen")).toHaveText("16");
  await expect(fact(sheet, "Changed")).toHaveText("0");
  await expect(fact(sheet, "Deleted")).toHaveText("0");

  // The error sample now lives in the Logs sheet rather than inline.
  await expect(page.getByText("Recent errors")).toHaveCount(0);
  await page.getByRole("button", { name: "Logs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "indexer log" })).toBeVisible();
});

test("alice (admin) can reindex the files folder and sees a toast reporting how many files were marked", async ({
  page,
}) => {
  await page.goto("/system/indexer");

  await page.getByRole("button", { name: "Reindex" }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Reindex" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Re-extracts text and re-embeds/)).toBeVisible();

  await expect(dialog.getByRole("checkbox")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Reindex", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "Marked 3 files for reindex." }),
  ).toBeVisible();
});

test("alice (admin) can rebuild scoped thumbnails from the Thumbnails page with the honest, thumbnail-only dialog", async ({
  page,
}) => {
  await page.goto("/system/thumbnails");

  await page.getByRole("button", { name: "Rebuild" }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Rebuild thumbnails" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(/Regenerates preview images for photos, PDFs, and videos/),
  ).toBeVisible();
  await expect(dialog.getByText(/Text and search data are not touched/)).toBeVisible();

  // Scope to a folder and turn on force to exercise every field this dialog sends.
  await dialog.getByLabel("Path (optional)").fill(" alice/docs ");
  await dialog.getByRole("switch", { name: "Regenerate existing thumbnails" }).click();

  const request = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/v1/system/indexer/thumbnails/rebuild") &&
      request.method() === "POST",
  );
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/system/indexer/thumbnails/rebuild") &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Rebuild", exact: true }).click();
  expect((await request).postDataJSON()).toEqual({ path: "alice/docs", force: true });
  expect((await response).status()).toBe(202);
  await expect(dialog).toBeHidden();
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "Rebuilding 6 thumbnails…" }),
  ).toBeVisible();
});

test("alice (admin) sees the Thumbnails page's count and can rebuild via the fake indexer", async ({
  page,
}) => {
  await page.goto("/system/thumbnails");

  await expect(page.getByText("Loading…")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText("Reachable", { exact: true })).toBeVisible();

  // The "Thumbnails" stat: matched by its exact label so this hits neither
  // the page's own "Thumbnails" heading nor the Status section's prose.
  const thumbnailsStat = page
    .locator('[data-slot="stat"]')
    .filter({ has: page.getByText("Thumbnails", { exact: true }) });
  await expect(thumbnailsStat).toBeVisible();

  await page.getByRole("button", { name: "Rebuild" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/system/indexer/thumbnails/rebuild") &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Rebuild", exact: true }).click();

  expect((await response).status()).toBe(202);
  await expect(dialog).toBeHidden();
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "Rebuilding 6 thumbnails…" }),
  ).toBeVisible();
});

test("alice (admin) can save the indexer's settings even while the indexer sidecar is unreachable", async ({
  page,
}) => {
  await page.goto("/system/indexer");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const workersInput = page.getByLabel("Workers");
  await expect(workersInput).toBeVisible();
  const originalWorkers = await workersInput.inputValue();
  const updatedWorkers = "7";

  await workersInput.fill(updatedWorkers);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await clickSave(page);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Workers")).toHaveValue(updatedWorkers);

  // Restore the original value so this test stays idempotent across
  // repeated local runs against the same environment.
  await page.getByLabel("Workers").fill(originalWorkers);
  await clickSave(page);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});

test.describe("bob (not admin)", () => {
  // bob holds no administrator account, so this spec logs in as bob itself
  // rather than reusing the alice storage state the "chromium" project
  // otherwise applies by default.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sees no System row in the sidebar and gets 403 from the admin connection and system routes", async ({
    page,
  }) => {
    await loginAs(page, "bob", "bob-password");

    await expect(page.getByText("Locations")).toBeVisible();
    await expect(sidebar(page).getByRole("link", { name: "System", exact: true })).toHaveCount(0);
    await expect(page.getByText("System")).toBeHidden();
    await expect(page.getByRole("link", { name: "General" })).toBeHidden();
    await expect(page.getByRole("link", { name: "Indexer" })).toBeHidden();
    await expect(page.getByRole("link", { name: "Search", exact: true })).toBeHidden();
    await expect(page.getByRole("link", { name: "OCR" })).toBeHidden();
    await expect(page.getByRole("link", { name: "Thumbnails" })).toBeHidden();

    await expect(page.getByRole("link", { name: "Users" })).toBeHidden();

    expect((await page.request.get("/api/v1/system/storage")).status()).toBe(403);
    expect((await page.request.get("/api/v1/admin/users")).status()).toBe(403);

    for (const path of [
      "/api/v1/system/indexer",
      "/api/v1/system/search",
      "/api/v1/system/ocr",
      "/api/v1/system/thumbnails",
    ]) {
      const res = await page.request.get(path);
      expect(res.status()).toBe(403);
    }
  });

  test("is sent back to /files when typing a System page's address directly", async ({ page }) => {
    await loginAs(page, "bob", "bob-password");

    for (const path of [
      "/system",
      "/system/general",
      "/system/features",
      "/system/users",
      "/system/about",
    ]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/files$/);
      await expect(page.getByRole("heading", { name: "General" })).toHaveCount(0);
      await expect(page.getByText("Administrators only")).toHaveCount(0);
    }
  });
});

for (const scope of ["index", "thumbnails"] as const) {
  test(`${scope} clear requires confirmation, submits scope, polls completion, and reports busy`, async ({
    page,
  }) => {
    const isIndex = scope === "index";
    const endpoint = isIndex ? "/api/v1/system/indexer/clear" : "/api/v1/system/thumbnails/clear";
    // The destructive action sits at the far end of the sheet's footer, and its dialog confirms
    // with the same words.
    const trigger = isIndex ? "Clear index" : "Clear thumbnails";
    const action = trigger;
    const progressKey = isIndex ? "indexClear" : "thumbnailClear";
    let started = false;
    let completed = false;
    let rejectBusy = false;
    const requests: unknown[] = [];
    await page.route(`**${endpoint}`, async (route) => {
      requests.push(route.request().postDataJSON());
      if (rejectBusy) {
        await route.fulfill({
          status: 409,
          json: { error: { kind: "conflict", message: "A maintenance job is already running." } },
        });
        return;
      }
      started = true;
      await route.fulfill({ status: 202, json: { started: true } });
    });
    await page.route("**/api/v1/system/indexer", async (route) => {
      const response = await route.fetch();
      const json = SystemIndexerResponse.parse(await response.json());
      if (started && json.stats !== undefined)
        json.stats[progressKey] = {
          running: !completed,
          processed: completed ? 4 : 2,
          total: 4,
          startedAt: "2026-09-06T12:00:00Z",
          finishedAt: completed ? "2026-09-06T12:01:00Z" : null,
          errors: completed ? 1 : 0,
        };
      await route.fulfill({ response, json });
    });
    await page.goto(isIndex ? "/system/indexer" : "/system/thumbnails");
    // The footer's far end is where the Activity panel sits; earlier specs can leave it open.
    await expect(
      page.getByRole("main").getByRole("button", { name: trigger, exact: true }),
    ).toBeEnabled();
    await dismissActivityPanel(page);
    await page.getByRole("main").getByRole("button", { name: trigger, exact: true }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Original files/)).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(requests).toHaveLength(0);
    await page.getByRole("main").getByRole("button", { name: trigger, exact: true }).click();
    dialog = page.getByRole("dialog");
    if (isIndex) {
      await dialog.getByLabel("Path (optional)").fill(" alice/docs ");
    }
    await dialog.getByRole("button", { name: action, exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(requests).toEqual([isIndex ? { path: "alice/docs" } : {}]);
    await expect(page.getByText("Running · 2 of 4 processed · 0 errors")).toBeVisible();
    await expect(
      page.getByRole("main").getByRole("button", { name: trigger, exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: isIndex ? "Reindex" : "Rebuild" }),
    ).toBeDisabled();
    completed = true;
    await expect(page.getByText("Completed with errors · 4 of 4 processed · 1 errors")).toBeVisible(
      { timeout: 10_000 },
    );
    await expect(
      page.getByRole("main").getByRole("button", { name: trigger, exact: true }),
    ).toBeEnabled();
    rejectBusy = true;
    await page.getByRole("main").getByRole("button", { name: trigger, exact: true }).click();
    await dialog.getByRole("button", { name: action, exact: true }).click();
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "A maintenance job is already running." }),
    ).toBeVisible();
    await expect(dialog).toBeVisible();
  });
}
