import { expect, test } from "@playwright/test";

test("/about shows 'Built on SFTPGo' with a link to its source", async ({ page }) => {
  await page.goto("/about");

  await expect(page.getByText("Built on")).toBeVisible();

  const sourceLink = page.getByRole("link", { name: "SFTPGo" });
  await expect(sourceLink).toBeVisible();
  await expect(sourceLink).toHaveAttribute("href", "https://github.com/drakkan/sftpgo");
});

test("/about keeps attribution after the configured providers are disabled", async ({ page }) => {
  const response = await page.request.get("/api/v1/admin/providers");
  expect(response.ok()).toBe(true);
  const { providers } = (await response.json()) as {
    providers: { id: string; enabled: boolean }[];
  };
  const enabled = providers.filter((provider) => provider.enabled);
  expect(enabled.length).toBeGreaterThan(0);
  try {
    for (const provider of enabled) {
      const disabled = await page.request.patch(`/api/v1/admin/providers/${provider.id}`, {
        headers: { "x-requested-with": "fdrive" },
        data: { enabled: false },
      });
      expect(disabled.ok()).toBe(true);
    }
    await page.goto("/about");
    await expect(page.getByText("Built on")).toBeVisible();
    await expect(page.getByRole("link", { name: "SFTPGo" })).toHaveAttribute(
      "href",
      "https://github.com/drakkan/sftpgo",
    );
  } finally {
    for (const provider of enabled) {
      const restored = await page.request.patch(`/api/v1/admin/providers/${provider.id}`, {
        headers: { "x-requested-with": "fdrive" },
        data: { enabled: true },
      });
      expect(restored.ok()).toBe(true);
    }
  }
});
