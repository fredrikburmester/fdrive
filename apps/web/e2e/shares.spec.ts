import { readFile } from "node:fs/promises";
import { ManagedShare } from "@fdrive/contracts";
import { expect, type Page, test } from "@playwright/test";
import { loginAs } from "./support/login.js";
import { listing, sidebar } from "./support/regions.js";
import {
  shareAudioFixture,
  shareHeicFixture,
  shareImageFixture,
  shareZipFixture,
} from "./support/share-fixture.js";

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.use({ storageState: { cookies: [], origins: [] }, actionTimeout: 10_000 });
test.setTimeout(90_000);

async function createLink(
  page: Page,
  names: string[],
  label: string,
  password = "",
  write = false,
): Promise<string> {
  await page.goto("/files");
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    if (!name) throw new Error("Missing selected name");
    await listing(page)
      .getByText(name, { exact: true })
      .click(index === 0 ? {} : { modifiers: ["ControlOrMeta"] });
  }
  const first = names[0];
  if (!first) throw new Error("No shared files");
  await listing(page).getByText(first, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create share link", exact: true });
  await dialog.getByLabel("Link name", { exact: true }).fill(label);
  if (write) {
    await dialog.getByRole("combobox", { name: "Access" }).click();
    await page.getByRole("option", { name: "Can upload" }).click();
  }
  await dialog.getByLabel("Password", { exact: true }).fill(password);
  await dialog.getByRole("button", { name: "Create link", exact: true }).click();
  const ready = page.getByRole("dialog", { name: "Share link ready" });
  await expect(ready).toBeVisible();
  const url = await ready.getByLabel("Share link", { exact: true }).inputValue();
  await ready.getByRole("button", { name: "Done" }).click();
  return url;
}
async function applyPassword(page: Page, password: string) {
  await page.getByLabel("Share password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Use password", exact: true }).click();
  await expect(page.getByRole("button", { name: "Use password", exact: true })).toBeVisible();
  await expect(page.getByLabel("Share password", { exact: true })).toHaveValue("");
}
async function downloaded(page: Page, click: () => Promise<void>): Promise<Buffer> {
  const pending = page.waitForEvent("download", { timeout: 15_000 });
  await click();
  const download = await pending;
  const path = await download.path();
  if (!path) throw new Error("Download missing");
  return readFile(path);
}
function publicRequests(page: Page): string[] {
  const forbidden: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/v1/") && !url.pathname.startsWith("/api/v1/public/shares/"))
      forbidden.push(url.pathname);
    if (url.pathname.startsWith("/api/v1/public/shares/") && request.headers()["x-identity-id"])
      forbidden.push("identity header");
  });
  return forbidden;
}

