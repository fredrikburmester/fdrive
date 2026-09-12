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

for (const ext of ["html", "svg"]) {
  test(`active ${ext} downloads cannot act through the browser session`, async ({ page }) => {
    const path = `/active-preview.${ext}`;
    const sentinel = `/xss-sentinel-${ext}`;
    const script = `fetch('/api/v1/fs/mkdir',{method:'POST',headers:{'x-requested-with':'fdrive','content-type':'application/json'},body:JSON.stringify({path:'${sentinel}'})})`;
    const payload =
      ext === "svg"
        ? `<svg xmlns="http://www.w3.org/2000/svg"><script>${script}</script></svg>`
        : `<html><script>${script}</script></html>`;
    const upload = await page.request.put(`/api/v1/fs/upload?path=${encodeURIComponent(path)}`, {
      headers: { "x-requested-with": "fdrive" },
      data: payload,
    });
    expect(upload.ok()).toBe(true);
    const url = `/api/v1/fs/download?path=${encodeURIComponent(path)}&inline=1`;
    const response = await page.request.get(url);
    expect(response.headers()["content-disposition"]).toContain("attachment");
    expect(response.headers()["content-security-policy"]).toBe("sandbox");
    await page.goto(`/view${path}`);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Open in new tab" }).click();
    expect((await download).suggestedFilename()).toBe(`active-preview.${ext}`);
    const direct = page.waitForEvent("download");
    await page.goto(url).catch(() => undefined);
    expect((await direct).suggestedFilename()).toBe(`active-preview.${ext}`);
    const stat = await page.request.get(`/api/v1/fs/stat?path=${encodeURIComponent(sentinel)}`);
    expect(stat.status()).toBe(404);
  });
}
