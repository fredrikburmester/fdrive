import { expect, test } from "@playwright/test";

test("alice creates an API token, sees it once, the list shows it, and can revoke it", async ({
  page,
}) => {
  await page.goto("/files");

  // Reach /account through the sidebar footer menu, not by direct navigation,
  // so this also proves the "Account" item is wired up.
  await page.getByRole("button", { name: "alice" }).click();
  await page.getByRole("menuitem", { name: "Account" }).click();
  await expect(page).toHaveURL(/\/account$/);

  await expect(page.getByText("API tokens", { exact: true })).toBeVisible();
  await expect(page.getByText("No tokens yet.")).toBeVisible();

  const tokenName = `Playwright ${Date.now()}`;

  await page.getByRole("button", { name: "Create token" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create API token" });
  await createDialog.getByLabel("Name").fill(tokenName);
  await createDialog.getByRole("button", { name: "Create token" }).click();

  // The "shown once" dialog: the raw secret is visible now.
  const createdDialog = page.getByRole("dialog", { name: "Token created" });
  await expect(createdDialog).toBeVisible();
  await expect(createdDialog.getByText(/only time you will see this token/i)).toBeVisible();
  const tokenValue = await createdDialog.locator("input[readonly]").first().inputValue();
  expect(tokenValue).toMatch(/^fdr_/);

  await createdDialog.getByRole("button", { name: "Done" }).click();
  await expect(createdDialog).toBeHidden();

  // The list shows it (without the secret).
  const row = page.getByRole("row", { name: new RegExp(tokenName) });
  await expect(row).toBeVisible();
  await expect(row.getByText(tokenValue)).toHaveCount(0);

  // Revoke it.
  await row.getByRole("button", { name: "Revoke" }).click();
  const revokeDialog = page.getByRole("alertdialog");
  await expect(revokeDialog).toBeVisible();
  await revokeDialog.getByRole("button", { name: "Revoke" }).click();

  await expect(page.getByRole("row", { name: new RegExp(tokenName) })).toHaveCount(0);
});
