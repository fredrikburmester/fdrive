import { expect, test } from "@playwright/test";

test("/about shows 'Built on SFTPGo' with a link to its source", async ({ page }) => {
  await page.goto("/about");

  await expect(page.getByText("Built on")).toBeVisible();

  const sourceLink = page.getByRole("link", { name: "SFTPGo" });
  await expect(sourceLink).toBeVisible();
  await expect(sourceLink).toHaveAttribute("href", "https://github.com/drakkan/sftpgo");
});
