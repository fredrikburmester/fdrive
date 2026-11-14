import { expect, type Page } from "@playwright/test";
import { uniqueName } from "./unique.js";

const HEADERS = { "x-requested-with": "fdrive" };

/**
 * Creates a folder of its own under the root and opens it by URL. The root
 * listing is virtualized with folders first, and a full run leaves enough
 * folders there that a root entry can sit outside the rows a page renders,
 * so a spec never looks for its own folder in it.
 */
export async function openSandbox(page: Page, prefix: string): Promise<string> {
  const sandbox = uniqueName(prefix);
  const created = await page.request.post("/api/v1/fs/mkdir", {
    headers: HEADERS,
    data: { path: `/${sandbox}` },
  });
  expect(created.ok(), await created.text()).toBe(true);
  await page.goto(`/files/${sandbox}`);
  return sandbox;
}

/** Cleanup, not under test: deletes a root folder through the API. */
export async function removeSandbox(page: Page, name: string): Promise<void> {
  const removed = await page.request.post("/api/v1/fs/delete", {
    headers: HEADERS,
    data: { items: [{ path: `/${name}`, kind: "dir" }] },
  });
  expect(removed.ok(), await removed.text()).toBe(true);
}
