import { expect, test } from "@playwright/test";
import { loginAs } from "../e2e/support/login";
import { createDocument } from "./editor-ui";
import { fixtureState } from "./state";
import { storedText } from "./storage";

test("Collabora edits, saves and reopens a real document", async ({ page }) => {
  const state = await fixtureState();
  await loginAs(page, "alice", "alice-password");
  await createDocument(page, "Document", "Collabora.odt", "odf");
  const editor = page.frameLocator('iframe[title="Office document"]');
  const input = editor.locator("#clipboard-area");
  await input.waitFor({ state: "attached", timeout: 120_000 });
  await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  const welcome = editor.frameLocator('iframe[title="Welcome Dialog"]');
  await welcome.getByRole("link", { name: "3", exact: true }).click();
  await welcome.getByRole("button", { name: "Close", exact: true }).click();
  await expect(editor.locator('iframe[title="Welcome Dialog"]')).toHaveCount(0);
  await editor.getByRole("textbox", { name: "Document name", exact: true }).click();
  await editor.getByRole("img", { name: "Online Editor", exact: true }).click();
  await input.pressSequentially("COLLABORA_PERSISTED_MARKER", { delay: 50 });
  await expect(editor.getByText("1 word, 26 characters", { exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  console.log("Collabora: real document reports typed word count; Save clicked");
  await expect
    .poll(
      async () =>
        (await storedText(state, "/Collabora.odt")).includes("COLLABORA_PERSISTED_MARKER"),
      { timeout: 90_000 },
    )
    .toBe(true);
  await page.reload();
  await expect(page.getByTitle("Office document")).toBeVisible();
  await expect(page.getByText("Opening office…", { exact: true })).toBeHidden({ timeout: 120_000 });
  await expect(editor.getByText("1 word, 26 characters", { exact: true })).toBeVisible();
});

for (const filename of ["Collabora space.odt", "Collabora Å.odt", "Collabora %20.odt"]) {
  test(`Collabora filename ${filename}`, async ({ page }) => {
    await loginAs(page, "alice", "alice-password");
    await createDocument(page, "Document", filename, "odf");
    const editor = page.frameLocator('iframe[title="Office document"]');
    await expect
      .poll(
        async () => {
          if (await editor.locator("#technical-details-text").count())
            throw new Error("Collabora reported document type detection failure");
          return await editor.getByRole("button", { name: "Page 1 of 1", exact: true }).count();
        },
        { timeout: 30_000 },
      )
      .toBe(1);
  });
}
