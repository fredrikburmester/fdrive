import type { ListResponse, SystemAiResponse } from "@fdrive/contracts";
import { expect, type Page, test } from "@playwright/test";
import { dismissActivityPanel } from "./support/activity.js";
import { FAKE_AI_MODEL, startFakeAi } from "./support/fake-ai.js";
import { listing } from "./support/regions.js";
import { uniqueName } from "./support/unique.js";
import { uploadFiles } from "./support/upload.js";

const AI_URL = "/api/v1/system/ai";
const HEADERS = { "x-requested-with": "fdrive" };

async function createFolder(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Folder name").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
  await expect(listing(page).getByText(name, { exact: true })).toBeVisible();
}

async function openFolder(page: Page, name: string, url: RegExp): Promise<void> {
  await listing(page).getByText(name, { exact: true }).dblclick();
  await expect(page).toHaveURL(url);
}

test("Organize suggests other folders, keeps both on a clash, moves what is kept checked, and undoes it", async ({
  page,
}) => {
  // Two sandboxes' worth of folders and uploads before the assistant is even asked.
  test.setTimeout(60_000);
  const fakeAi = await startFakeAi();
  const original = (await (await page.request.get(AI_URL)).json()) as SystemAiResponse;
  try {
    await page.goto("/system/ai");
    await dismissActivityPanel(page);
    await page.getByRole("button", { name: "Settings" }).click();
    const sheet = page.getByRole("dialog").filter({ hasText: "AI settings" });
    await sheet.getByRole("switch", { name: "Turn on AI" }).click();
    await sheet.getByLabel("Provider").click();
    await page.getByRole("option", { name: "OpenAI-compatible server" }).click();
    await sheet.getByLabel("Base URL").fill(fakeAi.baseUrl);
    await sheet.getByLabel("Model").fill(FAKE_AI_MODEL);
    await sheet.getByRole("button", { name: "Save" }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByText("Organize is available to everyone signed in.")).toBeVisible();
    await page.getByRole("button", { name: "Check connection" }).click();
    await expect(page.getByText(`${FAKE_AI_MODEL} is available.`)).toBeVisible();

    const sandbox = uniqueName("organize");
    await page.goto("/files");
    await createFolder(page, sandbox);
    await openFolder(page, sandbox, new RegExp(`/files/${sandbox}$`));
    await createFolder(page, "Finance");
    await createFolder(page, "inbox");
    // An older invoice already in Finance clashes with the one the assistant will file there.
    await openFolder(page, "Finance", new RegExp(`/files/${sandbox}/Finance$`));
    await uploadFiles(page, [
      { name: "invoice-2024.txt", mimeType: "text/plain", contents: "Invoice 2023-009" },
    ]);
    await expect(listing(page).getByText("invoice-2024.txt", { exact: true })).toBeVisible();
    await page.goto(`/files/${sandbox}`);
    await openFolder(page, "inbox", new RegExp(`/files/${sandbox}/inbox$`));
    await uploadFiles(page, [
      { name: "invoice-2024.txt", mimeType: "text/plain", contents: "Invoice 2024-001" },
      { name: "shopping.txt", mimeType: "text/plain", contents: "milk, eggs" },
    ]);
    await expect(listing(page).getByText("shopping.txt", { exact: true })).toBeVisible();

    await listing(page).getByText("invoice-2024.txt", { exact: true }).click();
    await listing(page)
      .getByText("shopping.txt", { exact: true })
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(page.getByText("2 selected")).toBeVisible();
    await page.getByRole("button", { name: "Organize", exact: true }).click();

    const organize = page.getByRole("dialog").filter({ hasText: "Organize 2 items" });
    await expect(organize.getByText(/sent to\s+your AI server/)).toBeVisible();
    // What the assistant may see is the person's choice; file contents stay home for this run.
    const share = organize.getByRole("combobox", { name: "Share with assistant" });
    await expect(share).toContainText("File contents, names of other files");
    await share.click();
    await page.getByRole("option", { name: /File contents/ }).click();
    await page.keyboard.press("Escape");
    await expect(share).toContainText("Names of other files");
    await organize.getByRole("button", { name: "Suggest moves" }).click();
    await expect(
      organize.getByText("Invoices go to Finance and notes to a new Notes folder."),
    ).toBeVisible();
    const financeGroup = organize.getByRole("region", { name: `/${sandbox}/Finance` });
    await expect(financeGroup.getByText("invoice-2024.txt")).toBeVisible();
    await expect(
      financeGroup.getByText("Something with this name is already there."),
    ).toBeVisible();
    const notes = organize.getByRole("region", { name: `/${sandbox}/Notes` });
    await expect(notes.getByText("New folder")).toBeVisible();
    await expect(organize.getByRole("button", { name: "Move 1 item" })).toBeVisible();
    // The assistant looked at the drive before answering.
    expect(fakeAi.requests.length).toBe(2);
    expect(fakeAi.requests[1]?.messages.some((message) => message.role === "tool")).toBe(true);
    const offered = fakeAi.requests[0]?.tools?.map((tool) => tool.function.name) ?? [];
    expect(offered).toContain("folder_tree");
    expect(offered).not.toContain("read_excerpts");

    // Keeping both files the invoice under a numbered name.
    await financeGroup.getByRole("button", { name: "Keep both" }).click();
    await expect(financeGroup.getByText("invoice-2024 (2).txt")).toBeVisible();
    await expect(organize.getByRole("button", { name: "Move 2 items" })).toBeVisible();

    // Closing the sheet keeps the review; the toolbar leads back to it.
    await organize.getByRole("button", { name: "Close" }).last().click();
    await expect(organize).toBeHidden();
    await page.getByRole("button", { name: "Suggestions ready" }).click();
    await expect(organize.getByRole("button", { name: "Move 2 items" })).toBeVisible();

    await organize.getByRole("button", { name: "Move 2 items" }).click();
    await expect(organize).toBeHidden();
    await expect(page.getByText("Moved 2 items")).toBeVisible();
    await expect(listing(page).getByText("invoice-2024.txt", { exact: true })).toBeHidden();
    await expect(listing(page).getByText("shopping.txt", { exact: true })).toBeHidden();
    // Read Finance over the API: a page load would dismiss the toast that offers Undo.
    const finance = (await (
      await page.request.get(`/api/v1/fs/list?path=${encodeURIComponent(`/${sandbox}/Finance`)}`)
    ).json()) as ListResponse;
    expect(finance.entries.map((entry) => entry.name).sort()).toEqual([
      "invoice-2024 (2).txt",
      "invoice-2024.txt",
    ]);

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByText("Moved 2 items back")).toBeVisible();
    await expect(listing(page).getByText("invoice-2024.txt", { exact: true })).toBeVisible();
    await expect(listing(page).getByText("shopping.txt", { exact: true })).toBeVisible();

    await page.goto(`/files/${sandbox}/Notes`);
    await expect(listing(page).getByText("shopping.txt", { exact: true })).toBeHidden();
  } finally {
    const current = (await (await page.request.get(AI_URL)).json()) as SystemAiResponse;
    const { hasApiKey: _hasApiKey, ...restore } = original.configuration;
    await page.request.put(AI_URL, {
      headers: HEADERS,
      data: { ...restore, revision: current.configuration.revision },
    });
    await fakeAi.stop();
  }
});
