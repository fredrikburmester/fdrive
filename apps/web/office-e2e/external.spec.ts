import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { loginAs } from "../e2e/support/login";
import { rewriteArchive } from "./archive";
import { createDocument, documentLoaded } from "./editor-ui";
import { fixtureState } from "./state";
import { putOverSftp, storedBytes, storedMetadata, storedXml } from "./storage";

test("same-size same-second SFTP edit invalidates editor content", async ({ page }) => {
  const state = await fixtureState();
  const filename = "External Å %20.docx";
  const path = `/${filename}`;
  await loginAs(page, "alice", "alice-password");
  const editor = await createDocument(page, "Document", filename);
  await editor.locator("#area_id").pressSequentially("CACHE_BEFORE");
  await editor.locator("#id-toolbar-btn-save").click();
  await expect
    .poll(async () => (await storedXml(state, path)).includes("CACHE_BEFORE"), { timeout: 90_000 })
    .toBe(true);
  const identity = new URL(page.url()).pathname.split("/")[2];
  await page.goto("/files");
  const modifiedSeconds = Math.floor(Date.now() / 1000) - 60;
  const normalized = await rewriteArchive(
    state.directory,
    await storedBytes(state, path),
    "CACHE_BEFORE",
    "CACHE_BEFORE",
    modifiedSeconds,
  );
  await putOverSftp(state, normalized, path);
  const first = await storedBytes(state, path);
  const firstMetadata = await storedMetadata(state, path);
  expect(Date.parse(firstMetadata.modified) / 1000).toBe(modifiedSeconds);
  expect(first).toEqual(new Uint8Array(await readFile(normalized)));
  await page.goto(`/office/${identity}/${encodeURIComponent(filename)}?mode=view`);
  await documentLoaded(page);
  await editor.locator("#area_id").waitFor({ state: "attached", timeout: 120_000 });
  await editor
    .getByRole("alertdialog")
    .filter({ hasText: "This file is opened in view mode." })
    .getByRole("button", { name: "OK", exact: true })
    .click();
  await editor.getByRole("button", { name: /^Find \(/ }).click();
  await editor.locator("#search-bar-text").fill("CACHE_BEFORE");
  await editor.locator("#search-bar-text").press("Enter");
  await expect(editor.locator("#search-bar-text").locator("..").locator("..")).toContainText("1/1");
  console.log("External edit: baseline rendered marker found");
  await page.goto("/files");
  const edited = await rewriteArchive(
    state.directory,
    first,
    "CACHE_BEFORE",
    "CACHE_AFTER!",
    modifiedSeconds,
  );
  await putOverSftp(state, edited, path);
  const second = await storedBytes(state, path);
  expect(await storedMetadata(state, path)).toEqual(firstMetadata);
  expect(second.byteLength).toBe(first.byteLength);
  expect(createHash("sha256").update(second).digest("hex")).not.toBe(
    createHash("sha256").update(first).digest("hex"),
  );
  await page.goto(`/office/${identity}/${encodeURIComponent(filename)}?mode=view`);
  await documentLoaded(page);
  await editor.locator("#area_id").waitFor({ state: "attached", timeout: 120_000 });
  await editor
    .getByRole("alertdialog")
    .filter({ hasText: "This file is opened in view mode." })
    .getByRole("button", { name: "OK", exact: true })
    .click();
  await editor.getByRole("button", { name: /^Find \(/ }).click();
  await editor.locator("#search-bar-text").fill("CACHE_AFTER!");
  await editor.locator("#search-bar-text").press("Enter");
  await expect(editor.locator("#search-bar-text").locator("..").locator("..")).toContainText("1/1");
  await editor.locator("#search-bar-text").fill("CACHE_BEFORE");
  await editor.locator("#search-bar-text").press("Enter");
  await expect(editor.locator("#search-bar-text").locator("..").locator("..")).toContainText("0/0");
});
