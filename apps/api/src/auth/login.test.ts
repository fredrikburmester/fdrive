import { ROUTES } from "@fdrive/contracts";
import { LoginError } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import { ApiHttpError } from "../errors.js";
import { open } from "./crypto.js";
import { authHarness, cookieFrom } from "./test-fixtures/index.ts";

describe("sign-in persistence errors", () => {
  it("maps typed repository errors and conceals arbitrary SQL errors", async () => {
    const h = authHarness();
    const login = vi.spyOn(h.logins, "loginVerified");
    const signIn = () =>
      h.call(ROUTES.auth.login, {
        method: "POST",
        body: { credential: { username: "alice", password: "alice-pass" } },
      });
    for (const [code, status] of [
      ["missing_account", 401],
      ["missing_provider", 404],
      ["missing_identity", 404],
      ["invalid_session", 401],
      ["setup_claimed", 409],
    ] as const) {
      login.mockRejectedValueOnce(new LoginError(code));
      expect((await signIn()).status).toBe(status);
    }
    const expected = new ApiHttpError("unauthorized", "safe");
    login.mockRejectedValueOnce(expected);
    const passed = await signIn();
    expect(passed.status).toBe(401);
    expect(await passed.text()).toContain("safe");
    login.mockRejectedValueOnce(new Error("SQL secret bind value"));
    const response = await signIn();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("SQL secret");
    expect(h.logger.error).not.toHaveBeenCalled();
  });
});

describe("the signed-in login", () => {
  it("is the account's one login, labelled by its storage, with what it can do", async () => {
    const h = authHarness();
    const a = await h.login();
    expect(a.me.identity).toMatchObject({
      username: "alice",
      providerType: "local",
      providerLabel: "Local folder",
    });
    expect(a.me.isAdmin).toBe(false);
    const me = await h.call(ROUTES.auth.me, { cookie: a.cookie });
    expect(await me.json()).toEqual(a.me);
  });
  it("is refused once the login, the account or the storage is gone", async () => {
    const h = authHarness();
    const a = await h.login();
    vi.spyOn(h.repos.identities, "get").mockResolvedValueOnce(null);
    await expect(h.auth.service.me(a.me.account.id, a.me.identity.id)).rejects.toMatchObject({
      kind: "unauthorized",
    });
    await expect(
      h.auth.service.me("00000000-0000-4000-8000-000000000099", a.me.identity.id),
    ).rejects.toMatchObject({ kind: "internal" });
    vi.spyOn(h.repos.providers, "get").mockResolvedValue(null);
    await expect(h.auth.service.me(a.me.account.id, a.me.identity.id)).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });
});

it("login with a replaced password revokes the account's other sessions; same password keeps them", async () => {
  const h = authHarness();
  const first = await h.login();
  const second = await h.login();
  expect((await h.call(ROUTES.auth.me, { cookie: first.cookie })).status).toBe(200);
  const original = h.users.verify.bind(h.users);
  vi.spyOn(h.users, "verify").mockImplementation(async (username, password) =>
    username === "alice" && password === "alice-rotated"
      ? original(username, "alice-pass")
      : original(username, password),
  );
  const rotated = await h.call(ROUTES.auth.login, {
    method: "POST",
    body: { credential: { username: "alice", password: "alice-rotated" } },
  });
  expect(rotated.status).toBe(200);
  const cookie = cookieFrom(rotated);
  expect((await h.call(ROUTES.auth.me, { cookie })).status).toBe(200);
  expect((await h.call(ROUTES.auth.me, { cookie: first.cookie })).status).toBe(401);
  expect((await h.call(ROUTES.auth.me, { cookie: second.cookie })).status).toBe(401);
  const again = await h.call(ROUTES.auth.login, {
    method: "POST",
    body: { credential: { username: "alice", password: "alice-rotated" } },
  });
  expect(again.status).toBe(200);
  expect((await h.call(ROUTES.auth.me, { cookie })).status).toBe(200);
  expect((await h.call(ROUTES.auth.me, { cookie: cookieFrom(again) })).status).toBe(200);
  // Another user's sessions are never touched by alice's rotation.
  const bob = await h.login("bob");
  await h.call(ROUTES.auth.login, {
    method: "POST",
    body: { credential: { username: "alice", password: "alice-pass" } },
  });
  expect((await h.call(ROUTES.auth.me, { cookie: bob.cookie })).status).toBe(200);
  expect((await h.call(ROUTES.auth.me, { cookie })).status).toBe(401);
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
          body: { credential: { username, password: "wrong" } },
        })
      ).status,
    ).toBe(401);
  // ...block a sixth, never-tried username from that address, even with the right password.
  const blocked = await h.call(ROUTES.auth.login, {
    method: "POST",
    headers: from("203.0.113.7"),
    body: { credential: { username: "frank", password: "frank-pass" } },
  });
  expect(blocked.status).toBe(429);
  // Another address is unaffected.
  expect(
    (
      await h.call(ROUTES.auth.login, {
        method: "POST",
        headers: from("203.0.113.8"),
        body: { credential: { username: "frank", password: "frank-pass" } },
      })
    ).status,
  ).toBe(200);
  // A success does not reset the address bucket: four failures plus one valid
  // login, then a further failure, still trips the block.
  for (let n = 0; n < 4; n++)
    await h.call(ROUTES.auth.login, {
      method: "POST",
      headers: from("203.0.113.9"),
      body: { credential: { username: `user${n}`, password: "wrong" } },
    });
  expect(
    (
      await h.call(ROUTES.auth.login, {
        method: "POST",
        headers: from("203.0.113.9"),
        body: { credential: { username: "alice", password: "alice-pass" } },
      })
    ).status,
  ).toBe(200);
  await h.call(ROUTES.auth.login, {
    method: "POST",
    headers: from("203.0.113.9"),
    body: { credential: { username: "user5", password: "wrong" } },
  });
  expect(
    (
      await h.call(ROUTES.auth.login, {
        method: "POST",
        headers: from("203.0.113.9"),
        body: { credential: { username: "bob", password: "bob-pass" } },
      })
    ).status,
  ).toBe(429);
});
it("an undecryptable stored credential counts as replaced: the next login revokes older sessions", async () => {
  const h = authHarness();
  const stale = await h.login();
  await h.repos.credentials.put({
    identityId: stale.me.identity.id,
    ciphertext: new Uint8Array([1, 2, 3]),
    keyId: "master-v1",
  });
  const fresh = await h.login();
  expect((await h.call(ROUTES.auth.me, { cookie: fresh.cookie })).status).toBe(200);
  expect((await h.call(ROUTES.auth.me, { cookie: stale.cookie })).status).toBe(401);
});

