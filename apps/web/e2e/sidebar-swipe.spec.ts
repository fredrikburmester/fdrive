import { type CDPSession, expect, type Page, test } from "@playwright/test";

// A phone: touch input and a viewport narrow enough for the sidebar to be a sheet.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/** Drags one finger from `from` to `to` in a few steps, as real touch input. */
async function swipe(cdp: CDPSession, from: [number, number], to: [number, number]) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from[0], y: from[1] }],
  });
  for (let step = 1; step <= 6; step++) {
    const x = from[0] + ((to[0] - from[0]) * step) / 6;
    const y = from[1] + ((to[1] - from[1]) * step) / 6;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Whether the browser was refused the next touch that starts on the page. */
async function watchNextTouch(page: Page) {
  await page.evaluate(() => {
    window.addEventListener(
      "touchstart",
      (event) => {
        document.documentElement.dataset.touchTaken = String(event.defaultPrevented);
      },
      { once: true },
    );
  });
}

test("a swipe in from the left edge opens the sidebar, and one back to the left shuts it", async ({
  page,
}) => {
  await page.goto("/files");
  await page.getByRole("button", { name: "New" }).waitFor();
  const cdp = await page.context().newCDPSession(page);

  // The edge is taken from the browser, which keeps its back swipe from starting there.
  await watchNextTouch(page);
  await swipe(cdp, [4, 500], [220, 505]);
  await expect(page.locator("html")).toHaveAttribute("data-touch-taken", "true");
  const sheet = page.getByRole("dialog");
  await expect(sheet).toHaveCSS("opacity", "1");

  await swipe(cdp, [300, 500], [80, 505]);
  await expect(sheet).toBeHidden();

  // Away from the edge the touch stays the browser's.
  await watchNextTouch(page);
  await swipe(cdp, [120, 500], [120, 300]);
  await expect(page.locator("html")).toHaveAttribute("data-touch-taken", "false");
  await expect(sheet).toBeHidden();
});

test("a tap on the left edge still clicks what is there, once", async ({ page }) => {
  await page.goto("/files");
  await page.getByRole("button", { name: "New" }).waitFor();

  const toggle = page.getByRole("button", { name: "Toggle Sidebar" });
  const box = await toggle.boundingBox();
  if (box === null) throw new Error("The sidebar toggle has no box.");
  // Inside both the toggle and the edge the sidebar takes from the browser.
  const x = Math.round(box.x + 3);
  expect(x).toBeLessThanOrEqual(24);

  await watchNextTouch(page);
  await page.touchscreen.tap(x, Math.round(box.y + box.height / 2));
  await expect(page.locator("html")).toHaveAttribute("data-touch-taken", "true");
  const sheet = page.getByRole("dialog");
  await expect(sheet).toHaveCSS("opacity", "1");
  // One click, not two: a second would have shut the sheet again.
  await page.waitForTimeout(400);
  await expect(sheet).toBeVisible();
});
