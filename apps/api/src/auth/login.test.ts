import { MeResponse, ROUTES } from "@fdrive/contracts";
import { LoginError } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import { authHarness } from "./test-fixtures/index.ts";

describe("sign-in persistence errors", () => {
  it("maps a missing login and conceals arbitrary SQL errors", async () => {
    const h = authHarness();
    const signIn = vi.spyOn(h.repos.logins, "signIn");
    const attempt = () =>
      h.call(ROUTES.auth.login, {
        method: "POST",
        body: { username: "alice", password: "alice-pass" },
      });
    signIn.mockRejectedValueOnce(new LoginError("missing_identity"));
    expect((await attempt()).status).toBe(401);
    signIn.mockRejectedValueOnce(new Error("SQL secret bind value"));
    const response = await attempt();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("SQL secret");
    expect(h.logger.error).not.toHaveBeenCalled();
  });
});

describe("signing in", () => {
  const signIn = (h: ReturnType<typeof authHarness>, username: string, password: string) =>
    h.call(ROUTES.auth.login, { method: "POST", body: { username, password } });

  it("finds the same login whatever case the username is typed in", async () => {
    const h = authHarness();
    const lower = await h.login("alice");
    const upper = await signIn(h, "ALICE", "alice-pass");
    expect(upper.status).toBe(200);
    const me = MeResponse.parse(await upper.json());
    expect(me.identity).toMatchObject({ id: lower.me.identity.id, username: "alice" });
    expect(me.account.id).toBe(lower.me.account.id);
    expect(await h.repos.identities.listAll()).toHaveLength(6);
    expect((await h.repos.identities.get(lower.me.identity.id))?.lastLoginAt).toEqual(h.now.value);
  });

  it("refuses a wrong password, an unknown name and a name no user can have alike", async () => {
    const h = authHarness();
    for (const [username, password] of [
      ["alice", "wrong"],
      ["nobody", "alice-pass"],
      ["../alice", "alice-pass"],
    ] as const) {
      const response = await signIn(h, username, password);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { kind: "unauthorized", message: "invalid username or password" },
      });
    }
    // Every one of them counted against the address.
    for (let n = 0; n < 2; n++) await signIn(h, "alice", "wrong");
    expect((await signIn(h, "bob", "bob-pass")).status).toBe(429);
  });

  it("refuses a disabled user, telling them so only with the right password", async () => {
    const h = authHarness();
    await h.seeded;
    await h.repos.localUsers.update("carol", { disabled: true });
    const right = await signIn(h, "carol", "carol-pass");
    expect(right.status).toBe(403);
    expect(await right.json()).toMatchObject({ error: { kind: "forbidden" } });
    expect((await signIn(h, "carol", "guess")).status).toBe(401);
    expect(right.headers.get("set-cookie")).toBeNull();
  });

  it("rejects the old credential body and unknown fields", async () => {
    const h = authHarness();
    for (const body of [
      { credential: { username: "alice", password: "alice-pass" } },
      { username: "alice", password: "alice-pass", providerId: "x" },
      { username: "alice", password: "alice-pass", otp: "123456" },
    ])
      expect((await h.call(ROUTES.auth.login, { method: "POST", body })).status).toBe(400);
  });

  it("signing in again keeps the account's other sessions", async () => {
    const h = authHarness();
    const first = await h.login();
    const second = await h.login();
    expect((await h.call(ROUTES.auth.me, { cookie: first.cookie })).status).toBe(200);
    expect((await h.call(ROUTES.auth.me, { cookie: second.cookie })).status).toBe(200);
  });
});

describe("the signed-in login", () => {
  it("is the account's one login on the files folder, with the installation's name and index flag", async () => {
    const h = authHarness();
    const row = await h.seeded;
    const a = await h.login();
    expect(a.me.identity).toEqual({
      id: expect.any(String),
      username: "alice",
      providerId: row.id,
    });
    expect(a.me).toMatchObject({
      isAdmin: false,
      storageName: "Local folder",
      index: false,
    });
    const me = await h.call(ROUTES.auth.me, { cookie: a.cookie });
    expect(await me.json()).toEqual(a.me);
  });
  it("is refused once the login is gone", async () => {
    const h = authHarness();
    await h.login();
    await expect(h.auth.service.me("00000000-0000-4000-8000-000000000099")).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });
});

it("one address cannot spray passwords across usernames: a per-IP bucket blocks independently of the username", async () => {
  const h = authHarness();
  const from = (ip: string) => ({ "x-forwarded-for": ip });
  // Five failures spread over five different usernames from one address...
  for (const username of ["alice", "bob", "carol", "dave", "eve"])
    expect(
      (
        await h.call(ROUTES.auth.login, {
          method: "POST",
          headers: from("203.0.113.7"),
          body: { username, password: "wrong" },
        })
      ).status,
    ).toBe(401);
  // ...block a sixth, never-tried username from that address, even with the right password.
  const blocked = await h.call(ROUTES.auth.login, {
    method: "POST",
    headers: from("203.0.113.7"),
    body: { username: "frank", password: "frank-pass" },
  });
  expect(blocked.status).toBe(429);
  // Another address is unaffected.
  expect(
    (
      await h.call(ROUTES.auth.login, {
        method: "POST",
        headers: from("203.0.113.8"),
        body: { username: "frank", password: "frank-pass" },
      })
    ).status,
  ).toBe(200);
  // A success does not reset the address bucket: four failures plus one valid
  // login, then a further failure, still trips the block.
  for (let n = 0; n < 4; n++)
    await h.call(ROUTES.auth.login, {
      method: "POST",
      headers: from("203.0.113.9"),
      body: { username: `user${n}`, password: "wrong" },
    });
  expect(
    (
      await h.call(ROUTES.auth.login, {
        method: "POST",
        headers: from("203.0.113.9"),
        body: { username: "alice", password: "alice-pass" },
      })
    ).status,
  ).toBe(200);
  await h.call(ROUTES.auth.login, {
    method: "POST",
    headers: from("203.0.113.9"),
    body: { username: "user5", password: "wrong" },
  });
  expect(
    (
      await h.call(ROUTES.auth.login, {
        method: "POST",
        headers: from("203.0.113.9"),
        body: { username: "bob", password: "bob-pass" },
      })
    ).status,
  ).toBe(429);
});
