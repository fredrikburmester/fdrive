import { expect, test } from "@playwright/test";
import { loginAs } from "./support/login.js";
import { listing } from "./support/regions.js";
import { uniqueName } from "./support/unique.js";

const SEARCH_INPUT_PLACEHOLDER = "Search files, content, and images...";

test("Cmd+K opens the panel and a filename query lists readme.md under Files", async ({ page }) => {
  await page.goto("/files");

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await page.getByPlaceholder(SEARCH_INPUT_PLACEHOLDER).fill("readme");

  // "readme" also matches the file's content (the word appears in the
  // seeded text), so it can legitimately appear in both the Files and
  // Content matches sections; `.first()` targets the Files section, which
  // renders first.
  await expect(dialog.getByText("readme.md").first()).toBeVisible();
  await expect(dialog.getByText("/docs/readme.md").first()).toBeVisible();
});

test("a content query for a word in the readme shows a highlighted content match", async ({
  page,
}) => {
  await page.goto("/files");

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await page.getByPlaceholder(SEARCH_INPUT_PLACEHOLDER).fill("seeded");

  await expect(dialog.getByText("Content matches")).toBeVisible();
  await expect(dialog.locator("mark", { hasText: "seeded" }).first()).toBeVisible();
});

test("Enter opens the preview", async ({ page }) => {
  await page.goto("/files");

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await page.getByPlaceholder(SEARCH_INPUT_PLACEHOLDER).fill("readme");
  await expect(dialog.getByText("readme.md").first()).toBeVisible();

  // The panel always lists a matched file's containing folder ahead of the
  // file itself (Folders, then Files, then Content matches), so cmdk
  // highlights "/docs" first; move down once to reach readme.md before
  // opening it.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/view\/docs\/readme\.md$/);
});

test("clicking a Files result's reveal button opens its enclosing folder with it selected", async ({
  page,
}) => {
  await page.goto("/files");

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await page.getByPlaceholder(SEARCH_INPUT_PLACEHOLDER).fill("readme");

  // `.first()` targets the Files section's row (see the first test's note).
  const fileRow = dialog.getByRole("option").filter({ hasText: "readme.md" }).first();
  await fileRow.getByRole("button", { name: "Reveal in folder" }).click();

  await expect(page).toHaveURL(/\/files\/docs$/);
  await expect(page.getByText("1 selected")).toBeVisible();
});

test("switching the Enter preference to Enclosing folder makes Enter reveal instead of open", async ({
  page,
}) => {
  await page.goto("/files");

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await page.getByPlaceholder(SEARCH_INPUT_PLACEHOLDER).fill("readme");
  await expect(dialog.getByText("readme.md").first()).toBeVisible();

  await dialog.getByRole("button", { name: "Enclosing folder" }).click();

  // Re-focus the search input (clicking the preference button above moved
  // focus away from it) so ArrowDown/Enter drive cmdk's own navigation.
  await page.getByPlaceholder(SEARCH_INPUT_PLACEHOLDER).click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/files\/docs$/);
  await expect(page.getByText("1 selected")).toBeVisible();
});

test("reloading after a reveal shows nothing selected", async ({ page }) => {
  await page.goto("/files");

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await page.getByPlaceholder(SEARCH_INPUT_PLACEHOLDER).fill("readme");

  const fileRow = dialog.getByRole("option").filter({ hasText: "readme.md" }).first();
  await fileRow.getByRole("button", { name: "Reveal in folder" }).click();

  await expect(page).toHaveURL(/\/files\/docs$/);
  await expect(page.getByText("1 selected")).toBeVisible();

  await page.reload();

  await expect(page.getByText("1 selected")).toBeHidden();
});

