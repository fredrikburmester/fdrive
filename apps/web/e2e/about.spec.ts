import { expect, test } from "@playwright/test";

test("/about credits no storage backend and drops the retired SFTPGo guides", async ({ page }) => {
  await page.goto("/about");

  await expect(page.getByText("Built on")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "SFTPGo" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Shared folders" })).toHaveCount(0);
});

test("/about identifies the running API and links to the project and feature guides", async ({
  page,
}) => {
  const response = await page.request.get("/api/v1/about");
  expect(response.ok()).toBe(true);
  const about = await response.json();
  expect(about.uptimeSeconds).toBeGreaterThanOrEqual(0);
  await page.goto("/about");
  const info = page.getByRole("region", { name: "About fdrive" });
  const github = "https://github.com/fredrikburmester/fdrive";
  await expect(info.getByRole("link", { name: "GitHub", exact: true })).toHaveAttribute(
    "href",
    github,
  );
  await expect(info.getByRole("link", { name: "FDrive for macOS" })).toHaveAttribute(
    "href",
    `${github}/blob/main/docs/MACOS.md`,
  );
  await expect(info.getByRole("link", { name: "Buy Me a Coffee" })).toHaveAttribute(
    "href",
    "https://buymeacoffee.com/fredrikbur3",
  );
  await expect(info.getByRole("link", { name: "Search & AI" })).toHaveAttribute(
    "href",
    `${github}/blob/main/docs/SEARCH-AND-AI.md`,
  );
  await expect(info.getByRole("heading", { name: "Feature documentation" })).toBeVisible();
  // Each detail is a row: the label in the left column, its value in the right one.
  const detail = (label: string) =>
    info.locator('[data-slot="setting-row"]', { hasText: label }).locator("> div").last();
  await expect(detail("API uptime")).toHaveText(/^(\d+d )?(\d+h )?\d+[ms]$/);
  // The e2e API runs from a checkout: a development build, with Git's commit when it has one.
  expect(about.release).toBeUndefined();
  const version = detail("Server version");
  if (about.revision === undefined) {
    expect(about.version).toBe("development");
    await expect(version).toHaveText("Development (version unavailable)");
  } else {
    expect(about.revision).toMatch(/^[a-f0-9]{40,64}$/);
    expect(about.version).toBe(about.revision);
    await expect(version.getByText("Development", { exact: true })).toBeVisible();
    await expect(version.getByRole("link", { name: about.revision.slice(0, 12) })).toHaveAttribute(
      "href",
      `${github}/commit/${about.revision}`,
    );
  }
  const guides = info.locator('a[href*="/blob/main/"]');
  await expect(guides).toHaveCount(9);
  for (const link of await info.locator('a[target="_blank"]').all()) {
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
});

test("/about fits phones and desktop in both themes", async ({ page }) => {
  await page.goto("/about");
  const info = page.getByRole("region", { name: "About fdrive" });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.classList.remove("light", "dark");
      document.documentElement.classList.add(value);
    }, theme);
    for (const width of [320, 375, 639, 640, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(info).toBeVisible();
      const bounds = await info.evaluate((element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        links: [...element.querySelectorAll('a[data-slot="resource-link"]')].map((link) => {
          const rect = link.getBoundingClientRect();
          return { height: rect.height, left: rect.left, right: rect.right };
        }),
      }));
      expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width);
      expect(bounds.links).toHaveLength(11);
      for (const link of bounds.links) {
        // A phone gets a full tap target; wider windows get rows as tall as the file list's.
        expect(link.height).toBeGreaterThanOrEqual(width < 640 ? 44 : 36);
        expect(link.left).toBeGreaterThanOrEqual(0);
        // Each link's right hairline overlaps its neighbour's, so the last column's sits one
        // pixel past the grid, which clips it; the scroll width above proves nothing overflows.
        expect(link.right).toBeLessThanOrEqual(width + 1);
      }
      if (width === 320 || width === 1280) {
        await page.screenshot({
          path: test.info().outputPath(`about-${theme}-${width}.png`),
          fullPage: true,
        });
      }
    }
  }
});
