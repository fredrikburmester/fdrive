import type { Page } from "@playwright/test";

/**
 * Closes the account-wide Activity panel if it is open. Earlier specs in a
 * full run can leave finished jobs in it, and since it is fixed bottom-right
 * on every page it can cover a settings card's own bottom-right Save button,
 * so a real click would land on the panel instead of the button.
 */
export async function dismissActivityPanel(page: Page): Promise<void> {
  const clear = page.getByRole("button", { name: "Clear" });
  if (await clear.isVisible()) {
    await clear.click();
    return;
  }
  const collapse = page.getByRole("button", { name: "Collapse activity panel" });
  if (await collapse.isVisible()) {
    await collapse.click();
  }
}
