import { expect, type Locator, type Page, test } from "@playwright/test";
import { fillLoginForm, loginAs } from "./support/login.js";
import { PASSWORD_USER } from "./support/people-fixture.js";

test.use({ storageState: { cookies: [], origins: [] } });

const NEW_PASSWORD = "password-user-new-password";

/** Settings > Password: the sheet with the three password fields. */
function passwordSection(page: Page): Locator {
  return page.getByRole("region", { name: "Password", exact: true });
}

/** Fills the Password section's form and submits it. */
async function changePassword(page: Page, current: string, next: string): Promise<void> {
  const section = passwordSection(page);
  await section.getByLabel("Current password").fill(current);
  await section.getByLabel("New password", { exact: true }).fill(next);
  await section.getByLabel("Confirm new password").fill(next);
  await section.getByRole("button", { name: "Change password" }).click();
}

test("a local login changes its own password in Settings, which signs out its other sessions", async ({
  page,
  browser,
}) => {
  const { username, password } = PASSWORD_USER;
  await loginAs(page, username, password);
  const other = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    baseURL: new URL(page.url()).origin,
  });
  try {
    const otherSession = await other.newPage();
    await loginAs(otherSession, username, password);

    await page.goto("/account/password");
    const section = passwordSection(page);
    await expect(section.getByText(`The password ${username} signs in with.`)).toBeVisible();
    const submit = section.getByRole("button", { name: "Change password" });
    await expect(submit).toBeDisabled();

    // A repeat that does not match keeps the form closed.
    await section.getByLabel("Current password").fill(password);
    await section.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await section.getByLabel("Confirm new password").fill(`${NEW_PASSWORD}-typo`);
    await expect(section.getByText("The passwords don't match.")).toBeVisible();
    await expect(submit).toBeDisabled();

    // The wrong current password is refused and changes nothing.
    await changePassword(page, "not-the-current-password", NEW_PASSWORD);
    await expect(section.locator('[data-slot="field-error"]')).toBeVisible();

    await changePassword(page, password, NEW_PASSWORD);
    await expect(
      page.getByText("Password changed. Your other sessions were signed out."),
    ).toBeVisible();
    await expect(section.getByLabel("Current password")).toHaveValue("");

    // This session stays signed in; the other one is signed out.
    await page.goto("/files");
    await expect(page).toHaveURL(/\/files$/);
    await otherSession.goto("/files");
    await expect(otherSession).toHaveURL(/\/login$/);
    await fillLoginForm(otherSession, username, password);
    await otherSession.getByRole("button", { name: "Sign in" }).click();
    await expect(otherSession.locator('[data-slot="field-error"]')).toBeVisible();
    await loginAs(otherSession, username, NEW_PASSWORD);

    // Back to the seeded password, so a retry starts from the same state.
    await page.goto("/account/password");
    await changePassword(page, NEW_PASSWORD, password);
    await expect(
      page.getByText("Password changed. Your other sessions were signed out."),
    ).toBeVisible();
  } finally {
    await other.close();
  }
});
