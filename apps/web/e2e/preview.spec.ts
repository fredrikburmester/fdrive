import { expect, test } from "@playwright/test";
import { shareHeicFixture } from "./support/share-fixture.js";

test("opening readme.md renders it as markdown", async ({ page }) => {
  await page.goto("/view/docs/readme.md");

  await expect(page.getByRole("heading", { name: "Alice's docs" })).toBeVisible();
});

test("arrow right/left navigates between sibling files", async ({ page }) => {
  await page.goto("/view/docs/readme.md");
  await expect(page.getByRole("heading", { name: "Alice's docs" })).toBeVisible();

  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(/\/view\/docs\/report\.pdf$/);
  await expect(page.locator('iframe[title="report.pdf"]')).toBeVisible();

  await page.keyboard.press("ArrowLeft");
  await expect(page).toHaveURL(/\/view\/docs\/readme\.md$/);
  await expect(page.getByRole("heading", { name: "Alice's docs" })).toBeVisible();
});

test("Escape returns to the containing folder", async ({ page }) => {
  await page.goto("/view/docs/readme.md");
  await expect(page.getByRole("heading", { name: "Alice's docs" })).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(page).toHaveURL(/\/files\/docs$/);
});

test("report.pdf opens the PDF viewer", async ({ page }) => {
  await page.goto("/view/docs/report.pdf");

  await expect(page.locator('iframe[title="report.pdf"]')).toBeVisible();
});

test("photo.jpg opens the image viewer", async ({ page }) => {
  await page.goto("/view/photo.jpg");

  await expect(page.locator('img[alt="photo.jpg"]')).toBeVisible();
});

test("the Info button opens the inspector with size and modified rows", async ({ page }) => {
  await page.goto("/view/docs/readme.md");
  await expect(page.getByRole("heading", { name: "Alice's docs" })).toBeVisible();

  await page.getByRole("button", { name: "Info" }).click();

  await expect(page.getByText("Size", { exact: true })).toBeVisible();
  await expect(page.getByText("Modified", { exact: true })).toBeVisible();
});

test("photo.heic opens the image viewer and decodes via WASM on zoom", async ({ page }) => {
  const name = "photo.heic";
  const upload = await page.request.put(
    `/api/v1/fs/upload?path=${encodeURIComponent(`/${name}`)}`,
    {
      headers: { "x-requested-with": "fdrive", "content-type": "image/heic" },
      data: shareHeicFixture(),
    },
  );
  expect(upload.ok()).toBe(true);

  await page.goto(`/view/${name}`);
  const img = page.locator(`img[alt="${name}"]`);
  await expect(img).toBeVisible();

  await img.click();
  await expect(page.getByRole("button", { name: "Zoom out" })).toBeVisible({ timeout: 15_000 });
});
