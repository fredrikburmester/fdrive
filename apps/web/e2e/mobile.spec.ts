import { expect, type Page, test } from "@playwright/test";
import { sidebar } from "./support/regions.js";
import { uniqueName } from "./support/unique.js";

/** iPhone 12-ish viewport: the preset item 2 of the `ux-shell` spec asks
 * the mobile layout to be reproduced and verified at. */
const MOBILE_VIEWPORT = { width: 390, height: 844 };
/** The narrowest width the toolbar must never overflow at. */
const NARROWEST_VIEWPORT = { width: 320, height: 844 };

async function createFolder(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Folder name").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
}

/** `document.documentElement`'s scroll width minus its client width: 0 (or
 * a hairline rounding difference) means nothing forces horizontal scroll. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe("mobile layout (390x844 and 320px)", () => {
  test("the toolbar never causes horizontal overflow at 390px or 320px", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/files");
    await page.getByRole("button", { name: "New" }).waitFor();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

    await page.setViewportSize(NARROWEST_VIEWPORT);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test("collapses to Search, New, and a More overflow menu that exposes every action", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/files");

    // Search and New stay inline; every other desktop-only trigger moves
    // into "More" and is no longer reachable as its own toolbar button.
    await expect(page.getByRole("button", { name: "Search" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New" })).toBeVisible();
    await expect(page.getByRole("button", { name: "View" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Upload" })).toHaveCount(0);

    const more = page.getByRole("button", { name: "More" });
    await expect(more).toBeVisible();
    await expect.poll(async () => (await more.boundingBox())?.width).toBeGreaterThanOrEqual(44);
    await expect.poll(async () => (await more.boundingBox())?.height).toBeGreaterThanOrEqual(44);

    await more.click();
    await expect(page.getByRole("menuitem", { name: "View" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Upload" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Duplicate" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Compress" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Show details" })).toBeVisible();

    // The "Upload" entry is itself a submenu; its two actions are reachable
    // once opened, same as every other overflowed action.
    await page.getByRole("menuitem", { name: "Upload" }).click();
    await expect(page.getByRole("menuitem", { name: "Upload files" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Upload folder" })).toBeVisible();
  });

  test("a selection surfaces as a badge on More and a Clear selection action inside it", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/files");
    const folder = uniqueName("mobile-selection");
    // Creating a folder auto-selects it (see select-all.spec.ts), giving a
    // selection of exactly one without needing a pointer gesture.
    await createFolder(page, folder);

    const more = page.getByRole("button", { name: "More" });
    await expect(more.getByText("1", { exact: true })).toBeVisible();

    await more.click();
    await expect(page.getByText("1 selected")).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Clear selection" })).toBeVisible();

    await page.getByRole("menuitem", { name: "Clear selection" }).click();
    await expect(more.getByText("1", { exact: true })).toHaveCount(0);
  });

  test("the breadcrumb truncates from the left, always keeping the current folder visible", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/files");
    const folder = uniqueName("mobile-crumb");
    await createFolder(page, folder);
    await page.getByText(folder, { exact: true }).dblclick();
    await expect(page).toHaveURL(new RegExp(`/files/${folder}$`));

    const nav = page.getByRole("navigation", { name: "breadcrumb" });
    await expect(nav.getByText(folder, { exact: true })).toBeVisible();
    // "Home" collapses behind the ellipsis instead of staying inline.
    await expect(nav.getByRole("link", { name: "Home" })).toHaveCount(0);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test("the search button opens the panel even when the index is unavailable", async ({ page }) => {
    const statusResponse = page.waitForResponse((res) => res.url().includes("/search/status"));
    await page.route("**/api/v1/search/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ available: false, semantic: false }),
      }),
    );
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/files");
    // The button's disabled state depends on this response; wait for it (and
    // the re-render it triggers) to settle before measuring, so `boundingBox`
    // never races the query resolving mid-check.
    await statusResponse;

    const search = page.getByRole("button", { name: "Search" });
    await expect(search).toBeEnabled();

    // `expect.poll` retries `boundingBox`, which otherwise can momentarily
    // return null across a re-render, unlike Playwright's own `toBeVisible`.

    const sidebarTrigger = page.getByRole("button", { name: "Toggle Sidebar" });
    // Never overlapped: the sidebar trigger's right edge sits at or before
    // the search button's left edge.
    await expect
      .poll(async () => {
        const triggerBox = await sidebarTrigger.boundingBox();
        const box = await search.boundingBox();
        return triggerBox && box ? triggerBox.x + triggerBox.width <= box.x : false;
      })
      .toBe(true);

    await search.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByPlaceholder("Search files and content...")).toBeVisible();
  });

  test("the search panel is a full-width sheet with a scrollable, unclipped type filter row and no keyboard footer", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/files");

    await page.getByRole("button", { name: "Search" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Full width: the panel spans (within a hairline) the whole viewport,
    // unlike the small centered dialog desktop keeps.
    await expect
      .poll(async () => (await dialog.boundingBox())?.width)
      .toBeGreaterThanOrEqual(MOBILE_VIEWPORT.width - 2);

    // Every type chip is reachable: Playwright scrolls a target into view
    // before clicking it, so this only succeeds if the row's overflow lets
    // "Video" (previously clipped) actually scroll into place rather than
    // staying hidden behind a clipped container.
    // Ends back on "Any type" so the query below is not left filtered by
    // whichever chip was clicked last.
    for (const label of ["Images", "Documents", "Audio", "Video", "Archives", "Any type"]) {
      await dialog.getByRole("button", { name: label, exact: true }).click();
    }

    // The keyboard-oriented footer (the Enter-opens preference and its
    // hints) makes no sense without a keyboard, so it is absent entirely.
    await expect(dialog.getByText("Enter opens")).toHaveCount(0);
    await expect(dialog.getByText("reveal", { exact: true })).toHaveCount(0);

    // Typing a query still lists results, and tapping one still opens it
    // (the reveal action moves to each row's own button instead of Enter).
    await page.getByPlaceholder("Search files and content...").fill("readme");
    await expect(dialog.getByText("readme.md").first()).toBeVisible();
    await dialog.getByText("readme.md").first().click();

    await expect(page).toHaveURL(/\/view\/docs\/readme\.md$/);
  });

  test("navigation orders Files tree, then Shares near the bottom", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/files");
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();

    const filesLink = sidebar(page).getByRole("link", { name: "Files" });
    const sharesLink = sidebar(page).getByRole("link", { name: "Shares" });
    await expect(filesLink).toBeVisible();
    await expect(sharesLink).toBeVisible();

    const filesBox = await filesLink.boundingBox();
    const sharesBox = await sharesLink.boundingBox();
    expect(filesBox && sharesBox && filesBox.y).toBeLessThan(sharesBox?.y ?? 0);
  });
});
