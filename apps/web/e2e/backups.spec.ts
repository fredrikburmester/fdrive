import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { Client } from "pg";
import { type RunningEnvironment, startEnvironment } from "./support/environment.js";
import { getFreePort } from "./support/ports.js";

/** The sheet's tabs, in order. Everything but its header and footer sits on one of them. */
const TABS = ["Overview", "Destinations", "History", "Recovery"] as const;

function tab(page: Page, name: (typeof TABS)[number]) {
  return page
    .getByRole("group", { name: "Backup sections" })
    .getByRole("button", { name, exact: true });
}

/** The status badges under the sheet's title. */
function badges(page: Page) {
  return page.locator('[data-slot="detail-sheet-badges"]');
}

test.describe("installation backups", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  let environment: RunningEnvironment;
  let directory: string;
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    directory = await mkdtemp(join(tmpdir(), "fdrive-backup-browser-"));
    environment = await startEnvironment({
      apiPort: await getFreePort("127.0.0.1"),
      webPort: await getFreePort("127.0.0.1"),
      skipStatePersist: true,
      extraApiEnv: { FDRIVE_BACKUP_STATE_DIR: directory, FDRIVE_BACKUP_WORKER: "true" },
    });
  });
  test.afterAll(async () => {
    await environment?.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  test("owner saves a key, downloads a verified snapshot and is offered bucket destinations only, on desktop and mobile", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.goto(`${environment.webBaseUrl}/login`);
    await page.getByLabel("Username").fill("alice");
    await page.getByLabel("Password").fill("alice-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/(files|setup)$/);
    const me = (await (
      await page.request.get(`${environment.webBaseUrl}/api/v1/auth/me`)
    ).json()) as { account: { id: string } };
    const db = new Client({ connectionString: environment.databaseUrl });
    await db.connect();
    let storageId: unknown;
    try {
      await db.query("insert into app.settings(key,value) values('setup.owner.v1',$1)", [
        JSON.stringify({ state: "complete", accountId: me.account.id }),
      ]);
      storageId = (await db.query("select value from app.settings where key='storage.id'")).rows;
    } finally {
      await db.end();
    }
    const features = await (
      await page.request.get(`${environment.webBaseUrl}/api/v1/system/features`)
    ).json();
    expect(
      (
        await page.request.put(`${environment.webBaseUrl}/api/v1/system/features`, {
          headers: { "x-requested-with": "fdrive" },
          data: {
            revision: features.configuration.revision,
            values: features.configuration.values,
            walkthroughComplete: true,
          },
        })
      ).ok(),
    ).toBe(true);
    await page.goto(`${environment.webBaseUrl}/system/backups`);
    // Locked until the owner's password is confirmed: the header says so and holds the one action.
    await expect(badges(page).getByText("Locked", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Back up now", exact: true })).toBeDisabled();
    await page.getByLabel("Current password").fill("alice-password");
    await page.getByRole("button", { name: "Unlock backups" }).click();
    await expect(badges(page).getByText("Unlocked", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Current password")).toHaveCount(0);
    await tab(page, "Recovery").click();
    const keyDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Create and download recovery key" }).click();
    const downloaded = await keyDownload;
    const keyPath = await downloaded.path();
    if (!keyPath) throw Error("No recovery kit downloaded");
    const kit = await readFile(keyPath, "utf8");
    expect(kit).toContain("AGE-SECRET-KEY-");
    await page.getByLabel("Paste the saved recovery key to confirm").fill(kit);
    await page.getByRole("button", { name: "Confirm saved key" }).click();
    await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();
    // Configuration ZIPs are gone.
    await expect(page.getByText("Additional configuration files")).toHaveCount(0);
    await tab(page, "History").click();
    await page.getByRole("button", { name: "Prepare local download" }).click();
    const download = page.getByRole("button", { name: "Download backup" }).first();
    await expect(download).toBeVisible({ timeout: 30_000 });
    const archiveDownload = page.waitForEvent("download");
    await download.click();
    const archive = await archiveDownload;
    const archivePath = await archive.path();
    if (!archivePath) throw Error("No archive downloaded");
    expect((await readFile(archivePath)).subarray(0, 22).toString()).toContain(
      "age-encryption.org",
    );
    // Everything else a backup offers is in the menu at the end of its row.
    await page
      .getByRole("button", { name: /^Actions for the backup from / })
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Verify bytes" }).click();
    await expect(page.getByText(/Bytes verified/).first()).toBeVisible({ timeout: 20_000 });
    // A destination is a bucket: the form asks for one and offers no folder in the files folder.
    await tab(page, "Destinations").click();
    await page.getByRole("button", { name: "Add destination" }).click();
    await expect(page.getByLabel("S3 endpoint")).toBeVisible();
    await expect(page.getByLabel("Destination type")).toHaveCount(0);
    await expect(page.getByLabel("Private backup directory")).toHaveCount(0);
    await page.getByLabel("Secret access key").scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("backups-destination-form.png") });
    // The form takes the tab over until it is saved or cancelled.
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByLabel("S3 endpoint")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add destination" })).toBeVisible();
    await page.getByRole("button", { name: "Back up now", exact: true }).click();
    // Both backups complete; daily retention keeps only the newer local archive.
    await expect
      .poll(
        async () =>
          (
            (await (
              await page.request.get(`${environment.webBaseUrl}/api/v1/system/backups`)
            ).json()) as { runs: { state: string }[] }
          ).runs.filter((run) => run.state === "complete").length,
        { timeout: 30_000 },
      )
      .toBe(2);
    // Health: a size estimate runs through the worker, and an owner-recorded rehearsal report
    // replaces the monthly reminder.
    await tab(page, "Overview").click();
    await expect(page.getByText(/Restore rehearsal due/)).toBeVisible();
    await expect(badges(page).getByText("Needs attention", { exact: true })).toBeVisible();
    await tab(page, "Destinations").click();
    await page.getByRole("button", { name: "Estimate backup size" }).click();
    await expect(page.getByText(/^Estimated /)).toBeVisible({ timeout: 60_000 });
    const backups = (await (
      await page.request.get(`${environment.webBaseUrl}/api/v1/system/backups`)
    ).json()) as { installationId: string; runs: { id: string; state: string }[] };
    const completed = backups.runs.find((run) => run.state === "complete");
    if (!completed) throw Error("Expected a complete run for the rehearsal report");
    await tab(page, "Recovery").click();
    await page.getByLabel("Rehearsal report (.json)").setInputFiles({
      name: "rehearsal.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          sourceInstallationId: backups.installationId,
          snapshotId: completed.id,
          completedAt: new Date().toISOString(),
          migrations: [],
          tableCount: 29,
          blobCount: 0,
          result: "passed",
        }),
      ),
    });
    await expect(page.getByText(/Last successful rehearsal/)).toBeVisible();
    await expect(badges(page).getByText("Last rehearsal passed", { exact: true })).toBeVisible();
    await tab(page, "Overview").click();
    await expect(page.getByText(/Restore rehearsal due/)).toHaveCount(0);
    await expect(badges(page).getByText("Healthy", { exact: true })).toBeVisible();
    for (const width of [320, 390, 768, 1280])
      for (const colorScheme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ colorScheme });
        await expect(page.getByRole("heading", { name: "Backups", exact: true })).toBeVisible();
        for (const name of TABS) {
          await tab(page, name).click();
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ).toBe(true);
          expect(
            await page
              .locator("main [data-slot=page-section]")
              .evaluateAll(
                (sections) =>
                  sections.length > 0 &&
                  sections.every((section) => section.scrollWidth <= section.clientWidth + 1),
              ),
          ).toBe(true);
        }
      }
    await tab(page, "Overview").click();
    await page.screenshot({
      path: test.info().outputPath("backups-desktop-dark.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.screenshot({
      path: test.info().outputPath("backups-mobile-light.png"),
      fullPage: true,
    });
    for (const name of TABS) {
      await tab(page, name).click();
      await expect
        .poll(() =>
          page.locator("main [data-slot=button]").evaluateAll((buttons) =>
            buttons
              .filter(
                (button) =>
                  button.getBoundingClientRect().height > 0 &&
                  button.getBoundingClientRect().height < 43.99,
              )
              .map((button) => ({
                text: button.textContent,
                height: button.getBoundingClientRect().height,
                classes: button.className,
              })),
          ),
        )
        .toEqual([]);
    }
    await tab(page, "History").click();
    await page.getByRole("button", { name: "Download backup" }).last().scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("backups-mobile-history.png"),
      fullPage: true,
    });
    const recoveredDirectory = await mkdtemp(join(tmpdir(), "fdrive-browser-restore-"));
    const recovery = await startEnvironment({
      apiPort: await getFreePort("127.0.0.1"),
      webPort: await getFreePort("127.0.0.1"),
      skipStatePersist: true,
      // A restore needs an empty database: the backup brings the users along.
      createUsers: false,
      extraApiEnv: {
        FDRIVE_RESTORE_MODE: "true",
        FDRIVE_SETUP_TOKEN: "local-browser-recovery-token-123456",
        FDRIVE_BACKUP_STATE_DIR: recoveredDirectory,
      },
    });
    try {
      await page.goto(`${recovery.webBaseUrl}/restore`);
      await page.getByLabel("Host recovery token").fill("local-browser-recovery-token-123456");
      await page.getByRole("button", { name: "Connect to recovery" }).click();
      await page.getByLabel("Encrypted backup (.fdrive.age)").setInputFiles(archivePath);
      await page.getByRole("button", { name: "Upload backup" }).click();
      await page.getByLabel("Recovery key from your saved kit").fill(kit);
      await page.getByRole("button", { name: "Inspect backup" }).click();
      await expect(page.getByRole("heading", { name: "Recovery preview" })).toBeVisible({
        timeout: 30_000,
      });
      const status = await (
        await page.request.get(`${recovery.webBaseUrl}/api/v1/recovery/status`, {
          headers: {
            "x-fdrive-setup-token": "local-browser-recovery-token-123456",
            "x-requested-with": "fdrive",
          },
        })
      ).json();
      await page
        .getByLabel("Paste the snapshot ID to confirm this restore")
        .fill(status.job.preview.id);
      await page.screenshot({
        path: test.info().outputPath("restore-mobile-light.png"),
        fullPage: true,
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.getByRole("button", { name: "Restore into empty installation" }).click();
      await expect(page.getByText(/Restore is staged/)).toBeVisible({ timeout: 30_000 });
      const restoredDb = new Client({ connectionString: recovery.databaseUrl });
      await restoredDb.connect();
      try {
        expect(
          (await restoredDb.query("select restored from app.backup_configuration")).rows[0]
            .restored,
        ).toBe(true);
        // The files folder keeps its id, so paired Macs still recognise their locations.
        expect(
          (await restoredDb.query("select value from app.settings where key='storage.id'")).rows,
        ).toEqual(storageId);
      } finally {
        await restoredDb.end();
      }
    } finally {
      await recovery.stop();
      await rm(recoveredDirectory, { recursive: true, force: true });
    }
  });
});
