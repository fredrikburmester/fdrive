import { expect, test } from "@playwright/test";
import { loginAs } from "./support/login.js";

const SEARCH_INPUT_PLACEHOLDER = "Search files and content...";

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
