import { SystemIndexerResponse } from "@fdrive/contracts";
import { expect, type Page, test } from "@playwright/test";
import { loginAs } from "./support/login.js";

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

test("alice (admin) sees the env-managed provider on System > Storage and can change its home template", async ({
  page,
}) => {
  await page.goto("/files");

  await expect(page.getByRole("link", { name: "Storage" })).toBeVisible();
  await page.getByRole("link", { name: "Storage" }).click();
  await expect(page).toHaveURL(/\/system\/storage$/);

  // The seeded provider is pinned by SFTPGO_URL, so it reports the
  // environment as its source and refuses both address edits and removal.
  const card = page
    .getByRole("main")
    .locator('[data-slot="card"]')
    .filter({ hasText: "Environment (locked)" });
  await expect(card.getByText("Reachable", { exact: true })).toBeVisible();
  await expect(card.getByText("Environment (locked)", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: /^Remove / })).toBeDisabled();

  await card.getByRole("button", { name: /^Edit / }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Address")).toBeDisabled();

  const originalTemplate = await dialog.getByLabel("Home template").inputValue();
  const updatedTemplate = "sftpgo:/updated/{username}";
  await dialog.getByLabel("Home template").fill(updatedTemplate);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();

  await page.reload();
  await page.getByRole("button", { name: /^Edit / }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Home template")).toHaveValue(updatedTemplate);

  // Restore the original template so this test stays idempotent across
  // repeated local runs against the same environment.
  await dialog.getByLabel("Home template").fill(originalTemplate);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();

  // The connection card moved off General with the rest of the storage
  // settings; only a pointer to this page is left there.
  await page.goto("/system/general");
  await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
  await expect(page.getByText("SFTPGo connection")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Storage" }).first()).toBeVisible();
});

test("the retired /system/connection route redirects to General", async ({ page }) => {
  await page.goto("/system/connection");

  await expect(page).toHaveURL(/\/system\/general$/);
  await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
});

test("alice (admin) sees the Search embedding server and OCR as not configured in the e2e stack", async ({
  page,
}) => {
  await page.goto("/files");

  for (const label of ["Full-text search", "Semantic search", "Searchable PDFs", "Thumbnails"]) {
    await expect(page.getByRole("link", { name: label, exact: true })).toBeVisible();
  }

  // No embedding server or OCR sidecar runs in the e2e stack (unlike the
  // indexer, which `global-setup.ts` fakes; see the "configured and
  // reachable" tests below), so their own "not configured" state should
  // render rather than an error, naming exactly which variable to set.
  await page.getByRole("link", { name: "Semantic search", exact: true }).click();
  await expect(page).toHaveURL(/\/system\/search$/);
  await expect(page.getByText("Not configured", { exact: true })).toBeVisible();
  await expect(page.getByText("Not configured: set FDRIVE_EMBED_URL.")).toBeVisible();

  await page.getByRole("link", { name: "Searchable PDFs" }).click();
  await expect(page).toHaveURL(/\/system\/ocr$/);
  await expect(page.getByText("Not configured", { exact: true })).toBeVisible();
});

test("alice (admin) sees the Indexer page render the fake indexer's root, counts, last scan, and errors sample", async ({
  page,
}) => {
  await page.goto("/system/indexer");

  await expect(page.getByText("Reachable")).toBeVisible();

  // Counts by status: one row per (root, status) pair from the fake's
  // `GET /stats`, including the "indexed" row this bug's symptom curl showed.
  const indexedRow = page.getByRole("row", { name: /sftpgo/ }).filter({ hasText: "indexed" });
  await expect(indexedRow).toBeVisible();
  await expect(indexedRow.getByText("10", { exact: true })).toBeVisible();

  // Last scan.
  await expect(page.getByText("Last scan")).toBeVisible();
  await expect(page.getByText(/16 seen/)).toBeVisible();
  await expect(page.getByText(/0 changed/)).toBeVisible();
  await expect(page.getByText(/0 deleted/)).toBeVisible();

  // The error sample now lives in the Logs sheet rather than inline.
  await expect(page.getByText("Recent errors")).toHaveCount(0);
  await page.getByRole("button", { name: "Logs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "indexer log" })).toBeVisible();
});

test("alice (admin) can reindex the sftpgo root and sees a toast reporting how many files were marked", async ({
  page,
}) => {
  await page.goto("/system/indexer");

  await page.getByRole("button", { name: "Reindex" }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Reindex" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Re-extracts text and re-embeds/)).toBeVisible();

  await dialog.getByLabel("Root").click();
  await page.getByRole("option", { name: "sftpgo" }).click();
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

  // Root defaults to "All roots"; scope to the fake's one root and turn on
  // force to exercise every field this dialog now sends.
  await dialog.getByLabel("Root").click();
  await page.getByRole("option", { name: "sftpgo" }).click();
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
  expect((await request).postDataJSON()).toEqual({
    root: "sftpgo",
    path: "alice/docs",
    force: true,
  });
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
  await expect(page.getByText("Reachable")).toBeVisible();

  // The "Thumbnails" stat card: matched by its exact label so this hits neither
  // the page's own "Thumbnails" heading nor the Status card's prose.
  const thumbnailsCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText("Thumbnails", { exact: true }) });
  await expect(thumbnailsCard).toBeVisible();

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
  // bob is not in FDRIVE_ADMIN_USERS, so this spec logs in as bob itself
  // rather than reusing the alice storage state the "chromium" project
  // otherwise applies by default.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sees no System sidebar group and gets 403 from the admin connection and system routes", async ({
    page,
  }) => {
    await loginAs(page, "bob", "bob-password");

    await expect(page.getByText("Locations")).toBeVisible();
    await expect(page.getByText("System")).toBeHidden();
    await expect(page.getByRole("link", { name: "General" })).toBeHidden();
    await expect(page.getByRole("link", { name: "Indexer" })).toBeHidden();
    await expect(page.getByRole("link", { name: "Search", exact: true })).toBeHidden();
    await expect(page.getByRole("link", { name: "OCR" })).toBeHidden();
    await expect(page.getByRole("link", { name: "Thumbnails" })).toBeHidden();

    const connectionRes = await page.request.get("/api/v1/admin/providers");
    expect(connectionRes.status()).toBe(403);

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
});

for (const scope of ["index", "thumbnails"] as const) {
  test(`${scope} clear requires confirmation, submits scope, polls completion, and reports busy`, async ({
    page,
  }) => {
    const isIndex = scope === "index";
    const endpoint = isIndex ? "/api/v1/system/indexer/clear" : "/api/v1/system/thumbnails/clear";
    const trigger = isIndex ? "Clear index" : "Clear cache";
    const action = isIndex ? "Clear index" : "Clear cache";
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
    await page.getByRole("main").getByRole("button", { name: trigger, exact: true }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Original files/)).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(requests).toHaveLength(0);
    await page.getByRole("main").getByRole("button", { name: trigger, exact: true }).click();
    dialog = page.getByRole("dialog");
    if (isIndex) {
      await expect(dialog.getByLabel("Path (optional)")).toBeDisabled();
      await dialog.getByLabel("Root", { exact: true }).click();
      await page.getByRole("option", { name: "sftpgo" }).click();
      await dialog.getByLabel("Path (optional)").fill(" alice/docs ");
    }
    await dialog.getByRole("button", { name: action, exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(requests).toEqual([isIndex ? { root: "sftpgo", path: "alice/docs" } : {}]);
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
