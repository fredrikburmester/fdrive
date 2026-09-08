import { expect, type Page } from "@playwright/test";
import { uniqueName } from "./unique.js";

/** View changes are server preferences now; never pin the shared fixture root. */
export async function createViewFolder(page: Page, seed = false): Promise<string> {
  const path = `/${uniqueName("view")}`;
  const headers = { "x-requested-with": "fdrive" };
  expect((await page.request.post("/api/v1/fs/mkdir", { headers, data: { path } })).ok()).toBe(
    true,
  );
  if (seed) {
    for (const name of ["docs", "photo.jpg"]) {
      expect(
        (
          await page.request.post("/api/v1/fs/copy", {
            headers,
            data: { path: `/${name}`, target: `${path}/${name}` },
          })
        ).ok(),
      ).toBe(true);
    }
  }
  await page.goto(`/files${path}`);
  return path;
}
