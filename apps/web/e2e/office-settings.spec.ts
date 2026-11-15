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
          walkthroughStep: 7,
        },
      })
    ).ok(),
  ).toBe(true);
  try {
    await page.goto("/setup");
    await expect(page.getByText("Step 10 of 11 · Office")).toBeVisible();
    await expect(page.getByRole("button", { name: "Toggle Sidebar" })).toHaveCount(0);
    const toggle = page.getByRole("switch", { name: "Enable ONLYOFFICE" });
    if ((await toggle.getAttribute("aria-checked")) === "false") await toggle.click();
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByText("Ready to use fdrive", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("Step 11 of 11 · Review")).toBeVisible();
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

test("System > Office chooses editors from fdrive's users", async ({ page }) => {
  const officeUrl = "/api/v1/system/office";
  const headers = { "x-requested-with": "fdrive" };
  const read = async () =>
    ((await (await page.request.get(officeUrl)).json()) as SystemOfficeResponse).configuration;
  const office = await read();
  try {
    // The page offers its settings while Office is on.
    expect(
      (
        await page.request.put(officeUrl, {
          headers,
          data: { ...office, enabled: true, editingEnabled: false, editorUsernames: [] },
        })
      ).ok(),
    ).toBe(true);
    await page.goto("/system/office");
    await dismissActivityPanel(page);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("switch", { name: "Allow document editing" }).click();
    // Every user is offered, and nothing can be saved until one is chosen.
    for (const username of ["alice", "bob", "carol"])
      await expect(page.getByRole("checkbox", { name: username, exact: true })).toBeVisible();
    await expect(
      page.getByText("When editing is enabled, choose at least one user."),
    ).toBeVisible();
    await page.getByRole("checkbox", { name: "bob", exact: true }).click();
    await page.getByRole("checkbox", { name: "carol", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await read()).editorUsernames).toEqual(["bob", "carol"]);
    // The sheet closes and the page lists the editors.
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByText("carol", { exact: true })).toBeVisible();
  } finally {
    const current = await read();
    expect(
      (
        await page.request.put(officeUrl, {
          headers,
          data: { ...office, revision: current.revision },
        })
      ).ok(),
    ).toBe(true);
  }
});
