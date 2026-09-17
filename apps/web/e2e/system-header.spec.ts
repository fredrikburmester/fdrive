import type { SystemImageSearchResponse } from "@fdrive/contracts";
import { expect, type Page, test } from "@playwright/test";

async function checkHeader(page: Page, title: string, actions: string[]) {
  const heading = page.getByRole("heading", { name: title, exact: true });
  const header = heading.locator("../..");
  const updated = header.getByText(/^Last updated /);
  await expect(updated).toBeVisible();
  const bounds = await header.boundingBox();
  const caption = await updated.boundingBox();
  if (!bounds || !caption) throw new Error("System header is not visible");
  expect(caption.height).toBeLessThan(20);
  for (const name of actions) {
    const button = header.getByRole("button", { name, exact: true });
    await expect(button).toBeInViewport({ ratio: 1 });
    const box = await button.boundingBox();
    if (!box) throw new Error(`${name} is not visible`);
    expect(box.x).toBeGreaterThanOrEqual(bounds.x);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    if ((page.viewportSize()?.width ?? 1280) < 640) {
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.y).toBeGreaterThanOrEqual(caption.y + caption.height);
    }
  }
  expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.getByRole("main").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
}

test("image search header fits phones and keeps every action usable", async ({ page }) => {
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
  await page.route("**/api/v1/system/activity**", (route) =>
    route.fulfill({
      json: { observedAt: new Date().toISOString(), scope: "identity", items: [] },
    }),
  );
  await page.goto("/system/image-search");
  for (const width of [320, 375, 402, 640, 768, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveClass(new RegExp(colorScheme));
      await checkHeader(page, "Image search", ["Clear embeddings", "Rebuild", "Logs"]);
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

test("the four-action full-text search header wraps within its content", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 850 });
  await page.goto("/system/indexer");
  await checkHeader(page, "Full-text search", ["Clear index", "Reindex", "Settings", "Logs"]);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
