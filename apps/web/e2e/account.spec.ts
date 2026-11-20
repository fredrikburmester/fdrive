import { expect, type Locator, type Page, test } from "@playwright/test";

/** The list of Settings sections (the `AreaList` in `components/account/settings-shell.tsx`). */
function settingsNav(page: Page): Locator {
  return page.getByRole("navigation", { name: "Settings sections" });
}

/** The page's heading: the open section's sheet title, or "Settings" over the list on a phone. */
function title(page: Page, name: string): Locator {
  return page.getByRole("heading", { level: 1, name, exact: true });
}

/** The open section's sheet, named by its title. */
function sheet(page: Page, name: string): Locator {
  return page.getByRole("region", { name, exact: true });
}

test("each Settings section opens at its own URL, and reload and Back keep their place", async ({
  page,
}) => {
  await page.goto("/account");

  // /account itself lands on the first section's sheet, with the list beside it.
  await expect(title(page, "Appearance")).toBeVisible();
  await expect(settingsNav(page).getByRole("link", { name: "Appearance" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(sheet(page, "Appearance").getByRole("group", { name: "Theme" })).toBeVisible();
  await expect(sheet(page, "Appearance").getByRole("group", { name: "File list" })).toBeVisible();

  const sections = [
    ["Browsing", "browsing", page.getByRole("group", { name: "Row click" })],
    ["Formats", "formats", page.getByRole("group", { name: "Sizes" })],
    ["Password", "password", page.getByLabel("Current password")],
    ["Encryption", "encryption", page.getByText("Folders only your own devices can open.")],
    ["API tokens", "tokens", page.getByRole("button", { name: "Create token" })],
    ["Appearance", "appearance", page.getByRole("group", { name: "Theme" })],
  ] as const;
  for (const [name, path, content] of sections) {
    const link = settingsNav(page).getByRole("link", { name, exact: true });
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/account/${path}$`));
    await expect(title(page, name)).toBeVisible();
    await expect(link).toHaveAttribute("aria-current", "page");
    await expect(content).toBeVisible();
    // One section shows at a time: its sheet, whose title is the page's only heading.
    await expect(sheet(page, name)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  }

  // A section's URL opens that section directly, and survives a reload.
  await page.goto("/account/formats");
  await expect(title(page, "Formats")).toBeVisible();
  await page.reload();
  await expect(title(page, "Formats")).toBeVisible();
  await expect(page.getByRole("group", { name: "Dates" })).toBeVisible();

  // Back returns to the section before, not out of Settings.
  await settingsNav(page).getByRole("link", { name: "Password", exact: true }).click();
  await expect(title(page, "Password")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/account\/formats$/);
  await expect(title(page, "Formats")).toBeVisible();

  // On a wide screen the list stays beside the sheet, so the header only names the frame.
  await expect(page.locator('[data-slot="list-sheet-trail"]')).toContainText("Settings");
  await expect(page.getByRole("link", { name: "Back to Settings" })).toBeHidden();
  await expect(settingsNav(page)).toBeVisible();
});

test("the theme chosen in Settings applies at once and survives a reload", async ({ page }) => {
  await page.goto("/account/appearance");
  const theme = page.getByRole("group", { name: "Theme" });
  await expect(theme.getByRole("button", { name: "System" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await theme.getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect(theme.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Dark at any time of day.")).toBeVisible();

  await page.reload();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect(theme.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");

  await theme.getByRole("button", { name: "Light" }).click();
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  await expect(theme.getByRole("button", { name: "Light" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("on a phone the section list is a screen of its own, and a section has a way back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/account");

  // The list alone, under a plain "Settings" title: no section shows with it.
  await expect(title(page, "Settings")).toBeVisible();
  for (const name of [
    "Appearance",
    "Browsing",
    "Formats",
    "Password",
    "Encryption",
    "API tokens",
  ]) {
    await expect(settingsNav(page).getByRole("link", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("group", { name: "Theme" })).toBeHidden();
  await expect(page.getByRole("link", { name: "Back to Settings" })).toHaveCount(0);

  // A section opens as its own page, without the list, and fits the screen.
  await settingsNav(page).getByRole("link", { name: "Formats", exact: true }).click();
  await expect(page).toHaveURL(/\/account\/formats$/);
  await expect(title(page, "Formats")).toBeVisible();
  await expect(sheet(page, "Formats").getByRole("group", { name: "Sizes" })).toBeVisible();
  await expect(settingsNav(page)).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);

  await page.getByRole("link", { name: "Back to Settings" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(title(page, "Settings")).toBeVisible();
  await expect(settingsNav(page).getByRole("link", { name: "Formats", exact: true })).toBeVisible();

  // Appearance, the section a wide screen shows on /account, opens from the list here.
  await settingsNav(page).getByRole("link", { name: "Appearance", exact: true }).click();
  await expect(page).toHaveURL(/\/account\/appearance$/);
  await expect(page.getByRole("group", { name: "Theme" })).toBeVisible();
});

test("alice creates an API token, sees it once, the list shows it, and can revoke it", async ({
  page,
}, testInfo) => {
  await page.goto("/files");

  // Reach Settings through the sidebar footer menu, not by direct navigation,
  // so this also proves the "Settings" item is wired up.
  await page.getByRole("button", { name: "alice" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await settingsNav(page).getByRole("link", { name: "API tokens", exact: true }).click();
  await expect(page).toHaveURL(/\/account\/tokens$/);

  await expect(title(page, "API tokens")).toBeVisible();
  await expect(page.getByText("No tokens yet.")).toBeVisible();

  const tokenName = `Playwright ${Date.now()}`;

  await page.getByRole("button", { name: "Create token" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create API token" });
  await createDialog.getByLabel("Name").fill(tokenName);
  await expect(createDialog.getByRole("combobox", { name: "Login" })).toHaveCount(0);
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
  await expect(row.getByRole("cell", { name: "Full management", exact: true })).toBeVisible();
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
