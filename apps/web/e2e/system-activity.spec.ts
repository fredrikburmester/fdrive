import { SystemActivityId, type SystemActivityItem } from "@fdrive/contracts";
import { expect, test } from "@playwright/test";
import { loginAs } from "./support/login.js";

test("sidebar activity survives navigation and reload, supports keyboard details and reduced motion", async ({
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
  const thumbnails = page.getByRole("link", { name: "Thumbnails", exact: true });
  const sharedFolders = page.getByRole("link", { name: "Shared folders", exact: true });
  const ocr = page.getByRole("link", { name: "Searchable PDFs", exact: true });
  await expect(thumbnails).toContainText("63%");
  await expect(ocr.locator('[data-system-activity="working"]')).toBeVisible();
  await expect(ocr).not.toContainText("%");
  const collapse = page.getByRole("button", { name: "Collapse Features", exact: true });
  await collapse.click();
  await expect(thumbnails).toHaveCount(0);
  await expect(sharedFolders).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Office", exact: true })).toHaveCount(0);
  for (const name of ["General", "Storage"]) {
    await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  }
  await expect(
    page
      .getByRole("link", { name: "Features", exact: true })
      .locator('[data-system-activity="working"]'),
  ).toBeVisible();
  await page.reload();
  const expand = page.getByRole("button", { name: "Expand Features", exact: true });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expand.focus();
  await page.keyboard.press("Enter");
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await expect(thumbnails).toContainText("63%");
  await page.getByRole("button", { name: "Collapse Features", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(sharedFolders).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(thumbnails).toBeFocused();
  await expect(page.getByRole("tooltip")).toContainText("63 of 100 files processed");
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "General", exact: true }).click();
  await expect(page).toHaveURL(/\/system\/general$/);
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(thumbnails).toContainText("63%");
  percent = 84;
  await page.reload();
  await expect(thumbnails).toContainText("84%");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(thumbnails.locator(".animate-spin")).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(thumbnails.locator(".animate-spin")).toHaveCSS("animation-name", "spin");
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
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(thumbnails).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");
  await expect(thumbnails).toContainText("84%");
  await expect(ocr).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("system-activity-mobile.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 900 });
  offline = true;
  await expect(thumbnails.locator('[data-system-activity="warning"]')).toBeVisible({
    timeout: 10000,
  });
  await expect(thumbnails).not.toContainText("84%");
  await expect(sharedFolders.locator("[data-system-activity]")).toHaveCount(0);
  offline = false;
  running = false;
  await expect(thumbnails.locator("[data-system-activity]")).toHaveCount(0, { timeout: 10000 });
  await collapse.click();
  await page.goto("/system/shared-folders");
  await expect(sharedFolders).toBeVisible();
  await expect(sharedFolders).toHaveAttribute("data-active", "");
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("link", { name: "Features", exact: true }).click();
  await expect(page).toHaveURL(/\/system\/features$/);
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
    await expect(page.getByRole("link", { name: "Thumbnails", exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Shares", exact: true }).click();
    expect(requests).toBe(0);
  });
});
