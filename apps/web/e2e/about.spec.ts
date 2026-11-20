import { expect, type Locator, type Page, test } from "@playwright/test";
import { loginAs } from "./support/login.js";

const GITHUB = "https://github.com/fredrikburmester/fdrive";

/** About, wherever it is shown: the System area, the page or the account menu's sheet. */
function aboutSheet(scope: Page | Locator): Locator {
  return scope.getByRole("region", { name: "About fdrive" });
}

/** The account menu's trigger: the sidebar footer button showing the signed-in username. */
function accountMenu(page: Page): Locator {
  return page.locator('[data-sidebar="footer"]').getByRole("button");
}

/** A named value in the sheet: the `dd` beside the `dt` with that label. */
function fact(sheet: Locator, label: string): Locator {
  return sheet.locator(`dt:text-is("${label}") + dd`);
}

test("/about sends alice (admin) to About in System, which credits no storage backend", async ({
  page,
}) => {
  await page.goto("/about");

  await expect(page).toHaveURL(/\/system\/about$/);
  await expect(aboutSheet(page)).toBeVisible();
  await expect(page.getByText("Built on")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "SFTPGo" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Shared folders" })).toHaveCount(0);
});

test("About is the last System area: it identifies the running API and links to the project and feature guides", async ({
  page,
}) => {
  const response = await page.request.get("/api/v1/about");
  expect(response.ok()).toBe(true);
  const about = await response.json();
  expect(about.uptimeSeconds).toBeGreaterThanOrEqual(0);
  await page.goto("/system/about");

  const areas = page.getByRole("navigation", { name: "System areas" }).getByRole("link");
  await expect(areas.last()).toHaveAccessibleName("About");
  await expect(areas.last()).toHaveAttribute("aria-current", "page");

  const info = aboutSheet(page);
  await expect(page.getByRole("heading", { level: 1, name: "About fdrive" })).toBeVisible();
  await expect(info.getByRole("link", { name: "GitHub", exact: true })).toHaveAttribute(
    "href",
    GITHUB,
  );
  await expect(info.getByRole("link", { name: "FDrive for macOS" })).toHaveAttribute(
    "href",
    `${GITHUB}/blob/main/docs/MACOS.md`,
  );
  await expect(info.getByRole("link", { name: "Buy Me a Coffee" })).toHaveAttribute(
    "href",
    "https://buymeacoffee.com/fredrikbur3",
  );
  await expect(info.getByRole("link", { name: "Search & AI" })).toHaveAttribute(
    "href",
    `${GITHUB}/blob/main/docs/SEARCH-AND-AI.md`,
  );
  await expect(info.getByRole("heading", { name: "Feature documentation" })).toBeVisible();
  await expect(fact(info, "API uptime")).toHaveText(/^(\d+d )?(\d+h )?\d+[ms]$/);
  // The e2e API runs from a checkout: a development build, with Git's commit when it has one.
  expect(about.release).toBeUndefined();
  if (about.revision === undefined) {
    expect(about.version).toBe("development");
    await expect(fact(info, "Version")).toHaveText("Development (version unavailable)");
    await expect(fact(info, "Revision")).toHaveCount(0);
  } else {
    expect(about.revision).toMatch(/^[a-f0-9]{40,64}$/);
    expect(about.version).toBe(about.revision);
    await expect(fact(info, "Version")).toHaveText("Development");
    await expect(
      fact(info, "Revision").getByRole("link", { name: about.revision.slice(0, 12) }),
    ).toHaveAttribute("href", `${GITHUB}/commit/${about.revision}`);
  }
  await expect(info.getByText("fdrive is licensed under the AGPL-3.0 license.")).toBeVisible();
  const guides = info.locator('a[href*="/blob/main/"]');
  await expect(guides).toHaveCount(9);
  for (const link of await info.locator('a[target="_blank"]').all()) {
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
});

test("About fits phones and desktop in both themes", async ({ page }) => {
  await page.goto("/system/about");
  const info = aboutSheet(page);
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
        // Every row is a full tap target, at any width.
        expect(link.height).toBeGreaterThanOrEqual(44);
        expect(link.left).toBeGreaterThanOrEqual(0);
        expect(link.right).toBeLessThanOrEqual(width);
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

test("alice (admin) reaches About in System from the account menu", async ({ page }) => {
  await page.goto("/files");

  await accountMenu(page).click();
  const item = page.getByRole("menuitem", { name: "About" });
  await expect(item).toHaveAttribute("href", "/system/about");
  await item.click();

  await expect(page).toHaveURL(/\/system\/about$/);
  await expect(aboutSheet(page)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test.describe("bob (not admin)", () => {
  // bob holds no administrator account, so this spec logs in as bob itself rather than reusing
  // the alice storage state the "chromium" project otherwise applies by default.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("opens About from the account menu as a sheet over the page he is on", async ({ page }) => {
    await loginAs(page, "bob", "bob-password");

    await accountMenu(page).click();
    await page.getByRole("menuitem", { name: "About" }).click();

    const dialog = page.getByRole("dialog", { name: "About fdrive" });
    await expect(dialog).toBeVisible();
    // Over the page, not a page of its own.
    await expect(page).toHaveURL(/\/files$/);
    const info = aboutSheet(dialog);
    await expect(fact(info, "Version")).toHaveText(/^Development/);
    await expect(fact(info, "API uptime")).toHaveText(/^(\d+d )?(\d+h )?\d+[ms]$/);
    await expect(info.getByRole("link", { name: "GitHub", exact: true })).toHaveAttribute(
      "href",
      GITHUB,
    );
    await expect(info.locator('a[data-slot="resource-link"]')).toHaveCount(11);
    // A narrow sheet docked on the right, once it has slid in.
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("The page has no viewport");
    await expect
      .poll(async () => {
        const box = await dialog.boundingBox();
        return box === null ? null : Math.round(box.x + box.width);
      })
      .toBe(viewport.width);
    expect((await dialog.boundingBox())?.width).toBeLessThanOrEqual(460);

    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/files$/);
  });

  test("gets About as a page of its own at /about, and none in System", async ({ page }) => {
    await loginAs(page, "bob", "bob-password");

    await page.goto("/about");
    await expect(page).toHaveURL(/\/about$/);
    const info = aboutSheet(page);
    await expect(page.getByRole("heading", { level: 1, name: "About fdrive" })).toBeVisible();
    await expect(fact(info, "Version")).toHaveText(/^Development/);
    await expect(info.locator('a[data-slot="resource-link"]')).toHaveCount(11);
    await expect(page.getByRole("navigation", { name: "System areas" })).toHaveCount(0);

    await page.goto("/system/about");
    await expect(page).toHaveURL(/\/files$/);
  });
});
