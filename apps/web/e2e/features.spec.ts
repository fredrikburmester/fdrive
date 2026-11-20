import type { SystemFeaturesResponse } from "@fdrive/contracts";
import { expect, test } from "@playwright/test";
import { dismissActivityPanel } from "./support/activity.js";

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
    await expect(page.getByText("Step 3 of 11 · Thumbnails")).toBeVisible();
    await expect(page.getByText("Check your storage")).toHaveCount(0);
    await expect(page.getByText("Advanced storage settings")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Toggle Sidebar" })).toHaveCount(0);

    for (const label of [
      "Enable thumbnails",
      "Enable full-text search",
      "Enable search ocr",
      "Enable semantic search",
      "Enable image search",
      "Enable searchable pdfs",
    ]) {
      await expect(page.getByRole("switch", { name: label })).toBeVisible();
      await expect(page).toHaveURL(/\/setup$/);
      await page.getByRole("button", { name: "Skip this feature" }).click();
      if (label === "Enable thumbnails") {
        await expect(page.getByRole("switch", { name: "Enable full-text search" })).toBeVisible();
        await page.reload();
        await expect(page.getByText("Set up fdrive", { exact: true })).toBeVisible();
      }
    }

    // Trash is always on, so the walkthrough goes straight on to the address.
    await expect(page.getByText("Step 9 of 11 · Server address")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Server address")).not.toHaveValue("");
    await expect(page.getByRole("switch", { name: "Enable Trash" })).toHaveCount(0);
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByText("Step 10 of 11 · Office")).toBeVisible();
    await page.getByRole("button", { name: "Skip ONLYOFFICE" }).click();
    await expect(page.getByText("Ready to use fdrive", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Finish setup" }).click();
    await expect(page).toHaveURL(/\/files$/);
    // Skipped features are off, and each is switched back on in its own System area.
    await page.goto("/system/thumbnails");
    await expect(page.getByText("Thumbnails is off")).toBeVisible();
    await expect(page.getByRole("switch", { name: "Enable thumbnails" })).not.toBeChecked();
    await expect(page.getByRole("link", { name: "Manage features" })).toHaveCount(0);
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

test("the Features page is gone: its address opens System, where each area has its own switch", async ({
  page,
}) => {
  await page.goto("/system/features");

  await expect(page).toHaveURL(/\/system$/);
  await expect(page.getByRole("heading", { level: 1, name: "General" })).toBeVisible();
  const areas = page.getByRole("navigation", { name: "System areas" });
  await expect(areas.getByRole("link", { name: "Features" })).toHaveCount(0);
  await areas.getByRole("link", { name: "Thumbnails", exact: true }).click();
  await expect(page).toHaveURL(/\/system\/thumbnails$/);
  await expect(page.getByRole("switch", { name: "Enable thumbnails" })).toBeVisible();
});

test("alice (admin) runs the setup walkthrough again from System > General", async ({ page }) => {
  const endpoint = "/api/v1/system/features";
  const original = (await (await page.request.get(endpoint)).json()) as SystemFeaturesResponse;
  try {
    await page.goto("/system/general");
    // Jobs left by earlier specs can put the Activity panel over the end of the sheet's rows.
    await dismissActivityPanel(page);
    await page.getByRole("button", { name: "Run walkthrough" }).click();

    // The walkthrough lives outside the shell and starts over at its first step.
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByText("Step 3 of 11 · Thumbnails")).toBeVisible();
    await expect(page.getByRole("button", { name: "Toggle Sidebar" })).toHaveCount(0);
    // Starting it changes no choice: the features are as they were.
    const started = (await (await page.request.get(endpoint)).json()) as SystemFeaturesResponse;
    expect(started.configuration.values).toEqual(original.configuration.values);
    expect(started.configuration.walkthroughComplete).toBe(false);
    expect(started.configuration.walkthroughStep).toBe(0);
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
