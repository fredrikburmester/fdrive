import type { SystemFeaturesResponse } from "@fdrive/contracts";
import { expect, test } from "@playwright/test";

const off = {
  thumbnails: false,
  textSearch: false,
  searchOcr: false,
  semanticSearch: false,
  imageSearch: false,
  pdfOcr: false,
};

test("an owner resumes and finishes setup without entering the application shell", async ({
  page,
}) => {
  const endpoint = "/api/v1/system/features";
  const original = (await (await page.request.get(endpoint)).json()) as SystemFeaturesResponse;
  const started = await page.request.put(endpoint, {
    headers: { "x-requested-with": "fdrive" },
    data: {
      revision: original.configuration.revision,
      values: off,
      walkthroughComplete: false,
      walkthroughStep: 0,
    },
  });
  expect(started.ok()).toBe(true);
  try {
    await page.goto("/setup");
    await expect(page.getByText("Step 4 of 13 · Thumbnails")).toBeVisible();
    await expect(page.getByText("Inspect SFTPGo users")).toHaveCount(0);
    await expect(page.getByText("Check your storage")).toHaveCount(0);
    await expect(page.getByText("Advanced storage settings")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Toggle Sidebar" })).toHaveCount(0);

    for (const [label, caption] of [
      ["Enable thumbnails", "Step 4 of 13 · Thumbnails"],
      ["Enable full-text search", "Step 5 of 13 · Full-text search"],
      ["Enable search ocr", "Step 6 of 13 · Search OCR"],
      ["Enable semantic search", "Step 7 of 13 · Semantic search"],
      ["Enable image search", "Step 8 of 13 · Image search"],
      ["Enable searchable pdfs", "Step 9 of 13 · Searchable PDFs"],
    ] as const) {
      await expect(page.getByText(caption)).toBeVisible();
      await expect(page.getByRole("switch", { name: label })).toBeVisible();
      await expect(page).toHaveURL(/\/setup$/);
      await page.getByRole("button", { name: "Skip this feature" }).click();
      if (label === "Enable thumbnails") {
        await expect(page.getByRole("switch", { name: "Enable full-text search" })).toBeVisible();
        await page.reload();
        await expect(page.getByText("Set up fdrive", { exact: true })).toBeVisible();
      }
    }

    await expect(page.getByText("Step 10 of 13 · Trash")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("switch", { name: "Enable Trash" })).toBeVisible();
    await page.getByRole("button", { name: "Skip Trash" }).click();
    await expect(page.getByText("Step 11 of 13 · Server address")).toBeVisible();
    await expect(page.getByLabel("Server address")).not.toHaveValue("");
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByText("Step 12 of 13 · Office")).toBeVisible();
    await page.getByRole("button", { name: "Skip ONLYOFFICE" }).click();
    await expect(page.getByText("Ready to use fdrive", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Finish setup" }).click();
    await expect(page).toHaveURL(/\/files$/);
    await page.goto("/system/thumbnails");
    await expect(page.getByText("Thumbnails is off")).toBeVisible();
    await expect(page.getByRole("link", { name: "Manage features" })).toHaveAttribute(
      "href",
      "/system/features",
    );
  } finally {
    const current = (await (await page.request.get(endpoint)).json()) as SystemFeaturesResponse;
    const restored = await page.request.put(endpoint, {
      headers: { "x-requested-with": "fdrive" },
      data: {
        revision: current.configuration.revision,
        values: original.configuration.values,
        walkthroughComplete: true,
        walkthroughStep: 0,
      },
    });
    expect(restored.ok()).toBe(true);
  }
});
