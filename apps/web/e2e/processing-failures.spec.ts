import { expect, test } from "@playwright/test";

test("failure details paginate, filter and remain readable on narrow screens", async ({ page }) => {
  const at = "2026-09-13T08:00:00.000Z";
  const entries = ["PermissionError", "UnidentifiedImageError"].map((code, index) => ({
    id: 2 - index,
    root: "photos",
    path: `${"Long folder name/".repeat(8)}broken-${index}.png`,
    feature: "thumbnails",
    code,
    message: `${code}: ${index === 0 ? "Permission denied" : "Cannot decode image bytes"}`,
    operationId: "scan-before-restart",
    attempts: 3,
    firstFailedAt: at,
    lastFailedAt: at,
    resolvedAt: null,
  }));
  await page.route("**/api/v1/system/processing-failures/thumbnails?**", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const resolved = query.get("status") === "resolved";
    const code = query.get("code");
    const before = query.get("before");
    const matching = entries.filter((entry) => !code || entry.code === code);
    await route.fulfill({
      json: {
        entries: resolved ? [] : before ? matching.slice(1) : matching.slice(0, 1),
        groups: resolved ? [] : entries.map((entry) => ({ code: entry.code, count: 1 })),
        total: resolved ? 0 : matching.length,
        openCount: 2,
        ...(!resolved && !code && !before ? { nextCursor: 2 } : {}),
      },
    });
  });
  await page.goto("/system/thumbnails");
  await expect(page.getByText("2 unresolved files", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View failures", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("Permission denied");
  await sheet.getByRole("button", { name: "Load more" }).click();
  await expect(sheet.getByRole("listitem")).toHaveCount(2);
  await sheet.getByRole("button", { name: "UnidentifiedImageError · 1", exact: true }).click();
  await expect(sheet.getByRole("listitem")).toHaveCount(1);
  await expect(sheet).toContainText("Cannot decode image bytes");
  await sheet.getByText("Details", { exact: true }).click();
  await expect(sheet).toContainText("scan-before-restart");
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 800 });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveClass(new RegExp(colorScheme));
      expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await expect(sheet.getByRole("button", { name: "Retry file", exact: true })).toBeInViewport();
    }
  }
  await sheet.getByRole("button", { name: "Resolved", exact: true }).click();
  await expect(sheet).toContainText("No resolved failures.");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("button", { name: "View failures", exact: true })).toBeFocused();
});