test("single-file password is checked on explicit download; edit preserves, changes, removes, revokes", async ({
  page,
  browser,
}) => {
  await loginAs(page, "share_owner", "share-owner-test-password");
  await listing(page).getByText("hello.txt", { exact: true }).click();
  await page.keyboard.press("Space");
  await expect(page).toHaveURL(/\/view\/hello\.txt$/);
  await expect(page.getByText("Public hello 日本 100%", { exact: true })).toBeVisible();
  const url = await createLink(page, ["hello.txt"], "Protected file", "correct-share-password");
  await sidebar(page).getByRole("link", { name: "Shares", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "Protected file" })).toContainText(
    "Password protected",
  );
  const context = await browser.newContext();
  const visitor = await context.newPage();
  const forbidden = publicRequests(visitor);
  try {
    await visitor.goto(url);
    await expect(visitor.getByText("hello.txt", { exact: true })).toHaveCount(0);
    let downloads = 0;
    visitor.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/download")) downloads++;
    });
    await applyPassword(visitor, "wrong-password");
    expect(downloads).toBe(0);
    // A wrong password is reported by the server-side check and unlocks nothing:
    // no file name, no download control, no download request.
    await expect(visitor.getByText("Share password incorrect.", { exact: true })).toBeVisible();
    await expect(visitor.getByRole("link", { name: "Download", exact: true })).toHaveCount(0);
    await expect(visitor.getByText("hello.txt", { exact: true })).toHaveCount(0);
    expect(downloads).toBe(0);
    await applyPassword(visitor, "correct-share-password");
    expect(
      (
        await downloaded(visitor, () =>
          visitor.getByRole("link", { name: "Download", exact: true }).click(),
        )
      ).toString(),
    ).toBe("Public hello 日本 100%");
    await page.getByRole("button", { name: "Edit Protected file", exact: true }).click();
    let edit = page.getByRole("dialog", { name: "Edit share link" });
    await edit.getByLabel("Link name", { exact: true }).fill("Preserved password");
    await edit.getByRole("button", { name: "Save changes" }).click();
    await expect(edit).toBeHidden();
    await visitor.reload();
    expect(
      (
        await downloaded(visitor, () =>
          visitor.getByRole("link", { name: "Download", exact: true }).click(),
        )
      ).toString(),
    ).toContain("Public hello");
    await page.getByRole("button", { name: "Edit Preserved password", exact: true }).click();
    edit = page.getByRole("dialog", { name: "Edit share link" });
    await edit.getByRole("combobox", { name: "Password protection" }).click();
    await page.getByRole("option", { name: "Change password", exact: true }).click();
    await edit.getByLabel("New password", { exact: true }).fill("replacement-password");
    await edit.getByRole("button", { name: "Save changes" }).click();
    await expect(edit).toBeHidden();
    await visitor.reload();
    await applyPassword(visitor, "replacement-password");
    expect(
      (
        await downloaded(visitor, () =>
          visitor.getByRole("link", { name: "Download", exact: true }).click(),
        )
      ).toString(),
    ).toContain("Public hello");
    await page.getByRole("button", { name: "Edit Preserved password", exact: true }).click();
    edit = page.getByRole("dialog", { name: "Edit share link" });
    await edit.getByRole("combobox", { name: "Password protection" }).click();
    await page.getByRole("option", { name: "Remove password", exact: true }).click();
    await edit.getByRole("button", { name: "Save changes" }).click();
    await expect(edit).toBeHidden();
    await context.clearCookies();
    await visitor.reload();
    await expect(visitor.getByLabel("Share password")).toHaveCount(0);
    expect(
      (
        await downloaded(visitor, () =>
          visitor.getByRole("link", { name: "Download", exact: true }).click(),
        )
      ).toString(),
    ).toContain("Public hello");
    await page.getByRole("button", { name: "Revoke Preserved password", exact: true }).click();
    const revoke = page.getByRole("alertdialog");
    await expect(revoke).toContainText("original files remain");
    await revoke.getByRole("button", { name: "Revoke link" }).click();
    await expect(revoke).toBeHidden();
    await visitor.reload();
    await expect(
      visitor.locator('[data-slot="card-title"]').filter({ hasText: "Share unavailable" }),
    ).toBeVisible();
    expect(forbidden).toEqual([]);
  } finally {
    await context.close().catch(() => {});
  }
});

