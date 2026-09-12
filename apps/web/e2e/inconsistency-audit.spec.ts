import type { JobStatus, SystemImageSearchResponse } from "@fdrive/contracts";
import { expect, test } from "@playwright/test";

test("image maintenance distinguishes warm-up, discovery and completed work", async ({ page }) => {
  let status: SystemImageSearchResponse = {
    configured: true,
    healthy: false,
    status: "loading",
    model: "siglip2-base",
    dim: 1024,
    embedded: 0,
    embeddedModel: null,
  };
  await page.route("**/api/v1/system/image-search", (route) => route.fulfill({ json: status }));
  await page.goto("/system/image-search");
  await expect(page.getByText("The image search model is loading.")).toBeVisible();
  await expect(page.getByText("Unreachable", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Rebuild", exact: true })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath("image-loading.png"), fullPage: true });

  status = {
    ...status,
    healthy: true,
    status: "ok",
    rebuild: {
      running: true,
      processed: 0,
      total: 0,
      totalKnown: false,
      errors: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    },
  };
  await page.reload();
  await expect(page.getByText("Discovering · 0 processed · 0 errors")).toBeVisible();
  await expect(page.getByRole("button", { name: "Rebuild", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Clear embeddings", exact: true })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath("image-discovery.png"), fullPage: true });

  status = {
    ...status,
    rebuild: {
      running: false,
      processed: 10,
      total: 10,
      totalKnown: true,
      errors: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    },
  };
  await page.reload();
  await expect(page.getByText("Completed · 10 of 10 processed · 0 errors")).toBeVisible();
  await expect(page.getByRole("button", { name: "Rebuild", exact: true })).toBeEnabled();
});

test("completed extraction warnings stay visible and cancelled jobs count separately", async ({
  page,
}) => {
  const job: JobStatus = {
    id: "audit-extract",
    kind: "extract",
    state: "done",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    progress: { processed: 1, total: 1, bytes: 42 },
    result: { path: "/docs" },
    error: "Skipped 2 unsafe archive entries (parent traversal and symbolic link).",
  };
  await page.route("**/api/v1/fs/jobs", (route) =>
    route.fulfill({
      json: {
        jobs: [
          job,
          { ...job, id: "audit-cancel", state: "cancelled", error: undefined, result: undefined },
        ],
      },
    }),
  );
  await page.goto("/files");
  const panel = page.locator('[data-slot="activity-panel"]');
  await expect(panel.getByText("1 finished, 1 cancelled")).toBeVisible();
  await expect(panel.getByText(`Warning: ${job.error}`)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("activity-warning.png"), fullPage: true });
});
