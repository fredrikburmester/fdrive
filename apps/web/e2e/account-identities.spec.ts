import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { loginAs } from "./support/login.js";
import { getAliceStorageStatePath } from "./support/paths.js";
import { listing } from "./support/regions.js";

test.use({ storageState: { cookies: [], origins: [] } });

test("links, switches, finds both owners of one path, and unlinks a login", async ({ page }) => {
  await loginAs(page, "account_left", "account-left-test-password");
  await page.goto("/account");
  await expect(page.getByRole("button", { name: "Unlink account_left" })).toBeDisabled();
  await page.getByRole("button", { name: "Link login", exact: true }).click();
  const link = page.getByRole("dialog", { name: "Link login" });
  await link.getByLabel("Username").fill("account_right");
  await link.getByLabel("Password").fill("account-right-test-password");
  await link.getByRole("button", { name: "Link login" }).click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByText("right-only.txt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /account_right/ }).click();
  await page.getByRole("menuitemradio", { name: /account_left/ }).click();
  await expect(page.getByText("left-only.txt", { exact: true })).toBeVisible();
  const meResponse = await page.request.get("/api/v1/auth/me");
  expect(meResponse.ok()).toBe(true);
  const me = (await meResponse.json()) as { identities: { id: string; username: string }[] };
  const left = me.identities.find((identity) => identity.username === "account_left");
  const right = me.identities.find((identity) => identity.username === "account_right");
  if (!left || !right) throw new Error("linked identities missing");
  for (const identity of [left, right]) {
    const favorite = await page.request.post("/api/v1/favorites", {
      headers: { "x-requested-with": "fdrive", "x-identity-id": identity.id },
      data: { path: "/same.txt" },
    });
    expect(favorite.ok()).toBe(true);
  }
  await page.goto("/favorites");
  await expect(page.getByRole("button", { name: "same.txt", exact: true })).toHaveCount(2);
  const otherFavorite = page.getByRole("row").filter({ hasText: "account_right" });
  await otherFavorite.getByRole("button", { name: "Reveal in folder" }).click();
  await expect(page).toHaveURL(/\/files(?:\?select=same.txt)?$/);
  await expect(page.getByText("right-only.txt", { exact: true })).toBeVisible();
  await expect(page.getByText("left-only.txt", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /account_right/ }).click();
  await page.getByRole("menuitemradio", { name: /account_left/ }).click();
  await expect(page.getByText("left-only.txt", { exact: true })).toBeVisible();
  await expect(page.getByText("right-only.txt", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const search = page.getByRole("dialog", { name: "Search", exact: true });
  await search.getByRole("button", { name: "All linked logins" }).click();
  await search.getByPlaceholder("Search files and content...").fill("same");
  const rows = search.getByRole("option").filter({ hasText: "same.txt" });
  await expect(rows).toHaveCount(2);
  await expect(search.locator("img")).toHaveCount(0);
  await rows
    .filter({ hasText: "account_right" })
    .getByRole("button", { name: "Reveal in folder" })
    .click();
  await expect(page.getByText("right-only.txt", { exact: true })).toBeVisible();
  // A second tab changes the cookie default; this tab must keep its own login.
  const secondTab = await page.context().newPage();
  await secondTab.goto("/files");
  await secondTab.getByRole("button", { name: /account_right/ }).click();
  await secondTab.getByRole("menuitemradio", { name: /account_left/ }).click();
  await expect(secondTab.getByText("left-only.txt", { exact: true })).toBeVisible();
  await listing(page).getByText("same.txt", { exact: true }).click({ button: "right" });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download", exact: true }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("download missing");
  expect(await readFile(downloadPath, "utf8")).toBe("Right account file");
  await listing(page).getByText("same.txt", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "Rename", exact: true });
  await rename.getByLabel("New name").fill("renamed.txt");
  await rename.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(listing(page).getByText("renamed.txt", { exact: true })).toBeVisible();
  await listing(page).getByText("renamed.txt", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(listing(page).getByText("renamed.txt", { exact: true })).toHaveCount(0);
  const untouched = await secondTab.request.get(
    `/api/v1/fs/download?path=%2Fsame.txt&identity=${left.id}`,
  );
  expect(await untouched.text()).toBe("Left account file");
  await secondTab.close();
  await page.goto("/account");
  await page.getByRole("button", { name: "Unlink account_right", exact: true }).click();
  const unlink = page.getByRole("dialog", { name: "Unlink account_right?", exact: true });
  await expect(unlink.getByText(/Files remain on the server/)).toBeVisible();
  await unlink.getByRole("button", { name: "Unlink login", exact: true }).click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByText("left-only.txt", { exact: true })).toBeVisible();
  await page.goto("/account");
  await expect(page.getByRole("button", { name: "Unlink account_left" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Unlink account_right" })).toHaveCount(0);
});

test.describe("initial account shell", () => {
  test.use({ storageState: getAliceStorageStatePath() });
  test("fresh shell mounts shortcuts and navigation", async ({ page }) => {
    await page.goto("/files");
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Search", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "alice" }).click();
    await page.getByRole("menuitem", { name: "Account" }).click();
    await expect(page).toHaveURL(/\/account$/);
  });
});
