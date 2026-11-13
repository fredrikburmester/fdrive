import { ProvidersResponse } from "@fdrive/contracts";
import { expect, test } from "@playwright/test";
import { loginAs } from "./support/login.js";

// The login page must be exercised signed out.
test.use({ storageState: { cookies: [], origins: [] } });

test("the login page signs in to the one storage: no server picker, no storage note", async ({
  page,
}) => {
  const listed = ProvidersResponse.parse(
    await (await page.request.get("/api/v1/providers")).json(),
  );
  expect(listed.providers.map((provider) => provider.type)).toEqual(["local"]);
  const [storage] = listed.providers;
  if (storage === undefined) throw new Error("the e2e stack serves no files folder");

  await page.goto("/login");
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.getByLabel("Server")).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  // A login has a username and a password, nothing more.
  await expect(page.getByLabel(/one-time code/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Use a one-time code" })).toHaveCount(0);
  // Every account is an fdrive account; nothing says what the storage lacks.
  await expect(page.getByText(/^Sign in with your fdrive account/)).toBeVisible();
  await expect(page.getByText(/available on this storage|Files only/)).toHaveCount(0);

  const loginRequest = page.waitForRequest(
    (request) => request.url().endsWith("/api/v1/auth/login") && request.method() === "POST",
  );
  await loginAs(page, "alice", "alice-password");
  expect((await loginRequest).postDataJSON()).toEqual({
    providerId: storage.id,
    credential: { username: "alice", password: "alice-password" },
  });
  await expect(page).toHaveURL(/\/files$/);
});
