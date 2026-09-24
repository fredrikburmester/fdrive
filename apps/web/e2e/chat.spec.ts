import type { SystemAiResponse } from "@fdrive/contracts";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { dismissActivityPanel } from "./support/activity.js";
import { FAKE_AI_MODEL, startFakeAi } from "./support/fake-ai.js";
import { listing } from "./support/regions.js";
import { uniqueName } from "./support/unique.js";
import { uploadFiles } from "./support/upload.js";

const AI_URL = "/api/v1/system/ai";
const HEADERS = { "x-requested-with": "fdrive" };
const DECOMPOSED_FOLDER = "A\u030Arsbesked";

function panel(page: Page): Locator {
  return page.getByRole("complementary", { name: "Chat" });
}

async function createFolder(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Folder name").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
  await expect(listing(page).getByText(name, { exact: true })).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  const box = panel(page).getByRole("textbox", { name: "Message" });
  await box.fill(text);
  await box.press("Enter");
}

test("chat follows the person between folders, takes dropped files, reads them, moves and rewrites them through cards", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const fakeAi = await startFakeAi();
  const original = (await (await page.request.get(AI_URL)).json()) as SystemAiResponse;
  try {
    await page.goto("/system/ai");
    await dismissActivityPanel(page);
    await page.getByRole("button", { name: "Settings" }).click();
    const sheet = page.getByRole("dialog").filter({ hasText: "AI settings" });
    await sheet.getByRole("switch", { name: "Chat" }).click();
    await sheet.getByLabel("Provider").click();
    await page.getByRole("option", { name: "OpenAI-compatible server" }).click();
    await sheet.getByLabel("Base URL").fill(fakeAi.baseUrl);
    await sheet.getByLabel("Model").fill(FAKE_AI_MODEL);
    await sheet.getByRole("button", { name: "Save" }).click();
    await expect(sheet).toBeHidden();

    const sandbox = uniqueName("chat");
    await page.goto("/files");
    await createFolder(page, sandbox);
    await listing(page).getByText(sandbox, { exact: true }).dblclick();
    await expect(page).toHaveURL(new RegExp(`/files/${sandbox}$`));
    await uploadFiles(page, [
      { name: "invoice-2024.txt", mimeType: "text/plain", contents: "Invoice 2024-001" },
      { name: "shopping.txt", mimeType: "text/plain", contents: "milk, eggs" },
    ]);
    await expect(listing(page).getByText("shopping.txt", { exact: true })).toBeVisible();
    // Named the way macOS stores it: "A" plus a combining ring, where the assistant writes "Å".
    await createFolder(page, DECOMPOSED_FOLDER);

    // Add the selection to the chat: the panel opens with both files ready to attach.
    await listing(page).getByText("invoice-2024.txt", { exact: true }).click();
    await listing(page)
      .getByText("shopping.txt", { exact: true })
      .click({ modifiers: ["ControlOrMeta"] });
    await page.getByRole("button", { name: "Add to chat", exact: true }).click();
    await expect(panel(page)).toBeVisible();
    const attached = panel(page).getByRole("group", { name: "Attached to the next message" });
    await expect(attached.getByText("invoice-2024.txt")).toBeVisible();
    await expect(attached.getByText("shopping.txt")).toBeVisible();

    await send(page, "What are these files about?");
    await expect(panel(page).getByText("Read invoice-2024.txt")).toBeVisible();
    const cited = panel(page).getByRole("link", { name: `/${sandbox}/invoice-2024.txt` });
    await expect(cited).toBeVisible();
    await expect(panel(page).getByText("is a shopping list", { exact: false })).toBeVisible();
    const title = panel(page).getByRole("button", { name: "Chats" });
    await expect(title).toContainText("What are these files about?");

    // The panel stays with the person on other pages, and a reload brings the same chat back.
    await page.goto("/favorites");
    await expect(panel(page).getByText("is a shopping list", { exact: false })).toBeVisible();
    await page.reload();
    await expect(panel(page).getByText("is a shopping list", { exact: false })).toBeVisible();

    // Following a citation lands in the folder with the file selected (the browser then drops `select`).
    await panel(page)
      .getByRole("link", { name: `/${sandbox}/invoice-2024.txt` })
      .click();
    await expect(page).toHaveURL(new RegExp(`/files/${sandbox}(\\?select=invoice-2024\\.txt)?$`));
    await expect(
      listing(page).getByRole("checkbox", { name: "Select invoice-2024.txt" }),
    ).toBeChecked();

    // Paths written as code are links too, and find the stored spelling of accented names.
    await panel(page)
      .getByRole("link", { name: `/${sandbox}/Årsbesked` })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/files/${sandbox}/${encodeURIComponent(DECOMPOSED_FOLDER)}$`),
    );
    await panel(page)
      .getByRole("link", { name: `/${sandbox}/shopping.txt` })
      .click();
    await expect(page).toHaveURL(new RegExp(`/files/${sandbox}(\\?select=shopping\\.txt)?$`));
    await expect(
      listing(page).getByRole("checkbox", { name: "Select shopping.txt" }),
    ).toBeChecked();

    // Dropping a file from the listing attaches it.
    await listing(page).getByText("shopping.txt", { exact: true }).dragTo(panel(page));
    await expect(attached.getByText("shopping.txt")).toBeVisible();
    await send(page, "Is this a duplicate of another file?");
    await expect(panel(page).getByText("not indexed", { exact: false })).toBeVisible();

    // A move card: the assistant proposes, the person applies.
    await listing(page).getByText("invoice-2024.txt", { exact: true }).dragTo(panel(page));
    await send(page, "Move these into a Notes folder");
    const moveCard = panel(page).getByRole("region", { name: "Notes go into a Notes folder." });
    await expect(moveCard.getByText("New folder")).toBeVisible();
    await moveCard.getByRole("button", { name: /^Move \d+ items?$/ }).click();
    await expect(moveCard.getByText("Applied")).toBeVisible();
    await expect(panel(page).getByText("Moved them into Notes.")).toBeVisible();
    await expect(listing(page).getByText("Notes", { exact: true })).toBeVisible();
    await expect(listing(page).getByText("invoice-2024.txt", { exact: true })).toBeHidden();

    // A write card: a new file next to the original, which stayed in the sandbox.
    await listing(page).getByText("shopping.txt", { exact: true }).dragTo(panel(page));
    await send(page, "Rewrite shopping.txt in a more professional way");
    const writeCard = panel(page).getByRole("region", {
      name: "A more professional version, as a new file.",
    });
    await expect(writeCard.getByText("Grocery list", { exact: false })).toBeVisible();
    await writeCard.getByRole("button", { name: "Create file" }).click();
    await expect(writeCard.getByText("Applied")).toBeVisible();
    await expect(
      listing(page).getByText("shopping-professional.txt", { exact: true }),
    ).toBeVisible();

    // The assistant was offered chat's tools, not Organize's.
    const offered = fakeAi.requests[0]?.tools?.map((tool) => tool.function.name) ?? [];
    expect(offered).toContain("read_file");
    expect(offered).toContain("move_items");
    expect(offered).not.toContain("submit_suggestions");

    await panel(page).getByRole("button", { name: "Close chat" }).click();
    await expect(panel(page)).toBeHidden();
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
