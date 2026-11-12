import { expect, type Page, test } from "@playwright/test";

async function sidebarWidth(page: Page): Promise<number> {
  const box = await page.locator('[data-slot="sidebar-container"]').boundingBox();
  return box?.width ?? 0;
}

async function pageLeftEdge(page: Page): Promise<number> {
  const box = await page.locator('[data-slot="sidebar-inset"]').boundingBox();
  return box?.x ?? 0;
}

test("dragging the sidebar's edge resizes it, the page follows, and the width survives a reload", async ({
  page,
}) => {
  await page.goto("/files");
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  await expect(handle).toBeVisible();
  expect(await sidebarWidth(page)).toBe(256);

  const box = await handle.boundingBox();
  if (box === null) throw new Error("The resize handle has no box.");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, y, { steps: 8 });
  // Mid-drag the sidebar tracks the pointer rather than easing towards it.
  expect(await sidebarWidth(page)).toBe(336);
  await page.mouse.up();
  expect(await pageLeftEdge(page)).toBe(336);

  await page.reload();
  await expect(handle).toBeVisible();
  await expect.poll(() => sidebarWidth(page)).toBe(336);
  await expect.poll(() => pageLeftEdge(page)).toBe(336);

  // Collapsed, the sidebar leaves nothing to grab; double-click restores the default width.
  await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  await expect(handle).toBeHidden();
  await expect.poll(() => pageLeftEdge(page)).toBe(0);
  await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  await expect(handle).toBeVisible();
  await handle.dblclick();
  await expect.poll(() => sidebarWidth(page)).toBe(256);
});
