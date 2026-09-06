import type { Page } from "@playwright/test";

/** Fills and submits the login form as `username`/`password`, without waiting for the result. */
export async function fillLoginForm(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
}

/**
 * Logs in as `username`/`password` through the UI and waits for `/files` to
 * load and become interactive. Waiting for the toolbar's "New" button (not
 * just the URL) matters: the URL changes as soon as the client router
 * commits to `/files`, but the shell's own client components (the sidebar's
 * data-driven sections, the global Cmd/Ctrl+K listener, and so on) still
 * need a moment to hydrate; a caller that acts immediately after `loginAs`
 * (a keyboard shortcut, in particular) can otherwise silently miss it.
 */
export async function loginAs(page: Page, username: string, password: string): Promise<void> {
  await fillLoginForm(page, username, password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/files");
  await page.getByRole("button", { name: "New" }).waitFor();
}
