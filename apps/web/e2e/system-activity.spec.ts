import { SystemActivityId, type SystemActivityItem } from "@fdrive/contracts";
import { expect, test } from "@playwright/test";
import { loginAs } from "./support/login.js";

test("system activity shows on the sidebar's System row and on each area's row, survives navigation and reload, supports keyboard details and reduced motion", async ({
  page,
}) => {
  test.setTimeout(60000);
  let percent = 63;
  let running = true;
  let offline = false;
  await page.route("**/api/v1/system/activity", async (route) => {
    if (offline) return route.fulfill({ status: 503, json: { error: "unavailable" } });
    const items: SystemActivityItem[] = SystemActivityId.options.map((id) => ({
      id,
      state: running && ["features", "thumbnails", "pdfOcr"].includes(id) ? "working" : "idle",
      percent: id === "thumbnails" && running ? percent : null,
      warning: false,
      detail:
        id === "pdfOcr"
          ? "Making PDFs searchable: 12 files processed"
          : `Rebuilding previews: ${percent} of 100 files processed`,
      operationIds: running ? ["worker:job"] : [],
    }));
    return route.fulfill({ json: { observedAt: new Date().toISOString(), items } });
  });
  await page.goto("/files");

  // The sidebar has one System row. It spins while any area works, with no percentage of its
  // own, and the areas themselves are no longer listed there.
  const system = page.getByRole("link", { name: "System", exact: true });
  await expect(system.locator('[data-system-activity="working"]')).toBeVisible();
  await expect(system).not.toContainText("%");
  await expect(page.getByRole("link", { name: "Thumbnails", exact: true })).toHaveCount(0);

  // Reached by keyboard, the row says what is running.
  await page.getByRole("link", { name: "Trash", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(system).toBeFocused();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("63 of 100 files processed");
  await expect(tooltip).toContainText("Making PDFs searchable: 12 files processed");
  await page.keyboard.press("Escape");

  // System lists its areas, and each area's row reports its own work.
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/system$/);
  const areas = page.getByRole("navigation", { name: "System areas" });
  const general = areas.getByRole("link", { name: "General", exact: true });
  const thumbnails = areas.getByRole("link", { name: "Thumbnails", exact: true });
  const ocr = areas.getByRole("link", { name: "Searchable PDFs", exact: true });
  await expect(thumbnails).toContainText("63%");
  await expect(thumbnails.locator('[data-system-activity="working"]')).toHaveAttribute(
    "title",
    "Rebuilding previews: 63 of 100 files processed",
  );
  await expect(ocr.locator('[data-system-activity="working"]')).toBeVisible();
  await expect(ocr).not.toContainText("%");
  await expect(general.locator("[data-system-activity]")).toHaveCount(0);
  await expect(system).toHaveAttribute("data-active", "");
  await expect(system.locator('[data-system-activity="working"]')).toBeVisible();

  // Both survive moving between areas, and a reload.
  await thumbnails.click();
  await expect(page).toHaveURL(/\/system\/thumbnails$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Thumbnails", exact: true }),
  ).toBeVisible();
  await expect(thumbnails).toHaveAttribute("aria-current", "page");
  await expect(thumbnails).toContainText("63%");
  percent = 84;
  await page.reload();
  await expect(thumbnails).toContainText("84%");
  await expect(system.locator('[data-system-activity="working"]')).toBeVisible();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(thumbnails.locator(".animate-spin")).toHaveCSS("animation-name", "none");
  await expect(system.locator(".animate-spin")).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(thumbnails.locator(".animate-spin")).toHaveCSS("animation-name", "spin");
  await expect(system.locator(".animate-spin")).toHaveCSS("animation-name", "spin");
  await page.screenshot({
    path: test.info().outputPath("system-activity-dark.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveClass(/light/);
  await page.screenshot({
    path: test.info().outputPath("system-activity-light.png"),
    fullPage: true,
    animations: "disabled",
  });

  // A phone shows the chosen area's sheet alone. The sidebar is a drawer, and its System row
  // still reports the work.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(thumbnails).toBeHidden();
  await expect(system).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");
  await expect(system.locator('[data-system-activity="working"]')).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("system-activity-mobile-sidebar.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  // The list of areas is a screen of its own there, one step back from the sheet.
  await page.getByRole("link", { name: "Back to System", exact: true }).click();
  await expect(page).toHaveURL(/\/system$/);
  await expect(thumbnails).toContainText("84%");
  await expect(ocr.locator('[data-system-activity="working"]')).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("system-activity-mobile.png"),
    animations: "disabled",
  });

  // When activity cannot be read, the stale percentage goes and both places warn. An area
  // that reports no feature's work stays unmarked.
  await page.setViewportSize({ width: 1280, height: 900 });
  offline = true;
  await expect(thumbnails.locator('[data-system-activity="warning"]')).toBeVisible({
    timeout: 10000,
  });
  await expect(thumbnails).not.toContainText("84%");
  await expect(system.locator('[data-system-activity="warning"]')).toBeVisible();
  await expect(general.locator("[data-system-activity]")).toHaveCount(0);
  offline = false;
  running = false;
  await expect(thumbnails.locator("[data-system-activity]")).toHaveCount(0, { timeout: 10000 });
  await expect(system.locator("[data-system-activity]")).toHaveCount(0);
  await expect(ocr.locator("[data-system-activity]")).toHaveCount(0);
});

test.describe("non-admin activity", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test("non-admin navigation never requests system activity", async ({ page }) => {
    await loginAs(page, "bob", "bob-password");
    let requests = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/system/activity")) requests++;
    });
    await page.goto("/files");
    await expect(page.getByRole("link", { name: "System", exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Shares", exact: true }).click();
    expect(requests).toBe(0);
  });
});
