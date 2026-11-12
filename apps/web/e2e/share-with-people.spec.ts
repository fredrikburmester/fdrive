import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { dismissActivityPanel } from "./support/activity.js";
import { homePath } from "./support/local-folder.js";
import { loginAs } from "./support/login.js";
import {
  PEOPLE_FILE,
  PEOPLE_FOLDER,
  PEOPLE_GUEST,
  PEOPLE_OWNER,
} from "./support/people-fixture.js";
import { listing, sidebar } from "./support/regions.js";
import { uploadFiles } from "./support/upload.js";

test.use({ storageState: { cookies: [], origins: [] } });

const SHARED_HREF = `/files/Shared%20with%20me/${encodeURIComponent(PEOPLE_FOLDER)}`;
const VIEW_ONLY = `${PEOPLE_OWNER.username} shares this folder with you to view only.`;

/** The guest's own signed-out browser, next to the owner's. */
async function guestPage(page: Page): Promise<Page> {
  const browser = page.context().browser();
  if (browser === null) throw new Error("no browser");
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    baseURL: new URL(page.url()).origin,
  });
  return context.newPage();
}

/** Removes every grant the owner has, so a retry starts from nothing shared. */
async function stopSharingEverything(owner: Page): Promise<void> {
  const response = await owner.request.get("/api/v1/grants");
  if (!response.ok()) return;
  const body = (await response.json()) as { owned?: { id: string }[] };
  for (const grant of body.owned ?? []) {
    await owner.request.delete(`/api/v1/grants/${grant.id}`, {
      headers: { "x-requested-with": "fdrive" },
    });
  }
}

test("an owner shares a folder to view, then to edit, and the person it is shared with uploads and leaves", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await loginAs(page, PEOPLE_OWNER.username, PEOPLE_OWNER.password);
  await stopSharingEverything(page);
  const guest = await guestPage(page);
  try {
    // Nothing is shared with the guest yet: no Shared with me.
    await loginAs(guest, PEOPLE_GUEST.username, PEOPLE_GUEST.password);
    await expect(
      sidebar(guest).getByRole("link", { name: "Shared with me", exact: true }),
    ).toHaveCount(0);

    // The owner shares the folder to view only.
    await listing(page).getByText(PEOPLE_FOLDER, { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Share with people" }).click();
    const dialog = page.getByRole("dialog", { name: `Share ${PEOPLE_FOLDER}` });
    await expect(dialog.getByText("Not shared with anyone yet.")).toBeVisible();
    await dialog.getByRole("combobox", { name: "Person" }).click();
    await page.getByRole("option", { name: PEOPLE_GUEST.username, exact: true }).click();
    await expect(dialog.getByRole("combobox", { name: "Access for the new person" })).toHaveText(
      "Can view",
    );
    await dialog.getByRole("button", { name: "Share", exact: true }).click();
    await expect(
      page.getByText(`Shared ${PEOPLE_FOLDER} with ${PEOPLE_GUEST.username}.`),
    ).toBeVisible();
    const people = dialog.getByRole("list", { name: "People with access" });
    await expect(people.getByText(PEOPLE_GUEST.username, { exact: true })).toBeVisible();
    await expect(
      people.getByRole("combobox", { name: `Access for ${PEOPLE_GUEST.username}` }),
    ).toHaveText("Can view");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();

    // The guest finds it under Shared with me, captioned with its owner and access.
    await guest.goto("/files");
    const sharedWithMe = sidebar(guest).getByRole("link", { name: "Shared with me", exact: true });
    await expect(sharedWithMe).toBeVisible();
    await sharedWithMe.click();
    await expect(listing(guest).getByText(PEOPLE_FOLDER, { exact: true })).toBeVisible();
    await expect(
      listing(guest).getByText(`${PEOPLE_OWNER.username} · Can view`, { exact: true }),
    ).toBeVisible();
    await guest.goto(SHARED_HREF);
    await expect(listing(guest).getByText(PEOPLE_FILE, { exact: true })).toBeVisible();

    // To view only: nothing can be added, and the API agrees.
    const create = guest.getByRole("button", { name: "New" });
    await expect(create).toBeDisabled();
    await expect(create).toHaveAttribute("title", VIEW_ONLY);
    const refused = await guest.request.put(
      `/api/v1/fs/upload?path=${encodeURIComponent(`/Shared with me/${PEOPLE_FOLDER}/refused.txt`)}`,
      { headers: { "x-requested-with": "fdrive" }, data: Buffer.from("refused") },
    );
    expect(refused.status()).toBe(403);

    // The owner lets the guest edit, from Shares > Shared with people.
    await sidebar(page).getByRole("link", { name: "Shares", exact: true }).click();
    const section = page.getByRole("region", { name: "Shared with people" });
    const grantRow = section.getByRole("row").filter({ hasText: PEOPLE_GUEST.username });
    await expect(grantRow.getByText(`/${PEOPLE_FOLDER}`, { exact: true })).toBeVisible();
    await dismissActivityPanel(page);
    await grantRow
      .getByRole("combobox", { name: `Access for ${PEOPLE_GUEST.username} to ${PEOPLE_FOLDER}` })
      .click();
    await page.getByRole("option", { name: "Can edit", exact: true }).click();
    await expect(
      page.getByText(`${PEOPLE_GUEST.username} can now edit ${PEOPLE_FOLDER}.`),
    ).toBeVisible();

    // Now the guest uploads, and the file lands in the owner's folder on disk.
    const name = "from-the-guest.txt";
    await guest.goto(SHARED_HREF);
    await expect(guest.getByRole("button", { name: "New" })).toBeEnabled();
    await uploadFiles(guest, [{ name, mimeType: "text/plain", contents: "added by the guest" }]);
    await expect(listing(guest).getByText(name, { exact: true })).toBeVisible();
    await expect
      .poll(
        async () =>
          readFile(homePath(PEOPLE_OWNER.username, `/${PEOPLE_FOLDER}/${name}`), "utf8").catch(
            () => null,
          ),
        { timeout: 15_000 },
      )
      .toBe("added by the guest");
    await page.goto(`/files/${encodeURIComponent(PEOPLE_FOLDER)}`);
    await expect(listing(page).getByText(name, { exact: true })).toBeVisible();

    // The guest leaves: the folder disappears for them and stays the owner's.
    await guest.goto("/files/Shared%20with%20me");
    await listing(guest).getByText(PEOPLE_FOLDER, { exact: true }).click({ button: "right" });
    await guest.getByRole("menuitem", { name: "Leave", exact: true }).click();
    const leave = guest.getByRole("alertdialog", { name: `Leave ${PEOPLE_FOLDER}?` });
    await leave.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(guest.getByText(`Left ${PEOPLE_FOLDER}.`)).toBeVisible();
    await expect(
      sidebar(guest).getByRole("link", { name: "Shared with me", exact: true }),
    ).toHaveCount(0);
    await page.goto("/shares");
    await expect(page.getByText("You don't share any folders with people yet.")).toBeVisible();
    expect(
      await readFile(homePath(PEOPLE_OWNER.username, `/${PEOPLE_FOLDER}/${name}`), "utf8"),
    ).toBe("added by the guest");
  } finally {
    await stopSharingEverything(page);
    await guest.context().close();
  }
});