test("directory paths, bounded safe previews, Range and multipath ZIP use only public capabilities", async ({
  page,
  browser,
}) => {
  await loginAs(page, "share_owner", "share-owner-test-password");
  const mediaUpload = await page.request.put("/api/v1/fs/upload?path=%2Ffolder%2Faudio.wav", {
    headers: { "x-requested-with": "fdrive", "content-type": "application/octet-stream" },
    data: shareAudioFixture(),
  });
  expect(mediaUpload.ok()).toBe(true);
  const directory = await createLink(page, ["folder"], "Public folder", "folder-password");
  const archive = await createLink(page, ["hello.txt", "second.txt"], "Two documents");
  const context = await browser.newContext();
  const visitor = await context.newPage();
  const forbidden = publicRequests(visitor);
  try {
    await visitor.goto(directory);
    await applyPassword(visitor, "wrong");
    await expect(visitor.getByText(/password|credential|denied/i).last()).toBeVisible();
    await expect(visitor.getByRole("row").filter({ hasText: "document.docx" })).toHaveCount(0);
    await applyPassword(visitor, "folder-password");
    const unicode = visitor.getByRole("row").filter({ hasText: "日本 100%.txt" });
    await expect(unicode).toBeVisible();
    await unicode.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(visitor.getByRole("region", { name: "Preview of 日本 100%.txt" })).toContainText(
      "Unicode and literal percent",
    );
    await visitor.getByRole("button", { name: "Close preview" }).click();
    for (const name of ["document.docx", "active.svg", "oversize.txt"])
      await expect(
        visitor.getByRole("row").filter({ hasText: name }).getByRole("button", { name: "Preview" }),
      ).toHaveCount(0);
    await visitor
      .getByRole("row")
      .filter({ hasText: "readme.md" })
      .getByRole("button", { name: "Preview" })
      .click();
    const markdown = visitor.getByRole("region", { name: "Preview of readme.md" });
    await expect(markdown.getByRole("heading", { name: "Shared notes" })).toBeVisible();
    await expect(markdown.locator("script,img")).toHaveCount(0);
    await visitor.getByRole("button", { name: "Close preview" }).click();
    const mediaRange = visitor.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith("/download") &&
        new URL(response.url()).searchParams.get("path") === "/audio.wav" &&
        response.status() === 206,
    );
    await visitor
      .getByRole("row")
      .filter({ hasText: "audio.wav" })
      .getByRole("button", { name: "Preview" })
      .click();
    const rangeResponse = await mediaRange;
    expect(rangeResponse.request().headers().range).toMatch(/^bytes=/);
    await expect
      .poll(() => visitor.locator("audio").evaluate((audio: HTMLAudioElement) => audio.readyState))
      .toBeGreaterThan(0);
    await visitor.getByRole("button", { name: "Close preview" }).click();
    await visitor.getByRole("link", { name: "nested", exact: true }).click();
    await expect(visitor).toHaveURL(/path=%2Fnested/);
    const literal = visitor.getByRole("row").filter({ hasText: "literal%2f.txt" });
    const href = await literal.getByRole("link", { name: "Download" }).getAttribute("href");
    if (!href) throw new Error("Missing download URL");
    const ranged = await visitor.request.get(new URL(href, directory).href, {
      headers: { Range: "bytes=0-6" },
    });
    expect(ranged.status()).toBe(206);
    expect(await ranged.text()).toBe("Literal");
    expect(
      (
        await downloaded(visitor, () => literal.getByRole("link", { name: "Download" }).click())
      ).toString(),
    ).toBe("Literal percent slash text");
    await visitor.goto(archive);
    await expect(visitor.getByRole("table")).toHaveCount(0);
    await expect(visitor.getByRole("button", { name: "Preview" })).toHaveCount(0);
    const zip = await downloaded(visitor, () =>
      visitor.getByRole("link", { name: "Download ZIP" }).click(),
    );
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    expect(zip.includes(Buffer.from("hello.txt"))).toBe(true);
    expect(zip.includes(Buffer.from("second.txt"))).toBe(true);
    expect(forbidden).toEqual([]);
  } finally {
    await context.close().catch(() => {});
  }
});

test("upload-only retries password failures, forbids reads, and reports expired and exhausted links", async ({
  page,
  browser,
}, testInfo) => {
  await loginAs(page, "share_owner", "share-owner-test-password");
  const url = await createLink(page, ["incoming"], "Upload inbox", "upload-password", true);
  const id = new URL(url).pathname.split("/").at(-1);
  if (!id) throw new Error("Missing share id");
  const context = await browser.newContext();
  const visitor = await context.newPage();
  const forbidden = publicRequests(visitor);
  try {
    await visitor.goto(url);
    await expect(visitor.getByRole("table")).toHaveCount(0);
    await expect(visitor.getByRole("link", { name: /Download/ })).toHaveCount(0);
    await applyPassword(visitor, "wrong");
    await visitor.getByLabel("Choose files to upload").setInputFiles({
      name: "public-upload.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Public upload contents"),
    });
    await expect(visitor.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await applyPassword(visitor, "upload-password");
    await visitor.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(visitor.getByText("Uploaded", { exact: true })).toBeVisible();
    for (const route of ["entries", "download", "archive"]) {
      const response = await visitor.request.get(
        new URL(`/api/v1/public/shares/${id}/${route}`, url).href,
      );
      expect(response.status()).toBe(403);
    }
    const owner = await page.request.get(
      "/api/v1/fs/download?path=%2Fincoming%2Fpublic-upload.txt",
    );
    expect(await owner.text()).toBe("Public upload contents");
    const create = async (name: string, expiresAt: string | null, maxDownloads: number) => {
      const response = await page.request.post("/api/v1/shares", {
        headers: { "x-requested-with": "fdrive" },
        data: { name, paths: ["/hello.txt"], scope: "read", expiresAt, maxDownloads },
      });
      expect(response.ok(), await response.text()).toBe(true);
      return ManagedShare.parse(await response.json());
    };
    const expired = await create("Expired", new Date(Date.now() + 2000).toISOString(), 0);
    await expect
      .poll(async () => {
        const response = await visitor.request.get(
          new URL(`/api/v1/public/shares/${expired.id}`, url).href,
        );
        return ((await response.json()) as { unavailableReason: string | null }).unavailableReason;
      })
      .toBe("expired");
    await visitor.goto(new URL(expired.publicPath, url).href);
    await expect(visitor.getByText("This link has expired.", { exact: true })).toBeVisible();
    const limited = await create("One download", null, 1);
    await visitor.goto(new URL(limited.publicPath, url).href);
    await expect(visitor.getByRole("button", { name: "Preview", exact: true })).toHaveCount(0);
    await expect(visitor.getByRole("link", { name: "Download", exact: true })).toBeVisible();
    const beforeDownload = await visitor.request.get(
      new URL(`/api/v1/public/shares/${limited.id}`, url).href,
    );
    expect(beforeDownload.ok(), await beforeDownload.text()).toBe(true);
    expect((await beforeDownload.json()) as { usedDownloads: number }).toMatchObject({
      usedDownloads: 0,
    });
    await visitor.screenshot({
      path: testInfo.outputPath("limited-share-before-download.png"),
      fullPage: true,
    });
    await downloaded(visitor, () =>
      visitor.getByRole("link", { name: "Download", exact: true }).click(),
    );
    await visitor.getByRole("button", { name: "Refresh share" }).click();
    await expect(
      visitor.getByText("This link has reached its download limit.", { exact: true }),
    ).toBeVisible();
    expect(forbidden).toEqual([]);
  } finally {
    await context.close().catch(() => {});
  }
});

