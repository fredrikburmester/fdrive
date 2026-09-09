import { expect, test } from "@playwright/test";
import { loginAs } from "./support/login.js";

test.use({ storageState: { cookies: [], origins: [] } });
// Both tests edit the same login's stored override, so they must not share
// it across the suite's parallel workers.
test.describe.configure({ mode: "serial" });

const SEARCH_INPUT_PLACEHOLDER = "Search files, content, and images...";

test("an administrator maps an unmapped virtual folder from a suggestion and search then finds a file inside it", async ({
  page,
}) => {
  await loginAs(page, "scope_admin", "scope-admin-test-password");

  // Before the mapping: the mount is named, index features are off, and the
  // home scope's files are not searchable.
  await page.goto("/account");
  const scope = page.getByLabel("Index status for scope_admin");
  await expect(scope.getByText("Unavailable")).toBeVisible();
  await expect(scope.getByText(/A folder SFTPGo shows is not indexed/)).toBeVisible();
  await expect(
    scope.getByRole("listitem").filter({ hasText: "/shared is not indexed." }),
  ).toBeVisible();

  await scope.getByRole("button", { name: "Map /shared" }).click();
  const form = scope.getByRole("form", { name: "Map /shared" });
  await expect(form.getByLabel("Root")).toContainText("sftpgo");
  // The index knows a directory whose files match the mount's live listing.
  await form.getByRole("button", { name: "Use sftpgo:/_folders/shared" }).click();
  await expect(form.getByLabel("Physical prefix")).toHaveValue("/_folders/shared");
  await expect(
    form.getByRole("checkbox", { name: "Apply to every login that mounts this folder" }),
  ).toBeChecked();
  await form.getByRole("button", { name: "Save mapping" }).click();

  // Saved as a folder-level mapping: adopted here, nothing stored on this login.
  await expect(scope.getByText("Available")).toBeVisible();
  await expect(scope.getByText(/Shared folder mapping, managed under/)).toBeVisible();
  await expect(scope.getByRole("button", { name: "Remove mapping /shared" })).toHaveCount(0);
  await expect(scope.getByText(/authorization boundary/)).toBeVisible();

  await page.goto("/files");
  await page.getByRole("button", { name: "New" }).waitFor();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.getByPlaceholder(SEARCH_INPUT_PLACEHOLDER).fill("team");
  await expect(dialog.getByText("team.txt").first()).toBeVisible();
  await expect(dialog.getByText("/shared/team.txt").first()).toBeVisible();

  // Folder mappings are managed under System > Connection; removing it
  // restores the fixture so a rerun in the same environment starts unmapped.
  await page.goto("/system/connection");
  const card = page.getByLabel("Shared folder mappings");
  await expect(card.getByText("sftpgo:/_folders/shared")).toBeVisible();
  await card.getByRole("button", { name: "Remove shared folder /shared" }).click();
  await expect(page.getByText(/No shared folder mappings yet/)).toBeVisible();
  await page.goto("/account");
  await expect(scope.getByText("Unavailable")).toBeVisible();
});

test("the same form can still save a mapping for one login only", async ({ page }) => {
  await loginAs(page, "scope_admin", "scope-admin-test-password");
  await page.goto("/account");
  const scope = page.getByLabel("Index status for scope_admin");
  await scope.getByRole("button", { name: "Map /shared" }).click();
  const form = scope.getByRole("form", { name: "Map /shared" });
  await form.getByLabel("Physical prefix").fill("/_folders/shared");
  await form
    .getByRole("checkbox", { name: "Apply to every login that mounts this folder" })
    .uncheck();
  await form.getByRole("button", { name: "Save mapping" }).click();
  await expect(scope.getByText("Available")).toBeVisible();
  await expect(scope.getByRole("button", { name: "Remove mapping /shared" })).toBeVisible();
  await scope.getByRole("button", { name: "Remove mapping /shared" }).click();
  await expect(scope.getByText("Unavailable")).toBeVisible();
});

test("marking the folder not indexed restores search over the home scope", async ({ page }) => {
  await loginAs(page, "scope_admin", "scope-admin-test-password");
  await page.goto("/account");
  const scope = page.getByLabel("Index status for scope_admin");
  await scope.getByRole("button", { name: "Mark /shared not indexed" }).click();
  await expect(scope.getByText("Available")).toBeVisible();
  await expect(scope.getByRole("button", { name: "Remove not indexed /shared" })).toBeVisible();

  await page.goto("/files");
  await page.getByRole("button", { name: "New" }).waitFor();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await page.getByPlaceholder(SEARCH_INPUT_PLACEHOLDER).fill("scope-own");
  await expect(dialog.getByText("scope-own.txt").first()).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto("/account");
  await scope.getByRole("button", { name: "Remove not indexed /shared" }).click();
  await expect(scope.getByText("Unavailable")).toBeVisible();
});
