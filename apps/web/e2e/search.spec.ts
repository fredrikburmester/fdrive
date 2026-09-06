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

test.describe("scoping", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("bob's search for readme returns nothing", async ({ page }) => {
    await loginAs(page, "bob", "bob-password");

    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog");
    await page.getByPlaceholder(SEARCH_INPUT_PLACEHOLDER).fill("readme");

    await expect(dialog.getByText(/no results/i)).toBeVisible();
    await expect(dialog.getByText("readme.md")).toBeHidden();
  });
});