test("an image-only folder shows a gallery with lightbox navigation and per-image download, a plain file still shows the download card, and the dialog uses friendly labels", async ({
  page,
  browser,
}) => {
  await loginAs(page, "share_owner", "share-owner-test-password");
  for (const name of ["1.png", "2.png", "3.png"]) {
    const upload = await page.request.put(
      `/api/v1/fs/upload?path=${encodeURIComponent(`/images/${name}`)}&mkdirParents=true`,
      {
        headers: { "x-requested-with": "fdrive", "content-type": "application/octet-stream" },
        data: shareImageFixture(),
      },
    );
    expect(upload.ok()).toBe(true);
  }
  await page.goto("/files");
  await listing(page).getByText("images", { exact: true }).click();
  await listing(page).getByText("images", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create share link", exact: true });
  await expect(dialog.getByRole("combobox", { name: "Access" })).toContainText("Can view");
  await expect(dialog.getByRole("combobox", { name: "Show as" })).toContainText("Automatic");
  await dialog.getByLabel("Link name", { exact: true }).fill("Photo folder");
  await dialog.getByRole("button", { name: "Create link", exact: true }).click();
  const ready = page.getByRole("dialog", { name: "Share link ready" });
  await expect(ready).toBeVisible();
  const galleryUrl = await ready.getByLabel("Share link", { exact: true }).inputValue();
  await ready.getByRole("button", { name: "Done" }).click();
  const documentUrl = await createLink(page, ["hello.txt"], "Plain document");

  for (const viewport of [DESKTOP_VIEWPORT, MOBILE_VIEWPORT]) {
    const context = await browser.newContext({ viewport });
    const visitor = await context.newPage();
    const thumbRequests: string[] = [];
    visitor.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith("/thumb")) thumbRequests.push(url.pathname);
    });
    try {
      await visitor.goto(galleryUrl);
      const tiles = visitor.locator("button img");
      await expect(tiles).toHaveCount(3);
      await expect.poll(() => thumbRequests.length).toBeGreaterThanOrEqual(3);
      await tiles.first().click();
      // A full-page lightbox, not a modal: it fills the viewport and carries no Base UI
      // Dialog backdrop, unlike the Create/Edit share dialogs used above.
      const lightbox = visitor.getByRole("dialog");
      await expect(lightbox).toBeVisible();
      await expect(lightbox).toHaveCSS("position", "fixed");
      const box = await lightbox.boundingBox();
      const viewportSize = visitor.viewportSize();
      expect(box?.width).toBe(viewportSize?.width);
      expect(box?.height).toBe(viewportSize?.height);
      const header = lightbox.locator("header");
      const firstText = await header.textContent();
      await visitor.keyboard.press("ArrowRight");
      await expect(header).not.toHaveText(firstText ?? "");
      const image = await downloaded(visitor, () =>
        lightbox.getByRole("link", { name: "Download", exact: true }).click(),
      );
      expect(image.length).toBeGreaterThan(0);
      await visitor.keyboard.press("Escape");
      await expect(lightbox).toBeHidden();
      const zipButton = visitor.getByRole("link", { name: "Download ZIP", exact: true });
      await expect(zipButton.locator("svg")).toBeVisible();
      await expect(zipButton.locator(".sr-only")).toHaveText("Download ZIP");
      await downloaded(visitor, () => zipButton.click());

      await visitor.goto(documentUrl);
      await expect(visitor.getByRole("link", { name: "Download", exact: true })).toBeVisible();
      await expect(visitor.getByRole("img")).toHaveCount(0);
    } finally {
      await context.close().catch(() => {});
    }
  }
});

