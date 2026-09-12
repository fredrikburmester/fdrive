import { expect, test } from "@playwright/test";

test("alice creates an API token, sees it once, the list shows it, and can revoke it", async ({
  page,
}, testInfo) => {
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
  await expect(createDialog.getByRole("combobox", { name: "Login" })).toContainText("alice");
  await expect(createDialog.getByRole("combobox", { name: "Access" })).toContainText("Read");
  await createDialog.getByRole("combobox", { name: "Access" }).click();
  await page.getByRole("option", { name: "Full management", exact: true }).click();
  await createDialog.getByLabel("Allowed folders").fill("/docs");
  await page.screenshot({ path: testInfo.outputPath("token-permissions.png"), fullPage: true });
  await createDialog.getByRole("button", { name: "Create token" }).click();

  // The "shown once" dialog: the raw secret is visible now.
  const createdDialog = page.getByRole("dialog", { name: "Token created" });
  await expect(createdDialog).toBeVisible();
  await expect(createdDialog.getByText(/only time you will see this token/i)).toBeVisible();
  const tokenValue = await createdDialog.locator("input[readonly]").first().inputValue();
  expect(tokenValue).toMatch(/^fdr_/);
  // Use the actual token over HTTP, independently of the browser session.
  let requestId = 0;
  const mcp = async (method: string, params: object) => {
    const response = await page.request.post("/mcp", {
      headers: {
        authorization: `Bearer ${tokenValue}`,
        accept: "application/json, text/event-stream",
      },
      data: { jsonrpc: "2.0", id: ++requestId, method, params },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()).result;
  };
  const discovery = await mcp("tools/list", {});
  expect(discovery.tools.map((tool: { name: string }) => tool.name)).toContain("create_file");
  const filePath = `/docs/mcp-browser-${Date.now()}.txt`;
  const createdFile = await mcp("tools/call", {
    name: "create_file",
    arguments: { path: filePath, text: "browser to MCP" },
  });
  expect(createdFile.isError).not.toBe(true);
  const read = await mcp("tools/call", { name: "read_file_text", arguments: { path: filePath } });
  expect(JSON.parse(read.content[0].text).text).toBe("browser to MCP");
  const tags = await mcp("tools/call", {
    name: "set_file_tags",
    arguments: { path: filePath, names: [tokenName] },
  });
  expect(tags.isError).not.toBe(true);
  const denied = await mcp("tools/call", {
    name: "create_file",
    arguments: { path: "/escape.txt", text: "forbidden" },
  });
  expect(denied.isError).toBe(true);

  await createdDialog.getByRole("button", { name: "Done" }).click();
  await expect(createdDialog).toBeHidden();

  // The list shows it (without the secret).
  const row = page.getByRole("row", { name: new RegExp(tokenName) });
  await expect(row).toBeVisible();
  await expect(row.getByText("Full management")).toBeVisible();
  await expect(row.getByText("/docs", { exact: true })).toBeVisible();
  await expect(row.getByText(tokenValue)).toHaveCount(0);

  // Revoke it.
  await row.getByRole("button", { name: "Revoke" }).click();
  const revokeDialog = page.getByRole("alertdialog");
  await expect(revokeDialog).toBeVisible();
  await revokeDialog.getByRole("button", { name: "Revoke" }).click();

  await expect(page.getByRole("row", { name: new RegExp(tokenName) })).toHaveCount(0);
  const revoked = await page.request.post("/mcp", {
    headers: {
      authorization: `Bearer ${tokenValue}`,
      accept: "application/json, text/event-stream",
    },
    data: { jsonrpc: "2.0", id: 99, method: "tools/list", params: {} },
  });
  expect(revoked.status()).toBe(401);
});
