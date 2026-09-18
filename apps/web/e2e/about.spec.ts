import { expect, test } from "@playwright/test";

test("/about credits no storage backend", async ({ page }) => {
  await page.goto("/about");

  await expect(page.getByText("Built on")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "SFTPGo" })).toHaveCount(0);
});

test("/about drops the connected-provider line once every provider is disabled", async ({
  page,
}) => {
  const response = await page.request.get("/api/v1/admin/providers");
  expect(response.ok()).toBe(true);
  const { providers } = (await response.json()) as {
    providers: { id: string; enabled: boolean }[];
  };
  const enabled = providers.filter((provider) => provider.enabled);
  expect(enabled.length).toBeGreaterThan(0);
  await page.goto("/about");
  await expect(page.getByText("Connected to")).toBeVisible();
  try {
    for (const provider of enabled) {
      const disabled = await page.request.patch(`/api/v1/admin/providers/${provider.id}`, {
        headers: { "x-requested-with": "fdrive" },
        data: { enabled: false },
      });
      expect(disabled.ok()).toBe(true);
    }
    await page.goto("/about");
    await expect(page.getByRole("region", { name: "About fdrive" })).toBeVisible();
    await expect(page.getByText("Connected to")).toHaveCount(0);
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

test("/about identifies the running API and links to the project and feature guides", async ({
  page,
}) => {
  const response = await page.request.get("/api/v1/about");
  expect(response.ok()).toBe(true);
  const about = await response.json();
  expect(about.uptimeSeconds).toBeGreaterThanOrEqual(0);
  await page.goto("/about");
  const info = page.getByRole("region", { name: "About fdrive" });
  const github = "https://github.com/fredrikburmester/fdrive";
  await expect(info.getByRole("link", { name: "GitHub", exact: true })).toHaveAttribute(
    "href",
    github,
  );
  await expect(info.getByRole("link", { name: "FDrive for macOS" })).toHaveAttribute(
    "href",
    `${github}/blob/main/docs/MACOS.md`,
  );
  await expect(info.getByRole("link", { name: "Buy Me a Coffee" })).toHaveAttribute(
    "href",
    "https://buymeacoffee.com/fredrikbur3",
  );
  await expect(info.getByRole("link", { name: "Search & AI" })).toHaveAttribute(
    "href",
    `${github}/blob/main/docs/SEARCH-AND-AI.md`,
  );
  await expect(info.getByRole("heading", { name: "Feature documentation" })).toBeVisible();
  await expect(info.locator("dt", { hasText: "API uptime" }).locator("+ dd")).toHaveText(
    /^(\d+d )?(\d+h )?\d+[ms]$/,
  );
  if (/^[a-f0-9]{40,64}$/i.test(about.version)) {
    await expect(info.getByRole("link", { name: about.version.slice(0, 12) })).toHaveAttribute(
      "href",
      `${github}/commit/${about.version}`,
    );
  } else {
    await expect(
      info.getByText(
        about.version === "development" ? "Development (version unavailable)" : about.version,
        { exact: true },
      ),
    ).toBeVisible();
  }
  const guides = info.locator('a[href*="/blob/main/"]');
  await expect(guides).toHaveCount(11);
  for (const link of await info.locator('a[target="_blank"]').all()) {
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
});

test("/about fits phones and desktop in both themes", async ({ page }) => {
  await page.goto("/about");
  const info = page.getByRole("region", { name: "About fdrive" });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.classList.remove("light", "dark");
      document.documentElement.classList.add(value);
    }, theme);
    for (const width of [320, 375, 639, 640, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(info).toBeVisible();
      const bounds = await info.evaluate((element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        links: [...element.querySelectorAll("a.border")].map((link) => {
          const rect = link.getBoundingClientRect();
          return { height: rect.height, left: rect.left, right: rect.right };
        }),
      }));
      expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width);
      for (const link of bounds.links) {
        expect(link.height).toBeGreaterThanOrEqual(44);
        expect(link.left).toBeGreaterThanOrEqual(0);
        expect(link.right).toBeLessThanOrEqual(width);
      }
      if (width === 320 || width === 1280) {
        await page.screenshot({
          path: test.info().outputPath(`about-${theme}-${width}.png`),
          fullPage: true,
        });
      }
    }
  }
});
