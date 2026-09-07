import { expect, test } from "@playwright/test";
import { loginAs } from "../e2e/support/login";
import { createDocument, documentLoaded } from "./editor-ui";
import { fixtureState } from "./state";
import { storedBytes, storedText } from "./storage";

test("editor rename and Save Copy As reach real storage", async ({ page }) => {
  const state = await fixtureState();
  await loginAs(page, "alice", "alice-password");
  const opened = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/v1/office/open",
  );
  const editor = await createDocument(page, "Document", "Operations.docx");
  const original = (await (await opened).json()) as { fileId: string };
  await editor.locator("#area_id").pressSequentially("OPERATIONS_PERSISTED_MARKER");
  await editor.locator("#id-toolbar-btn-save").click();
  await expect
    .poll(
      async () =>
        (await storedText(state, "/Operations.docx")).includes("OPERATIONS_PERSISTED_MARKER"),
      { timeout: 90_000 },
    )
    .toBe(true);
  await editor.locator("#rib-doc-name").click();
  await expect
    .poll(() =>
      editor.locator("#rib-doc-name").evaluate((element) => {
        const input = element as HTMLInputElement;
        return input.selectionStart === 0 && input.selectionEnd === input.value.length;
      }),
    )
    .toBe(true);
  await editor.locator("#rib-doc-name").press("Home");
  await editor.locator("#rib-doc-name").press("Shift+End");
  await editor.locator("#rib-doc-name").pressSequentially("Renamed Å %20", { delay: 50 });
  await editor.locator("#rib-doc-name").press("Enter");
  await expect(page).toHaveURL(/Renamed%20%C3%85%20%2520\.docx\?mode=edit$/);
  expect(
    (await storedText(state, "/Renamed Å %20.docx")).includes("OPERATIONS_PERSISTED_MARKER"),
  ).toBe(true);
  await expect(editor.locator("#rib-doc-name")).toHaveValue(/Renamed/);
  await editor.getByText("File", { exact: true }).click();
  await editor
    .getByRole("menubar", { name: "File menu" })
    .getByText("Save Copy As", { exact: true })
    .click();
  await editor.locator("#panel-savecopy .svg-format-docx").click();
  await editor.getByRole("dialog").locator("input:not([readonly])").fill("Saved Copy Å %20");
  await editor.getByText("OK", { exact: true }).click();
  await editor.getByRole("alertdialog").getByRole("button", { name: "OK", exact: true }).click();
  await expect
    .poll(
      async () => {
        try {
          return (await storedText(state, "/Saved Copy Å %20.docx")).includes(
            "OPERATIONS_PERSISTED_MARKER",
          );
        } catch {
          return false;
        }
      },
      { timeout: 90_000 },
    )
    .toBe(true);
  expect(
    (await storedText(state, "/Renamed Å %20.docx")).includes("OPERATIONS_PERSISTED_MARKER"),
  ).toBe(true);
  await expect(storedBytes(state, "/Operations.docx")).rejects.toThrow(
    "Storage download failed: 404",
  );
  const renamedResponse = await page.request.post("/api/v1/office/open", {
    headers: { "x-requested-with": "fdrive" },
    data: { path: "/Renamed Å %20.docx", mode: "view" },
  });
  expect(renamedResponse.status()).toBe(200);
  expect(((await renamedResponse.json()) as { fileId: string }).fileId).toBe(original.fileId);
});

test("Recents and Favorites preview links open Office with the selected identity", async ({
  page,
}) => {
  const state = await fixtureState();
  await loginAs(page, "alice", "alice-password");
  const editor = await createDocument(page, "Document", "Preview Å %20.docx");
  await editor.locator("#area_id").pressSequentially("PREVIEW_PERSISTED_MARKER");
  await editor.locator("#id-toolbar-btn-save").click();
  await expect
    .poll(
      async () =>
        (await storedText(state, "/Preview Å %20.docx")).includes("PREVIEW_PERSISTED_MARKER"),
      { timeout: 90_000 },
    )
    .toBe(true);
  await page.goto("/files");
  await page.getByRole("link", { name: "Preview Å %20.docx", exact: true }).click();
  await expect(page).toHaveURL(/\/view\//);
  await page.getByRole("button", { name: "Info", exact: true }).click();
  const favoriteResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/favorites" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add to Favorites", exact: true }).click();
  expect((await favoriteResponse).status()).toBe(200);
  await page.reload();
  await page.getByRole("button", { name: "Info", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Remove from Favorites", exact: true }),
  ).toBeVisible();
  for (const section of ["Recents", "Favorites"]) {
    await page.goto("/files");
    const group = page
      .locator('[data-sidebar="group"]')
      .filter({ has: page.getByText(section, { exact: true }) });
    await group.getByRole("link", { name: "Preview Å %20.docx", exact: true }).click();
    await expect(page).toHaveURL(/\/view\//);
    await page.getByRole("button", { name: "View in office", exact: true }).click();
    await expect(page).toHaveURL(/\/office\/[^/]+\/Preview%20%C3%85%20%2520\.docx\?mode=view/);
    await documentLoaded(page);
    await editor
      .getByRole("alertdialog")
      .filter({ hasText: "This file is opened in view mode." })
      .getByRole("button", { name: "OK", exact: true })
      .click();
    await editor.getByRole("button", { name: /^Find \(/ }).click();
    await editor.locator("#search-bar-text").fill("PREVIEW_PERSISTED_MARKER");
    await editor.locator("#search-bar-text").press("Enter");
    await expect(editor.locator("#search-bar-text").locator("..").locator("..")).toContainText(
      "1/1",
    );
  }
});
