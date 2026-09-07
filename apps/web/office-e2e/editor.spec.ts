import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { loginAs } from "../e2e/support/login";
import { editorDiagnostics } from "./diagnostics";
import { createDocument, documentLoaded, observeOfficeReady } from "./editor-ui";
import { fixtureState } from "./state";
import { storedText } from "./storage";

async function typeMarker(
  page: Page,
  editor: FrameLocator,
  kind: string,
  marker: string,
  slot: number,
) {
  await documentLoaded(page);
  await expect(editor.locator("#rib-doc-name")).toBeEnabled({ timeout: 120_000 });
  if (kind === "Spreadsheet") {
    await expect(editor.getByRole("button", { name: "Add sheet", exact: true })).toBeEnabled();
    const grid = editor.locator("#area_id");
    await grid.press("Control+Home");
    for (let row = 1; row < slot; row++) await grid.press("ArrowDown");
    await editor.locator("#ce-cell-content").click();
    await editor.locator("#ce-cell-content").pressSequentially(marker);
    await editor.locator("#ce-cell-content").press("Enter");
    return;
  }
  if (kind === "Presentation" && slot === 1)
    await expect(editor.getByRole("button", { name: "Add Slide", exact: true })).toBeEnabled();
  const input = editor.locator("#area_id");
  await input.waitFor({ state: "attached", timeout: 120_000 });
  if (kind === "Presentation") {
    if (slot === 3) await input.press("Escape");
    await input.press("Tab");
    await input.press("Enter");
  }
  if (slot > 1 && !(kind === "Presentation" && slot === 3)) await input.press("End");
  await input.pressSequentially(marker);
}

for (const [kind, filename] of [
  ["Document", "Writers Å %20.docx"],
  ["Spreadsheet", "Writers.xlsx"],
  ["Presentation", "Writers.pptx"],
] as const) {
  test(`writers coedit and save ${kind}`, async ({ page, browser }) => {
    const state = await fixtureState();
    await loginAs(page, "alice", "alice-password");
    const bobContext = await browser.newContext({ baseURL: state.webUrl });
    try {
      const bob = await bobContext.newPage();
      await observeOfficeReady(bob, state.officeUrl);
      await loginAs(bob, "bob", "bob-password");
      const bobMe = (await (await bob.request.get("/api/v1/auth/me")).json()) as {
        activeIdentityId: string;
      };
      const aliceOpened = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/v1/office/open",
      );
      const editor = await createDocument(page, kind, filename);
      const aliceDescriptor = (await (await aliceOpened).json()) as { fileId: string };
      await typeMarker(page, editor, kind, "ALICE_WRITER_MARKER", 1);
      await expect
        .poll(
          async () => {
            if (await editor.locator("#id-toolbar-btn-save").isEnabled())
              await editor.locator("#id-toolbar-btn-save").click();
            return (await storedText(state, `/${filename}`)).includes("ALICE_WRITER_MARKER");
          },
          { timeout: 90_000, intervals: [1000, 3000, 5000] },
        )
        .toBe(true);
      console.log(`${kind}: Alice saved`);
      await bob.bringToFront();
      const bobOpened = bob.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/v1/office/open",
      );
      await bob.goto(`/office/${bobMe.activeIdentityId}/${encodeURIComponent(filename)}?mode=edit`);
      const bobDescriptor = (await (await bobOpened).json()) as { fileId: string };
      expect(bobDescriptor.fileId).toBe(aliceDescriptor.fileId);
      const bobEditor = bob
        .frameLocator('iframe[title="Office document"]')
        .frameLocator('iframe[name="frameEditor"]');
      await typeMarker(bob, bobEditor, kind, "BOB_WRITER_MARKER", 2);
      await expect
        .poll(
          async () => {
            if (await bobEditor.locator("#id-toolbar-btn-save").isEnabled())
              await bobEditor.locator("#id-toolbar-btn-save").click();
            const saved = await storedText(state, `/${filename}`);
            return saved.includes("BOB_WRITER_MARKER") && saved.includes("ALICE_WRITER_MARKER");
          },
          { timeout: 90_000, intervals: [1000, 3000, 5000] },
        )
        .toBe(true);
      console.log(`${kind}: Bob saved while Alice remained in the session`);
      await page.bringToFront();
      await typeMarker(page, editor, kind, "ALICE_AFTER_BOB", 3);
      await expect
        .poll(
          async () => {
            if (await editor.locator("#id-toolbar-btn-save").isEnabled())
              await editor.locator("#id-toolbar-btn-save").click();
            const xml = await storedText(state, `/${filename}`);
            return ["ALICE_WRITER_MARKER", "ALICE_AFTER_BOB", "BOB_WRITER_MARKER"].every((marker) =>
              xml.includes(marker),
            );
          },
          { timeout: 90_000, intervals: [1000, 3000, 5000] },
        )
        .toBe(true);
      console.log(`${kind}: both writers saved to same UUID`);
      await bob.goto("/files");
      await page.reload();
      await documentLoaded(page);
      await expect(editor.locator("#id-toolbar-btn-save")).toBeVisible({ timeout: 120_000 });
      await expect(editor.locator("#rib-doc-name")).toBeEnabled();
      await expect(
        editor.getByText("The file cannot be accessed right now.", { exact: false }),
      ).toBeHidden();
      expect((await storedText(state, `/${filename}`)).includes("BOB_WRITER_MARKER")).toBe(true);
    } catch (error) {
      const saved = await storedText(state, `/${filename}`);
      console.log("Writer persisted markers", {
        alice: saved.includes("ALICE_WRITER_MARKER"),
        bob: saved.includes("BOB_WRITER_MARKER"),
        aliceAfterBob: saved.includes("ALICE_AFTER_BOB"),
      });
      for (const [name, candidate] of [
        ["Alice", page],
        ["Bob", bobContext.pages()[0]],
      ] as const) {
        if (candidate === undefined) continue;
        const frame = candidate
          .frameLocator('iframe[title="Office document"]')
          .frameLocator('iframe[name="frameEditor"]');
        console.log("Writer editor state", name, {
          inaccessible: await frame
            .getByText("The file cannot be accessed right now.", { exact: false })
            .isVisible(),
          saveEnabled: await frame.locator("#id-toolbar-btn-save").isEnabled(),
        });
      }
      console.log("Editor failure summary", await editorDiagnostics(state));
      if (process.env.OFFICE_E2E_DIAGNOSTICS === "1") {
        console.log("Retaining failed fixture for bounded diagnostic inspection (60 seconds)");
        await page.waitForTimeout(60_000);
      }
      throw error;
    } finally {
      await bobContext.close();
    }
  });
}

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture parameter.
test.afterEach(async ({}, info) => {
  if (info.status !== "passed")
    console.log("Editor failure summary", await editorDiagnostics(await fixtureState()));
});
