import type { SystemImageSearchResponse } from "@fdrive/contracts";
import { expect, type Page, test } from "@playwright/test";

/**
 * A System area's sheet header: the title, the caption beside the badges, and the actions. The
 * destructive action is not among them: it sits apart, at the far end of the sheet's footer.
 */
async function checkHeader(page: Page, title: string, actions: string[], destructive: string) {
  // The area's name is the sheet's title, and the page's heading.
  await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
  const sheet = page.getByRole("region", { name: title, exact: true });
  const header = sheet.locator('[data-slot="detail-sheet-header"]');
  const updated = header.getByText(/^Updated /);
  await expect(updated).toBeVisible();
  const bounds = await header.boundingBox();
  const caption = await updated.boundingBox();
  if (!bounds || !caption) throw new Error("System header is not visible");
  expect(caption.height).toBeLessThan(20);
  const phone = (page.viewportSize()?.width ?? 1280) < 640;
  for (const name of actions) {
    const button = header.getByRole("button", { name, exact: true });
    await expect(button).toBeInViewport({ ratio: 1 });
    const box = await button.boundingBox();
    if (!box) throw new Error(`${name} is not visible`);
    expect(box.x).toBeGreaterThanOrEqual(bounds.x);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    if (phone) {
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.y).toBeGreaterThanOrEqual(caption.y + caption.height);
    }
  }
  // The feature's own switch sits with the actions.
  await expect(header.getByRole("switch")).toBeInViewport({ ratio: 1 });
  const footer = sheet.locator('[data-slot="detail-sheet-footer"]');
  const clear = footer.getByRole("button", { name: destructive, exact: true });
  await expect(clear).toBeVisible();
  await expect(header.getByRole("button", { name: destructive, exact: true })).toHaveCount(0);
  const footerBox = await footer.boundingBox();
  const clearBox = await clear.boundingBox();
  if (!footerBox || !clearBox) throw new Error(`${destructive} is not visible`);
  expect(clearBox.x).toBeGreaterThanOrEqual(footerBox.x);
  expect(clearBox.x + clearBox.width).toBeLessThanOrEqual(footerBox.x + footerBox.width + 1);
  if (phone) expect(clearBox.height).toBeGreaterThanOrEqual(44);
  // Measured on the sheet, not its header: the switch's tap target reaches past its own edge.
  expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.getByRole("main").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
}

test("image search sheet header fits phones and keeps every action usable", async ({ page }) => {
  test.setTimeout(60_000);
  const status: SystemImageSearchResponse = {
    configured: true,
    healthy: true,
    model: "siglip2-base",
    dim: 1024,
    embedded: 42,
    embeddedModel: "siglip2-base",
  };
  await page.route("**/api/v1/system/image-search", (route) => route.fulfill({ json: status }));
  await page.route("**/api/v1/system/activity", (route) =>
    route.fulfill({ json: { observedAt: new Date().toISOString(), items: [] } }),
  );
  await page.goto("/system/image-search");
  for (const width of [320, 375, 402, 640, 768, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveClass(new RegExp(colorScheme));
      // A new width can slide the sidebar in or out, so measure once the layout has settled.
      await expect(async () => {
        await checkHeader(page, "Image search", ["Logs", "Rebuild"], "Clear embeddings");
      }).toPass();
      await page.screenshot({
        path: test.info().outputPath(`image-header-${width}-${colorScheme}.png`),
        animations: "disabled",
      });
    }
  }
  await page.setViewportSize({ width: 320, height: 640 });
  for (const [action, title] of [
    ["Clear embeddings", "Clear image embeddings?"],
    ["Rebuild", "Rebuild image embeddings"],
    ["Logs", "image-search log"],
  ] as const) {
    await page.getByRole("button", { name: action, exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText(title);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByRole("button", { name: action, exact: true })).toBeFocused();
  }
});

test("the full-text search sheet header wraps its actions within its content", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 850 });
  await page.goto("/system/indexer");
  await checkHeader(page, "Full-text search", ["Settings", "Logs", "Reindex"], "Clear index");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