test("a type filter other than Any type hides the Folders section, even though the unfiltered query shows one", async ({
  page,
}) => {
  await page.goto("/files");

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await page.getByPlaceholder(SEARCH_INPUT_PLACEHOLDER).fill("readme");

  // Unfiltered, "readme" matches readme.md by both filename and content, so
  // its containing folder ("/docs") is derived into the Folders section
  // (see the "Enter opens the preview" test's note on section ordering).
  await expect(dialog.getByText("readme.md").first()).toBeVisible();
  await expect(dialog.getByText("Folders")).toBeVisible();

  // readme.md is a ".md" file, which the "Documents" chip includes, so the
  // Files section still lists it; only Folders disappears, since a type
  // filter is a files-only filter (see `service.ts`'s `deriveFolders` call
  // site).
  await dialog.getByRole("button", { name: "Documents", exact: true }).click();

  await expect(dialog.getByText("readme.md").first()).toBeVisible();
  await expect(dialog.getByText("Folders")).toBeHidden();
});

test("a long folder name and file path in a result row never spill past the search dialog's edge", async ({
  page,
}) => {
  // The Files/Content sections only ever surface index-backed rows (a
  // seeded fixture, fixed at global setup), which have no long paths; the
  // Recent section is populated from `localStorage` alone and needs no
  // index, so a folder created here (giving it a real, long virtual path)
  // combined with a directly-seeded Recent entry exercises the same
  // `HitRow`/`RecentRow` truncation styles this spec's earlier tests do not
  // reach, without touching any shared fixture file.
  const folderName = uniqueName(
    "(TNG032) Fourier and Laplace Transforms - Course Reference Materials for Engineering Students",
  );
  await page.goto("/files");
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  const folderDialog = page.getByRole("dialog");
  await folderDialog.getByLabel("Folder name").fill(folderName);
  await folderDialog.getByRole("button", { name: "Create" }).click();
  await expect(folderDialog).toBeHidden();

  const meResponse = await page.request.get("/api/v1/auth/me");
  expect(meResponse.ok()).toBe(true);
  const me = (await meResponse.json()) as { account: { id: string }; activeIdentityId: string };
  const storageKey = `fdrive.recent:${JSON.stringify([me.account.id, me.activeIdentityId])}`;
  const recentItem = {
    path: `/${folderName}/Course Notes.md`,
    name: "Course Notes.md",
    openedAt: new Date().toISOString(),
  };
  await page.evaluate(({ key, item }) => window.localStorage.setItem(key, JSON.stringify([item])), {
    key: storageKey,
    item: recentItem,
  });

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  const row = dialog.getByRole("option").filter({ hasText: "Course Notes.md" });
  await expect(row).toBeVisible();
  const pathText = row.getByText(recentItem.path);
  await expect(pathText).toBeVisible();

  const dialogBox = await dialog.boundingBox();
  const pathBox = await pathText.boundingBox();
  if (dialogBox === null || pathBox === null) {
    throw new Error("expected bounding boxes for both the dialog and the path text");
  }
  // With truncation applied, the path's own rendered box never extends
  // past the dialog's right edge; without it (the pre-fix `shrink-0` span)
  // the path's box grows to its full, untruncated content width and pokes
  // out from under the reveal button.
  expect(pathBox.x + pathBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 1);
  // Belt and braces: the element clips its own overflowing content rather
  // than merely happening to fit.
  const overflow = await pathText.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeGreaterThan(0);

  await page.keyboard.press("Escape");
  await listing(page).getByText(folderName, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirmDialog = page.getByRole("alertdialog");
  await confirmDialog.getByRole("button", { name: "Delete" }).click();
  await expect(confirmDialog).toBeHidden();
});

test("search dialog on desktop is roughly 800px wide and bounded in viewport height", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/files");

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  if (box !== null) {
    expect(box.width).toBeGreaterThanOrEqual(750);
    expect(box.width).toBeLessThanOrEqual(810);
    expect(box.height).toBeLessThan(800);
  }
});

test("search panel presents unified filters with no manual Images mode toggle", async ({
  page,
}) => {
  await page.goto("/files");

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await expect(dialog.getByRole("button", { name: "Search images" })).toBeHidden();
  await expect(dialog.getByRole("button", { name: "Images", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "This folder only" })).toBeVisible();
});

