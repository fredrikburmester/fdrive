import type { SystemFeaturesResponse, SystemOfficeResponse } from "@fdrive/contracts";
import { expect, test } from "@playwright/test";
import { dismissActivityPanel } from "./support/activity.js";

test("Office onboarding saves and resumes its choice before entering files", async ({ page }) => {
  const featuresUrl = "/api/v1/system/features";
  const officeUrl = "/api/v1/system/office";
  const headers = { "x-requested-with": "fdrive" };
  const features = (await (await page.request.get(featuresUrl)).json()) as SystemFeaturesResponse;
  const office = (await (await page.request.get(officeUrl)).json()) as SystemOfficeResponse;
  expect(
    (
      await page.request.put(featuresUrl, {
        headers,
        data: {
          revision: features.configuration.revision,
          values: features.configuration.values,
          walkthroughComplete: false,
          walkthroughStep: 8,
        },
      })
    ).ok(),
  ).toBe(true);
  try {
    await page.goto("/setup");
    await expect(page.getByText("Step 12 of 13 · Office")).toBeVisible();
    await expect(page.getByRole("button", { name: "Toggle Sidebar" })).toHaveCount(0);
    const toggle = page.getByRole("switch", { name: "Enable ONLYOFFICE" });
    if ((await toggle.getAttribute("aria-checked")) === "false") await toggle.click();
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByText("Ready to use fdrive", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("Step 13 of 13 · Review")).toBeVisible();
    const saved = (await (await page.request.get(officeUrl)).json()) as SystemOfficeResponse;
    expect(saved.configuration.enabled).toBe(true);
    await page.getByRole("button", { name: "Finish setup" }).click();
    await expect(page).toHaveURL(/\/files$/);
    await page.goto("/system/features");
    await expect(page.getByRole("switch", { name: "Enable ONLYOFFICE" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByRole("switch", { name: "Enable ONLYOFFICE" }).click();
    await dismissActivityPanel(page);
    await page.getByRole("button", { name: "Save ONLYOFFICE settings" }).click();
    await expect
      .poll(
        async () =>
          ((await (await page.request.get(officeUrl)).json()) as SystemOfficeResponse).configuration
            .enabled,
      )
      .toBe(false);
  } finally {
    const currentOffice = (await (
      await page.request.get(officeUrl)
    ).json()) as SystemOfficeResponse;
    expect(
      (
        await page.request.put(officeUrl, {
          headers,
          data: { ...office.configuration, revision: currentOffice.configuration.revision },
        })
      ).ok(),
    ).toBe(true);
    const currentFeatures = (await (
      await page.request.get(featuresUrl)
    ).json()) as SystemFeaturesResponse;
    expect(
      (
        await page.request.put(featuresUrl, {
          headers,
          data: {
            revision: currentFeatures.configuration.revision,
            values: features.configuration.values,
            walkthroughComplete: features.configuration.walkthroughComplete,
            walkthroughStep: features.configuration.walkthroughStep,
          },
        })
      ).ok(),
    ).toBe(true);
  }
});
