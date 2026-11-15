import { expect, test } from "@playwright/test";
import { loginAs } from "./support/login.js";

// The login page must be exercised signed out.
test.use({ storageState: { cookies: [], origins: [] } });

test("the login page asks for a username and a password, and sends exactly those", async ({
  page,
}) => {
  await page.goto("/login");
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.getByLabel("Server")).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  // A login has a username and a password, nothing more.
  await expect(page.getByLabel(/one-time code/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Use a one-time code" })).toHaveCount(0);
  await expect(page.getByText("Sign in with your fdrive account", { exact: true })).toBeVisible();

  const loginRequest = page.waitForRequest(
    (request) => request.url().endsWith("/api/v1/auth/login") && request.method() === "POST",
  );
  await loginAs(page, "alice", "alice-password");
  expect((await loginRequest).postDataJSON()).toEqual({
    username: "alice",
    password: "alice-password",
  });
  await expect(page).toHaveURL(/\/files$/);
});

test("a username typed in another case signs in to the same account", async ({ page }) => {
  await loginAs(page, "ALICE", "alice-password");
  await expect(page.getByText("alice", { exact: true })).toBeVisible();
});
