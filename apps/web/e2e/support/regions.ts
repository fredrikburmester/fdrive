import type { Locator, Page } from "@playwright/test";

/**
 * The file browser's listing container: `[data-slot="file-list"]` in list
 * view and tree view (both render `FileList`, see `file-list.tsx`), or
 * `[data-slot="file-grid"]` in grid view (`file-grid.tsx`). Only one of the
 * two is ever mounted at a time, so this single locator covers all three
 * view modes.
 *
 * Scope entry-name queries to this locator instead of querying `page`
 * globally. The sidebar's folder tree (`folder-tree.tsx`) renders the very
 * same folder names as links, and auto-expands ancestors of the current
 * route (and keeps folders visited earlier in the test expanded, since its
 * expansion state only grows within a session), so an unscoped
 * `page.getByText(name, { exact: true })` can resolve to two elements once
 * a folder with that name is visible both in the tree and in the listing.
 */
export function listing(page: Page): Locator {
  return page.locator('[data-slot="file-list"], [data-slot="file-grid"]');
}

/**
 * The sidebar region (`Sidebar` in `components/ui/sidebar.tsx`), for
 * assertions specifically about the folder tree rather than the listing.
 */
export function sidebar(page: Page): Locator {
  return page.locator('[data-slot="sidebar"]');
}
