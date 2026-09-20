import { expect, test } from "@playwright/test";
import { loginAs } from "./support/login.js";

test.use({ storageState: { cookies: [], origins: [] } });

test("a fresh login shows the empty-state copy in favorites, tags and recents", async ({
  page,
}) => {
  await loginAs(page, "sidebar_empty", "sidebar-empty-test-password");

  const sidebar = page.locator('[data-slot="sidebar"]');
  // Each section is collapsible and starts open; only expand the ones a
  // previous spec's stored preference left collapsed, so this does not toggle
  // an already-open section closed.
  for (const section of ["Favorites", "Tags", "Recents"]) {
    const trigger = sidebar.getByRole("button", { name: section, exact: true });
    if ((await trigger.getAttribute("aria-expanded")) === "false") await trigger.click();
  }

  await expect(sidebar.getByText("Star a file to see it here")).toBeVisible();
  await expect(sidebar.getByText("No tags yet")).toBeVisible();
  await expect(sidebar.getByText("Files you open show up here")).toBeVisible();
});