test("search dialog stays bounded with accessible footer on a short 800x600 display", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/files");

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  if (box !== null) {
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(600);
  }

  const footer = dialog.getByText("Enter opens:");
  await expect(footer).toBeVisible();
  const footerBox = await footer.boundingBox();
  expect(footerBox).not.toBeNull();
  if (footerBox !== null) {
    expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(600);
  }
});

test("search panel renders as full-screen sheet on 700px mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await page.goto("/files");

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  if (box !== null) {
    expect(box.x).toBe(0);
    expect(box.width).toBe(700);
    expect(box.height).toBeCloseTo(800, 2);
  }

  await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(dialog.getByText("Enter opens:")).toBeHidden();
});

test("search panel presents visible File type label in filter bar", async ({ page }) => {
  await page.goto("/files");

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await expect(dialog.getByText("File type:")).toBeVisible();
});

test("concurrent search displays text and visual matches without manual toggle, and image failure leaves text visible", async ({
  page,
}) => {
  await page.route("**/api/v1/search/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ available: true, semantic: true, images: true }),
    });
  });

  await page.route(/\/api\/v1\/search(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        query: "landscape",
        sections: {
          folders: [],
          files: [
            {
              name: "landscape-notes.txt",
              path: "/docs/landscape-notes.txt",
              kind: "file",
              ext: ".txt",
              mime: "text/plain",
              size: 100,
              modifiedAt: "2026-01-01T00:00:00Z",
              score: 1,
              snippets: [],
              hasThumbnail: false,
            },
          ],
          content: [],
        },
        degraded: false,
        unavailable: false,
        tookMs: 5,
      }),
    });
  });

  let failImages = false;
  await page.route("**/api/v1/search/images*", async (route) => {
    if (failImages) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "Image search service unavailable" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        query: "landscape",
        hits: [
          {
            name: "landscape.jpg",
            path: "/photos/landscape.jpg",
            ext: ".jpg",
            mime: "image/jpeg",
            size: 4096,
            modifiedAt: "2026-01-01T00:00:00Z",
            score: 0.98,
          },
        ],
        unavailable: false,
        tookMs: 8,
      }),
    });
  });

  await page.goto("/files");
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Search "landscape" without touching any Images toggle
  await page.getByPlaceholder(SEARCH_INPUT_PLACEHOLDER).fill("landscape");

  // Assert both text file and visual match are visible concurrently
  await expect(dialog.getByText("landscape-notes.txt", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Visual matches")).toBeVisible();
  await expect(dialog.getByText("landscape.jpg")).toBeVisible();

  // Now trigger image failure for a new search term
  failImages = true;
  await page.getByPlaceholder(SEARCH_INPUT_PLACEHOLDER).fill("landscape2");

  // Text results remain visible and visual search unavailable notice shows
  await expect(dialog.getByText("landscape-notes.txt", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Visual search is unavailable.")).toBeVisible();
  await expect(dialog.getByText("Visual matches")).toBeHidden();
});

test.describe("scoping", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("bob's search for readme returns nothing", async ({ page }) => {
    await loginAs(page, "bob", "bob-password");

    // `loginAs` resolves as soon as the client-side redirect lands on
    // `/files` (a SPA navigation, unlike the other tests' `page.goto`,
    // which waits for a full load event). The search button's Cmd+K
    // listener is bound in a `useEffect` that only runs once React commits,
    // so pressing the shortcut immediately after login can race that
    // hydration. Waiting for the button to render and become enabled first
    // guarantees the listener is already attached.
    await expect(page.getByRole("button", { name: "Search" })).toBeEnabled();

    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog");
    await page.getByPlaceholder(SEARCH_INPUT_PLACEHOLDER).fill("readme");

    await expect(dialog.getByText(/no results/i)).toBeVisible();
    await expect(dialog.getByText("readme.md")).toBeHidden();
  });
});
