import { expect, test } from "@playwright/test";
import { loginAs } from "../e2e/support/login";
import { createDocument, documentLoaded, observeOfficeReady } from "./editor-ui";
import { fixtureState } from "./state";
import { storedText } from "./storage";

test("readonly identity cannot inject edits through a concurrent writer", async ({
  page,
  browser,
}) => {
  const state = await fixtureState();
  await loginAs(page, "alice", "alice-password");
  const editor = await createDocument(page, "Document", "Office Å %20.docx");
  const input = editor.locator("#area_id");
  await input.waitFor({ state: "attached", timeout: 120_000 });
  await input.pressSequentially("Alice writes the document.");
  await editor.locator("#id-toolbar-btn-save").click();
  await expect
    .poll(
      async () =>
        (await storedText(state, "/Office Å %20.docx")).includes("Alice writes the document."),
      { timeout: 90_000 },
    )
    .toBe(true);
  console.log("ONLYOFFICE saved DOCX bytes verified");
  const readerContext = await browser.newContext({ baseURL: state.webUrl });
  try {
    const reader = await readerContext.newPage();
    await observeOfficeReady(reader, state.officeUrl);
    await loginAs(reader, "reader", "reader-password");
    const me = (await (await reader.request.get("/api/v1/auth/me")).json()) as {
      activeIdentityId: string;
    };
    const descriptorResponse = reader.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/v1/office/open",
    );
    await reader.goto(
      `/office/${me.activeIdentityId}/${encodeURIComponent("Office Å %20.docx")}?mode=edit`,
    );
    expect((await descriptorResponse).status()).toBe(403);
    await expect(reader.getByTitle("Office document")).toHaveCount(0);
    const viewResponse = reader.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/v1/office/open",
    );
    await reader.goto(
      `/office/${me.activeIdentityId}/${encodeURIComponent("Office Å %20.docx")}?mode=view`,
    );
    expect((await viewResponse).status()).toBe(200);
    await documentLoaded(reader);
    const readerEditor = reader
      .frameLocator('iframe[title="Office document"]')
      .frameLocator('iframe[name="frameEditor"]');
    const readerInput = readerEditor.locator("#area_id");
    await readerInput.waitFor({ state: "attached", timeout: 120_000 });
    await expect(readerEditor.locator("#id-toolbar-btn-save")).toBeHidden();
    await readerInput.press("Control+End");
    await readerInput.pressSequentially("READER_MUST_NOT_PERSIST");
    await page.bringToFront();
    await input.press("Control+End");
    await input.pressSequentially("ALICE_AFTER_READER");
    await editor.locator("#id-toolbar-btn-save").click();
    await expect
      .poll(
        async () => (await storedText(state, "/Office Å %20.docx")).includes("ALICE_AFTER_READER"),
        { timeout: 90_000 },
      )
      .toBe(true);
    const saved = await storedText(state, "/Office Å %20.docx");
    console.log("Reader mutation persisted", saved.includes("READER_MUST_NOT_PERSIST"));
    expect(saved.includes("READER_MUST_NOT_PERSIST")).toBe(false);
  } finally {
    await readerContext.close();
  }
});
