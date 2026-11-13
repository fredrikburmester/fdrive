import { stat } from "node:fs/promises";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { dismissActivityPanel } from "./support/activity.js";
import { homePath } from "./support/local-folder.js";
import { fillLoginForm, loginAs } from "./support/login.js";
import { sidebar } from "./support/regions.js";
import { uniqueName } from "./support/unique.js";

// Every action here is alice's, from the default storage state; the person
// she manages signs in from a browser context of their own.

/** The person's own signed-out browser, on the shared run's web app. */
async function personPage(browser: Browser, page: Page): Promise<Page> {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    baseURL: new URL(page.url()).origin,
  });
  return context.newPage();
}

function row(page: Page, username: string) {
  return page.getByRole("row").filter({ has: page.getByText(username, { exact: true }) });
}

/** Opens the row's Actions menu and picks `item`. */
async function act(page: Page, username: string, item: string): Promise<void> {
  await dismissActivityPanel(page);
  await row(page, username)
    .getByRole("button", { name: `Actions for ${username}` })
    .click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

/** A sign-in the server refuses: the form stays on /login with an error line. */
async function expectRefused(person: Page, username: string, password: string): Promise<void> {
  await fillLoginForm(person, username, password);
  await person.getByRole("button", { name: "Sign in" }).click();
  await expect(person.locator('[data-slot="field-error"]')).toBeVisible();
  await expect(person).toHaveURL(/\/login$/);
}

/** True once `person`'s session is gone: a reload of /files lands on /login. */
async function expectSignedOut(person: Page): Promise<void> {
  await person.goto("/files");
  await expect(person).toHaveURL(/\/login$/);
}

test("an administrator adds a user who signs in to a folder of their own, then resets their password, makes them an administrator, disables and removes them", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const username = uniqueName("person");
  const password = "first-password-1";
  const replaced = "second-password-2";

  await page.goto("/files");
  await sidebar(page).getByRole("link", { name: "Users", exact: true }).click();
  await expect(page).toHaveURL(/\/system\/users$/);
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  // alice is listed as herself; nobody can disable or remove themselves.
  const alice = row(page, "alice");
  await expect(alice.getByText("You", { exact: true })).toBeVisible();
  await expect(alice.getByText("Admin", { exact: true })).toBeVisible();
  await expect(alice.getByRole("button", { name: "Actions for alice" })).toHaveCount(0);
  await expect(row(page, "bob")).toBeVisible();

  // Add: a username, a first password, not an administrator.
  await page.getByRole("button", { name: "Add user" }).click();
  const add = page.getByRole("dialog", { name: "Add user" });
  await add.getByLabel("Username").fill("alice");
  await add.getByLabel("Password").fill(password);
  await add.getByRole("button", { name: "Add user" }).click();
  await expect(add.getByText("A user with this name already exists.")).toBeVisible();
  await add.getByLabel("Username").fill(username);
  await expect(add.getByRole("switch", { name: "Administrator" })).not.toBeChecked();
  await add.getByRole("button", { name: "Add user" }).click();
  await expect(add).toBeHidden();
  await expect(page.getByText(`Added ${username}.`)).toBeVisible();
  await expect(row(page, username).getByText("Never", { exact: true })).toBeVisible();

  // They sign in to an empty folder of their own, with no System pages.
  const person = await personPage(browser, page);
  try {
    await loginAs(person, username, password);
    await expect
      .poll(async () => (await stat(homePath(username)).catch(() => null))?.isDirectory())
      .toBe(true);
    await expect(sidebar(person).getByRole("link", { name: "Users", exact: true })).toHaveCount(0);
    expect((await person.request.get("/api/v1/admin/users")).status()).toBe(403);
    await page.reload();
    await expect(row(page, username).getByText("Never", { exact: true })).toHaveCount(0);

    // Reset password: their session ends, and only the new password works.
    await act(page, username, "Reset password");
    const reset = page.getByRole("dialog", { name: `Reset password for ${username}` });
    await reset.getByLabel("New password").fill(replaced);
    await reset.getByRole("button", { name: "Reset password" }).click();
    await expect(reset).toBeHidden();
    await expect(page.getByText(`Changed the password of ${username}.`)).toBeVisible();
    await expectSignedOut(person);
    await expectRefused(person, username, password);
    await loginAs(person, username, replaced);

    // Make administrator: System appears for them.
    await act(page, username, "Make administrator");
    await expect(page.getByText(`${username} is now an administrator.`)).toBeVisible();
    await expect(row(page, username).getByText("Admin", { exact: true })).toBeVisible();
    await person.goto("/system/users");
    await expect(person).toHaveURL(/\/system\/users$/);
    await expect(sidebar(person).getByRole("link", { name: "Users", exact: true })).toBeVisible();
    await act(page, username, "Remove administrator");
    await expect(page.getByText(`${username} is no longer an administrator.`)).toBeVisible();
    await expect(row(page, username).getByText("Admin", { exact: true })).toHaveCount(0);

    // Disable: signed out at once and refused at sign-in, until enabled again.
    await act(page, username, "Disable");
    await expect(page.getByText(`Disabled ${username} and signed them out.`)).toBeVisible();
    await expect(row(page, username).getByText("Disabled", { exact: true })).toBeVisible();
    await expectSignedOut(person);
    await expectRefused(person, username, replaced);
    await act(page, username, "Enable");
    await expect(page.getByText(`${username} can sign in again.`)).toBeVisible();
    await loginAs(person, username, replaced);

    // Remove: confirmed, signed out, refused; their files stay on disk.
    await act(page, username, "Remove");
    const confirm = page.getByRole("alertdialog", { name: `Remove ${username}?` });
    await expect(confirm.getByText(/Their files stay in their folder/)).toBeVisible();
    await confirm.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(row(page, username)).toHaveCount(0);
    await expectSignedOut(person);
    await expectRefused(person, username, replaced);
    expect((await stat(homePath(username))).isDirectory()).toBe(true);
  } finally {
    await person.context().close();
  }
});
