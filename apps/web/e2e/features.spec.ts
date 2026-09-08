import type { FeaturesUpdateRequest, SystemFeaturesResponse } from "@fdrive/contracts";
import { expect, test } from "@playwright/test";

const off = {
  thumbnails: false,
  textSearch: false,
  searchOcr: false,
  semanticSearch: false,
  imageSearch: false,
  pdfOcr: false,
};

test("an owner can finish the optional-feature walkthrough with every feature off", async ({
  page,
}) => {
  let response: SystemFeaturesResponse = {
    source: "settings",
    configuration: {
      version: 1,
      revision: 1,
      values: off,
      walkthroughComplete: false,
      walkthroughStep: 0,
    },
    statuses: [],
    roots: [],
  };
  await page.route("**/api/v1/system/features", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: response });
      return;
    }
    const request = route.request().postDataJSON() as FeaturesUpdateRequest;
    response = {
      ...response,
      configuration: {
        version: 1,
        revision: response.configuration.revision + 1,
        values: request.values,
        walkthroughComplete: request.walkthroughComplete,
        ...(request.walkthroughStep === undefined
          ? {}
          : { walkthroughStep: request.walkthroughStep }),
      },
    };
    await route.fulfill({ json: response });
  });

  await page.goto("/system/features");
  await expect(page.getByText("Step 1 of 8 · Storage")).toBeVisible();
  await page.getByRole("button", { name: "Save and continue" }).click();

  for (const label of [
    "Enable thumbnails",
    "Enable full-text search",
    "Enable search ocr",
    "Enable semantic search",
    "Enable image search",
    "Enable searchable pdfs",
  ]) {
    await expect(page.getByRole("switch", { name: label })).toBeVisible();
    await page.getByRole("button", { name: "Skip this feature" }).click();
  }

  await expect(page.getByText("Ready to use fdrive", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(/\/files$/);

  await page.goto("/system/thumbnails");
  await expect(page.getByText("Thumbnails is off")).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage features" })).toHaveAttribute(
    "href",
    "/system/features",
  );
});
