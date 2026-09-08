import { expect, type Page, test } from "@playwright/test";
import { loginAs } from "./support/login.js";
import { uniqueName } from "./support/unique.js";

test.describe.configure({ mode: "serial" });
test.use({ storageState: { cookies: [], origins: [] } });
test.beforeEach(async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ "x-requested-with": "fdrive" });
  await loginAs(page, "folder_views", "folder-views-test-password");
});

async function folder(page: Page, path: string) {
  const response = await page.request.post("/api/v1/fs/mkdir", { data: { path } });
  expect(response.ok()).toBe(true);
}
async function mode(page: Page, name: "List" | "Grid" | "Tree") {
  await page.getByRole("button", { name: "View", exact: true }).click();
  await expect(page.getByRole("menuitemradio", { name, exact: false })).toBeEnabled();
  await page.getByRole("menuitemradio", { name, exact: false }).click();
}
async function expectMode(page: Page, name: "List" | "Grid" | "Tree") {
  await page.getByRole("button", { name: "View", exact: true }).click();
  await expect(page.getByRole("menuitemradio", { name, exact: false })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");
}
async function action(page: Page, name: string) {
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

test("folder pins survive reload and another browser; siblings and children inherit only default", async ({
  page,
  browser,
}) => {
  const root = `/${uniqueName("folder-view")}`;
  await page.goto("/files");
  await folder(page, root);
  await folder(page, `${root}/photos`);
  await folder(page, `${root}/photos/child`);
  await folder(page, `${root}/sibling`);
  await page.goto(`/files${root}/photos`);
  await mode(page, "Grid");
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/v1/folder-views?path=${root}/photos`)).json()).view
          ?.mode,
    )
    .toBe("grid");
  await page.reload();
  await expectMode(page, "Grid");
  await page.goto(`/files${root}/photos/child`);
  await expectMode(page, "List");
  await page.goto(`/files${root}/sibling`);
  await expectMode(page, "List");

  const state = await page.context().storageState();
  const other = await browser.newContext({
    storageState: { cookies: state.cookies, origins: [] },
    baseURL: new URL(page.url()).origin,
  });
  try {
    const tab = await other.newPage();
    await tab.goto(`/files${root}/photos`);
    await expectMode(tab, "Grid");
  } finally {
    await other.close();
  }

  await page.goto(`/files${root}/photos`);
  await action(page, "Use as default for all folders");
  await page.goto(`/files${root}/sibling`);
  await expectMode(page, "Grid");
  await mode(page, "Tree");
  await page.goto(`/files${root}/photos`);
  await mode(page, "List");
  await action(page, "Use as default for all folders");
  await page.goto(`/files${root}/sibling`);
  await expectMode(page, "Tree");
  await action(page, "Use default view");
  await expectMode(page, "List");
});

test("rename carries subtree pins, and account reset removes them", async ({ page }) => {
  const root = `/${uniqueName("folder-view-reset")}`;
  await page.goto("/files");
  await folder(page, root);
  await folder(page, `${root}/child`);
  await page.goto(`/files${root}/child`);
  await mode(page, "Tree");
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/v1/folder-views?path=${root}/child`)).json()).view
          ?.mode,
    )
    .toBe("tree");
  const renamed = `${root}-renamed`;
  expect(
    (
      await page.request.post("/api/v1/fs/rename", {
        data: { path: root, newName: renamed.slice(1) },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/files${renamed}/child`);
  await expectMode(page, "Tree");
  await page.goto("/account");
  await page.getByRole("button", { name: "Reset all folder views", exact: true }).click();
  await expect(
    page.getByText("All folders now use the default view.", { exact: true }),
  ).toBeVisible();
  await page.goto(`/files${renamed}/child`);
  await expectMode(page, "List");
});

test("failed writes restore the previous view", async ({ page }) => {
  const root = `/${uniqueName("folder-view-error")}`;
  await page.goto("/files");
  await folder(page, root);
  await page.goto(`/files${root}`);
  await page.route("**/api/v1/folder-views", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "unavailable", message: "Offline" } }),
      });
    } else await route.continue();
  });
  await mode(page, "Grid");
  await expect(page.getByText("Could not save the folder view.", { exact: true })).toBeVisible();
  await expectMode(page, "List");
});

test("mobile View submenu saves the current folder and offers both default actions", async ({
  page,
}) => {
  const root = `/${uniqueName("folder-view-mobile")}`;
  await folder(page, root);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/files${root}`);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Grid" }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/v1/folder-views?path=${root}`)).json()).view?.mode,
    )
    .toBe("grid");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "Use as default for all folders", exact: true }),
  ).toBeEnabled();
  await page.getByRole("menuitem", { name: "Use default view", exact: true }).click();
  await expect
    .poll(
      async () => (await (await page.request.get(`/api/v1/folder-views?path=${root}`)).json()).view,
    )
    .toBeNull();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);
});

test("favorites and tags follow the global default without inheriting a folder pin", async ({
  page,
}) => {
  const root = `/${uniqueName("folder-view-virtual")}`;
  await folder(page, root);
  await folder(page, `${root}/child`);
  await page.goto(`/files${root}`);
  await mode(page, "Tree");
  expect((await page.request.post("/api/v1/favorites", { data: { path: root } })).ok()).toBe(true);
  const tagResponse = await page.request.post("/api/v1/tags", {
    data: { name: uniqueName("view-tag") },
  });
  expect(tagResponse.ok()).toBe(true);
  const tag = await tagResponse.json();
  for (const path of [root, `${root}/child`]) {
    expect(
      (await page.request.put("/api/v1/fs/tags", { data: { path, tagIds: [tag.id] } })).ok(),
    ).toBe(true);
  }
  await page.goto("/account");
  await page
    .getByRole("group", { name: "Default view", exact: true })
    .getByRole("button", { name: "Grid", exact: true })
    .click();
  await page.goto("/favorites");
  await expect(page.locator('[data-slot="account-favorites-grid"]')).toBeVisible();
  await page.goto(`/tags/${tag.id}`);
  await expect(page.locator('[data-slot="file-grid"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "View", exact: true })).toHaveCount(0);
  await page.goto("/account");
  await page
    .getByRole("group", { name: "Default view", exact: true })
    .getByRole("button", { name: "Tree", exact: true })
    .click();
  await page.goto(`/tags/${tag.id}`);
  const parent = page.locator(`[data-path="${root}"]`);
  await parent.getByRole("button", { name: `Expand ${root.slice(1)}`, exact: true }).click();
  await expect(page.locator(`[data-path="${root}/child"]`)).toHaveCount(1);
});
