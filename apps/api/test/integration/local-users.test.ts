import { readFile } from "node:fs/promises";
import { AdminUser, AdminUsersResponse, MeResponse, ROUTES } from "@fdrive/contracts";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { seedLocalUsers, silentLogger } from "./helpers/local-storage.ts";

const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";

/**
 * System > Users against Postgres: an administrator adds, disables,
 * re-enables, promotes and removes local users (`/api/v1/admin/users`), and
 * a user changes their own password (`/api/v1/auth/password`). Each change
 * shows at the next sign-in, and a disabled or new password ends sessions.
 */
describe("local users administered through the API", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let storage: Awaited<ReturnType<typeof startLocalStorage>>;
  let composed: Awaited<ReturnType<typeof composeApp>>;

  beforeAll(async () => {
    [postgres, storage] = await Promise.all([
      startPostgres(),
      startLocalStorage({
        users: [
          { username: "alice", password: "alice-password" },
          { username: "bob", password: "bob-password" },
        ],
        files: {},
      }),
    ]);
    await seedLocalUsers(postgres.connectionString, storage);
    composed = await composeApp(
      loadConfig({
        DATABASE_URL: postgres.connectionString,
        FDRIVE_STORAGE_ROOT: storage.root,
        FDRIVE_MASTER_KEY: Buffer.alloc(32, 29).toString("base64"),
        FDRIVE_ADMIN_USERS: "alice",
      }),
      silentLogger(),
    );
  }, 180_000);

  afterAll(async () => {
    await composed?.close();
    await storage?.stop();
    await postgres?.stop();
  }, 180_000);

  async function call(
    path: string,
    options: { method?: string; cookie?: string; body?: unknown } = {},
  ) {
    return composed.app.request(path, {
      method: options.method ?? "GET",
      headers: {
        "x-requested-with": "fdrive",
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }
  const signIn = (username: string, password: string) =>
    call(ROUTES.auth.login, { method: "POST", body: { credential: { username, password } } });
  async function login(username: string, password: string): Promise<string> {
    const response = await signIn(username, password);
    expect(response.status, username).toBe(200);
    return cookieFrom(response);
  }
  const user = (username: string) => `${ROUTES.admin.users}/${username}`;
  const users = async (cookie: string) => {
    const response = await call(ROUTES.admin.users, { cookie });
    expect(response.status).toBe(200);
    return AdminUsersResponse.parse(await response.json());
  };

  it("adds, disables, re-enables, promotes and removes users, and ends their sessions", async () => {
    const alice = await login("alice", "alice-password");
    const bob = await login("bob", "bob-password");

    const listed = await users(alice);
    expect(listed.available).toBe(true);
    expect(
      listed.users.map(({ username, disabled, isAdmin, isYou }) => ({
        username,
        disabled,
        isAdmin,
        isYou,
      })),
    ).toEqual([
      { username: "alice", disabled: false, isAdmin: true, isYou: true },
      { username: "bob", disabled: false, isAdmin: false, isYou: false },
    ]);
    expect(listed.users.every((entry) => entry.lastLoginAt !== null)).toBe(true);
    // Only administrators manage users.
    expect((await call(ROUTES.admin.users, { cookie: bob })).status).toBe(403);
    expect(
      (
        await call(ROUTES.admin.users, {
          method: "POST",
          cookie: bob,
          body: { username: "mallory", password: "mallory-password" },
        })
      ).status,
    ).toBe(403);

    // Adding a user: its login exists before the first sign-in.
    const created = await call(ROUTES.admin.users, {
      method: "POST",
      cookie: alice,
      body: { username: "dave", password: "dave-password" },
    });
    expect(created.status).toBe(201);
    expect(AdminUser.parse(await created.json())).toMatchObject({
      username: "dave",
      disabled: false,
      isAdmin: false,
      lastLoginAt: null,
    });
    for (const [body, status] of [
      [{ username: "Dave", password: "other-password" }, 409],
      [{ username: "../dave", password: "dave-password" }, 400],
      [{ username: "erin", password: "short" }, 400],
    ] as const) {
      const refused = await call(ROUTES.admin.users, { method: "POST", cookie: alice, body });
      expect(refused.status, body.username).toBe(status);
    }
    const dave = await login("dave", "dave-password");
    const upload = await composed.app.request(`${ROUTES.fs.upload}?path=/hello.txt`, {
      method: "PUT",
      headers: { cookie: dave, "x-requested-with": "fdrive" },
      body: "hello",
    });
    expect(upload.status).toBe(201);
    expect(await readFile(storage.path("dave", "/hello.txt"), "utf8")).toBe("hello");

    // Disabling ends dave's sessions at once and refuses his next sign-in.
    const disabled = await call(user("dave"), {
      method: "PATCH",
      cookie: alice,
      body: { disabled: true },
    });
    expect(disabled.status).toBe(200);
    expect((await call(ROUTES.auth.me, { cookie: dave })).status).toBe(401);
    expect((await signIn("dave", "dave-password")).status).toBe(403);
    expect((await signIn("dave", "wrong-password")).status).toBe(401);

    // Re-enabled with a new password: the old one no longer works.
    const reset = await call(user("dave"), {
      method: "PATCH",
      cookie: alice,
      body: { disabled: false, password: "dave-new-password" },
    });
    expect(AdminUser.parse(await reset.json())).toMatchObject({ disabled: false });
    expect((await signIn("dave", "dave-password")).status).toBe(401);
    const promoted = await call(user("dave"), {
      method: "PATCH",
      cookie: alice,
      body: { isAdmin: true },
    });
    expect(AdminUser.parse(await promoted.json())).toMatchObject({ isAdmin: true });
    const daveAgain = await login("dave", "dave-new-password");
    expect(
      MeResponse.parse(await (await call(ROUTES.auth.me, { cookie: daveAgain })).json()),
    ).toMatchObject({ isAdmin: true });

    // An administrator can neither disable nor remove themselves.
    expect(
      (await call(user("alice"), { method: "PATCH", cookie: alice, body: { disabled: true } }))
        .status,
    ).toBe(403);
    expect((await call(user("alice"), { method: "DELETE", cookie: alice })).status).toBe(403);
    expect((await call(user("nobody"), { method: "PATCH", cookie: alice, body: {} })).status).toBe(
      404,
    );

    // Removing dave signs him out and stops his password; his files stay on disk.
    expect((await call(user("dave"), { method: "DELETE", cookie: alice })).status).toBe(200);
    expect((await call(ROUTES.auth.me, { cookie: daveAgain })).status).toBe(401);
    expect((await signIn("dave", "dave-new-password")).status).toBe(401);
    expect(await readFile(storage.path("dave", "/hello.txt"), "utf8")).toBe("hello");
    expect((await users(alice)).users.map((entry) => entry.username)).toEqual(["alice", "bob"]);
  });

  it("lets a user change their own password from a signed-in browser only", async () => {
    const bob = await login("bob", "bob-password");
    const other = await login("bob", "bob-password");
    const change = (cookie: string, currentPassword: string, newPassword: string) =>
      call(ROUTES.auth.password, {
        method: "POST",
        cookie,
        body: { currentPassword, newPassword },
      });

    expect((await change(bob, "wrong-password", "bob-new-password")).status).toBe(401);
    expect((await change(bob, "bob-password", "short")).status).toBe(400);
    expect((await change(bob, "bob-password", "bob-new-password")).status).toBe(200);
    // The session that changed it stays; bob's other sessions end.
    expect((await call(ROUTES.auth.me, { cookie: bob })).status).toBe(200);
    expect((await call(ROUTES.auth.me, { cookie: other })).status).toBe(401);
    expect((await signIn("bob", "bob-password")).status).toBe(401);
    await login("bob", "bob-new-password");
  });
});
