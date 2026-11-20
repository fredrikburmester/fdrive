import { expect, test } from "@playwright/test";
import { loginAs } from "./support/login.js";
import { ENCRYPTION_USER } from "./support/people-fixture.js";
import { listing } from "./support/regions.js";
import { uploadFiles } from "./support/upload.js";

test.use({ storageState: { cookies: [], origins: [] } });

const HEADERS = { "x-requested-with": "fdrive" };
const ENCRYPTION_PASSWORD = "a long encryption password";

test("turns encryption on, keeps names and files encrypted on the server, and opens them here", async ({
  page,
}) => {
  test.slow();
  const { username, password } = ENCRYPTION_USER;
  await loginAs(page, username, password);

  // Settings > Encryption: a password, then the recovery key pasted back.
  await page.goto("/account/encryption");
  const section = page
    .locator('[data-slot="page-section"]')
    .filter({ hasText: "Encryption password" });
  await section.getByLabel("Encryption password", { exact: true }).fill(ENCRYPTION_PASSWORD);
  await section.getByLabel("Confirm encryption password").fill(ENCRYPTION_PASSWORD);
  await section.getByLabel("Sign-in password").fill(password);
  await section.getByRole("button", { name: "Continue" }).click();
  const recovery = page.locator('[data-slot="recovery-key"]');
  await expect(recovery).toContainText("AGE-SECRET-KEY-1", { timeout: 30_000 });
  const recoveryKey = (await recovery.textContent())?.trim() ?? "";
  await page.getByRole("textbox", { name: "Paste your recovery key" }).fill(recoveryKey);
  await page.getByRole("button", { name: "Turn on encryption" }).click();
  await expect(page.getByRole("button", { name: "Lock this browser" })).toBeVisible({
    timeout: 30_000,
  });

  // A new encrypted folder, and a file uploaded into it.
  await page.goto("/files");
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "Encrypted folder" }).click();
  const dialog = page.getByRole("dialog", { name: "New encrypted folder" });
  await dialog.getByLabel("Folder name").fill("Private");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
  await page.goto("/files/Private");
  // Uploads wait until the folder is open with its key.
  await expect(page.getByText("This folder is empty")).toBeVisible({ timeout: 30_000 });
  await uploadFiles(page, [
    { name: "secret.txt", mimeType: "text/plain", contents: "hello there" },
  ]);
  await expect(listing(page).getByText("secret.txt", { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // The server holds an encrypted name and ciphertext, and no route but the file routes reaches it.
  const stored = await page.request.get("/api/v1/fs/list?path=/Private", { headers: HEADERS });
  const body = (await stored.json()) as { entries: { name: string; path: string }[] };
  expect(body.entries).toHaveLength(1);
  const [entry] = body.entries;
  expect(entry?.name.startsWith("fe1-")).toBe(true);
  const raw = await page.request.get(
    `/api/v1/fs/download?path=${encodeURIComponent(entry?.path ?? "")}`,
  );
  expect((await raw.text()).startsWith("age-encryption.org/v1\n")).toBe(true);
  const zip = await page.request.post("/api/v1/fs/zip", {
    headers: HEADERS,
    data: { paths: ["/Private"] },
  });
  expect(zip.status()).toBe(403);

  // Opened here, it is the clear file.
  await listing(page).getByText("secret.txt", { exact: true }).dblclick();
  await expect(page.getByText("hello there")).toBeVisible({ timeout: 30_000 });

  // Cleanup, not under test: the folder and the keys.
  await page.request.post("/api/v1/fs/delete", {
    headers: HEADERS,
    data: { items: [{ path: "/Private", kind: "dir" }] },
  });
  await page.request.post("/api/v1/encryption/reset", {
    headers: HEADERS,
    data: { signInPassword: password },
  });
});
