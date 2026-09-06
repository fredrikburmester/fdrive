import type { Page } from "@playwright/test";

/** Fills and submits the login form as `username`/`password`, without waiting for the result. */
export async function fillLoginForm(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
}

/** Logs in as `username`/`password` through the UI and waits for `/files` to load. */
export async function loginAs(page: Page, username: string, password: string): Promise<void> {
  await fillLoginForm(page, username, password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/files");
}