it.each(["alice-pass", "alice-rotated"])(
  "handles a delayed verified login with %s after a password replacement",
  async (delayedPassword) => {
    const h = authHarness();
    const originalSession = await h.login();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = h.users.verify.bind(h.users);
    let hold = true;
    vi.spyOn(h.users, "verify").mockImplementation(async (username) => {
      const result = await original(username, "alice-pass");
      if (hold) {
        hold = false;
        entered();
        await gate;
      }
      return result;
    });
    const login = (password: string) =>
      h.call(ROUTES.auth.login, {
        method: "POST",
        body: { credential: { username: "alice", password } },
      });
    const delayed = login(delayedPassword);
    await started;
    const fresh = await login("alice-rotated");
    expect(fresh.status).toBe(200);
    release();
    const late = await delayed;
    expect(late.status).toBe(delayedPassword === "alice-pass" ? 401 : 200);
    expect((await h.call(ROUTES.auth.me, { cookie: cookieFrom(fresh) })).status).toBe(200);
    expect((await h.call(ROUTES.auth.me, { cookie: originalSession.cookie })).status).toBe(401);
    if (late.status === 200)
      expect((await h.call(ROUTES.auth.me, { cookie: cookieFrom(late) })).status).toBe(200);
    const stored = await h.repos.credentials.get(originalSession.me.identity.id);
    if (stored === null) throw new Error("missing credential");
    expect(
      JSON.parse(new TextDecoder().decode(open(h.master, stored.ciphertext, stored.identityId)))
        .password,
    ).toBe("alice-rotated");
  },
);

it("claims setup through auth, preserves existing losers and creates no new losing identity", async () => {
  const h = authHarness();
  const bob = await h.login("bob");
  const [provider] = await h.providers.list();
  if (provider === undefined) throw new Error("missing provider");
  const candidate = (username: string) =>
    h.auth.service.loginCandidate(
      {
        credential: { username, password: `${username}-pass` },
        ip: "127.0.0.1",
        userAgent: "test",
      },
      provider.id,
      "test.setup.owner",
    );
  const winner = await candidate("alice");
  await expect(candidate("bob")).rejects.toMatchObject({ kind: "conflict" });
  await expect(candidate("carol")).rejects.toMatchObject({ kind: "conflict" });
  expect((await h.call(ROUTES.auth.me, { cookie: bob.cookie })).status).toBe(200);
  expect((await h.repos.identities.listAll()).map((row) => row.externalUsername).sort()).toEqual([
    "alice",
    "bob",
  ]);
  const resumed = await candidate("alice");
  expect(resumed.me.account.id).toBe(winner.me.account.id);
});