test("a shared ZIP can be peeked without extracting it, hidden on a limited link, and shown beside a single archive file's own download", async ({
  page,
  browser,
}) => {
  await loginAs(page, "share_owner", "share-owner-test-password");
  const zip = shareZipFixture({ "a.txt": "hello from inside the zip", "dir/b.txt": "nested" });
  const directoryUpload = await page.request.put(
    "/api/v1/fs/upload?path=%2Fzips%2Fbundle.zip&mkdirParents=true",
    {
      headers: { "x-requested-with": "fdrive", "content-type": "application/octet-stream" },
      data: zip,
    },
  );
  expect(directoryUpload.ok()).toBe(true);
  const singleUpload = await page.request.put("/api/v1/fs/upload?path=%2Fsingle.zip", {
    headers: { "x-requested-with": "fdrive", "content-type": "application/octet-stream" },
    data: zip,
  });
  expect(singleUpload.ok()).toBe(true);
  const directory = await createLink(page, ["zips"], "Public zips folder");
  const single = await createLink(page, ["single.zip"], "Single archive");
  const create = async (name: string, paths: string[], maxDownloads: number) => {
    const response = await page.request.post("/api/v1/shares", {
      headers: { "x-requested-with": "fdrive" },
      data: { name, paths, scope: "read", expiresAt: null, maxDownloads },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return ManagedShare.parse(await response.json());
  };
  const limitedShare = await create("Limit one", ["/single.zip"], 1);

  const context = await browser.newContext();
  const visitor = await context.newPage();
  const forbidden = publicRequests(visitor);
  try {
    await visitor.goto(directory);
    const zipRow = visitor.getByRole("row").filter({ hasText: "bundle.zip" });
    await expect(zipRow).toBeVisible();
    await zipRow.getByRole("button", { name: "Peek", exact: true }).click();
    const peekRegion = visitor.getByRole("region", { name: "Archive entries for bundle.zip" });
    await expect(peekRegion).toBeVisible();
    await expect(peekRegion.getByText("a.txt")).toBeVisible();
    await expect(peekRegion.getByText("dir/b.txt")).toBeVisible();
    await expect(peekRegion.getByRole("link")).toHaveCount(0);
    await peekRegion.getByRole("button", { name: "Close preview" }).click();
    await expect(peekRegion).toBeHidden();

    await visitor.goto(single);
    await expect(visitor.getByRole("button", { name: "Peek", exact: true })).toBeVisible();
    await visitor.getByRole("button", { name: "Peek", exact: true }).click();
    const singlePeek = visitor.getByRole("region", { name: "Archive entries for single.zip" });
    await expect(singlePeek).toBeVisible();
    await expect(singlePeek.getByText("a.txt")).toBeVisible();

    await visitor.goto(new URL(limitedShare.publicPath, single).href);
    await expect(visitor.getByRole("button", { name: "Peek", exact: true })).toHaveCount(0);
    expect(forbidden).toEqual([]);
  } finally {
    await context.close().catch(() => {});
  }
});

test("a HEIC single-file share resolves to a gallery tile and opens the lightbox", async ({
  page,
  browser,
}) => {
  await loginAs(page, "share_owner", "share-owner-test-password");
  const upload = await page.request.put("/api/v1/fs/upload?path=%2Fphoto.heic", {
    headers: { "x-requested-with": "fdrive", "content-type": "image/heic" },
    data: shareHeicFixture(),
  });
  expect(upload.ok()).toBe(true);

  const url = await createLink(page, ["photo.heic"], "Shared HEIC");
  const context = await browser.newContext();
  const visitor = await context.newPage();
  try {
    await visitor.goto(url);
    const tile = visitor.getByRole("button", { name: "photo.heic" });
    await expect(tile).toBeVisible();
    await tile.click();
    const lightbox = visitor.getByRole("dialog");
    await expect(lightbox).toBeVisible();
    await expect(lightbox.locator('img[alt="photo.heic"]')).toBeVisible();
  } finally {
    await context.close().catch(() => {});
  }
});
