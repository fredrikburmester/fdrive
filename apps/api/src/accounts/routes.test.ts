import { MeResponse, ROUTES } from "@fdrive/contracts";
import { IdentityLinksError } from "@fdrive/db";
import { SftpgoError } from "@fdrive/sftpgo";
import { describe, expect, it, vi } from "vitest";
import { officeHarness } from "../../test/fixtures/office/harness.ts";
import { open } from "../auth/crypto.js";
import { hashSessionId } from "../auth/sessions.js";
import { officeActor } from "../office/auth.ts";
import { accountsHarness, cookieFrom } from "./test-fixtures/index.ts";

const hashCookie = (cookie: string) => hashSessionId(cookie.slice("fdrive_session=".length));
describe("identity account routes", () => {
  it("links verified credentials, rotates the session and preserves its expiry and metadata", async () => {
    const h = accountsHarness();
    const alice = await h.login();
    const bob = await h.login("bob");
    const previous = await h.repos.sessions.getByIdHash(hashCookie(alice.cookie), h.clock());
    await h.repos.favorites.add(bob.me.activeIdentityId, "/report.txt", "file");
    await h.repos.apiTokens.create({
      accountId: bob.me.account.id,
      identityId: bob.me.activeIdentityId,
      name: "old",
      tokenHash: "old-api-hash",
      expiresAt: null,
    });
    h.now.value = new Date(h.clock().getTime() + 600000);
    const response = await h.call(ROUTES.account.identities, {
      method: "POST",
      cookie: alice.cookie,
      body: { username: "bob", password: "bob-pass", currentPassword: "alice-pass" },
    });
    expect(response.status).toBe(200);
    const me = MeResponse.parse(await response.json());
    const cookie = cookieFrom(response);
    expect(me.account.id).toBe(alice.me.account.id);
    expect(me.isAdmin).toBe(false);
    expect(me.activeIdentityId).toBe(bob.me.activeIdentityId);
    expect(me.identities).toHaveLength(2);
    expect(me.identities.every((identity) => identity.providerLabel === "storage.test")).toBe(true);
    expect(cookie).not.toBe(alice.cookie);
    const rotated = await h.repos.sessions.getByIdHash(hashCookie(cookie), h.clock());
    expect(rotated?.expiresAt).toEqual(previous?.expiresAt);
    expect(rotated?.ip).toBe(previous?.ip);
    expect(rotated?.userAgent).toBe(previous?.userAgent);
    expect(await h.repos.sessions.getByIdHash(hashCookie(alice.cookie), h.clock())).toBeNull();
    expect((await h.call(ROUTES.auth.me, { cookie: bob.cookie })).status).toBe(401);
    expect(await h.repos.apiTokens.findByHash("old-api-hash")).toBeNull();
    expect(await h.repos.favorites.list(bob.me.activeIdentityId)).toHaveLength(1);
    const stored = await h.repos.credentials.get(bob.me.activeIdentityId);
    expect(stored).not.toBeNull();
    if (!stored) throw new Error("Missing credential");
    expect(
      JSON.parse(
        new TextDecoder().decode(open(h.master, stored.ciphertext, bob.me.activeIdentityId)),
      ),
    ).toEqual({ password: "bob-pass" });
    const own = await h.call(ROUTES.account.identities, {
      method: "POST",
      cookie,
      // The rotated session is now active as bob, so bob's password is the owner's.
      body: { username: "bob", password: "bob-pass", currentPassword: "bob-pass" },
    });
    expect(own.status).toBe(200);
    expect(MeResponse.parse(await own.json()).identities).toHaveLength(2);
  });
  it("switches owned identities without rotation or expiry extension, and rejects foreign identity", async () => {
    const h = accountsHarness();
    const a = await h.login();
    const foreign = await h.login("carol");
    const linked = await h.call(ROUTES.account.identities, {
      method: "POST",
      cookie: a.cookie,
      body: { username: "bob", password: "bob-pass", currentPassword: "alice-pass" },
    });
    const cookie = cookieFrom(linked);
    const before = await h.repos.sessions.getByIdHash(hashCookie(cookie), h.clock());
    h.now.value = new Date(h.clock().getTime() + 600000);
    const switched = await h.call(ROUTES.account.activeIdentity, {
      method: "POST",
      cookie,
      body: { identityId: a.me.activeIdentityId },
    });
    expect(switched.status).toBe(200);
    expect(switched.headers.get("set-cookie")).toBeNull();
    expect(MeResponse.parse(await switched.json()).activeIdentityId).toBe(a.me.activeIdentityId);
    expect((await h.repos.sessions.getByIdHash(hashCookie(cookie), h.clock()))?.expiresAt).toEqual(
      before?.expiresAt,
    );
    expect(
      (
        await h.call(ROUTES.account.activeIdentity, {
          method: "POST",
          cookie,
          body: { identityId: foreign.me.activeIdentityId },
        })
      ).status,
    ).toBe(403);
  });
  it("unlinks without deleting storage, rotates and selects a remaining identity", async () => {
    const h = accountsHarness();
    const a = await h.login();
    expect(
      (
        await h.call(`${ROUTES.account.identities}/${a.me.activeIdentityId}`, {
          method: "DELETE",
          cookie: a.cookie,
        })
      ).status,
    ).toBe(409);
    const linked = await h.call(ROUTES.account.identities, {
      method: "POST",
      cookie: a.cookie,
      body: { username: "bob", password: "bob-pass", currentPassword: "alice-pass" },
    });
    const linkedMe = MeResponse.parse(await linked.json());
    const cookie = cookieFrom(linked);
    const b = linkedMe.activeIdentityId;
    const office = await officeHarness();

    const result = await h.call(`${ROUTES.account.identities}/${b}`, { method: "DELETE", cookie });
    expect(result.status).toBe(200);
    expect(MeResponse.parse(await result.json()).activeIdentityId).toBe(a.me.activeIdentityId);
    expect(await h.repos.sessions.getByIdHash(hashCookie(cookie), h.clock())).toBeNull();
    const detached = await h.repos.identities.get(b);
    expect(detached?.accountId).not.toBe(a.me.account.id);
    expect((await h.repos.accounts.get(detached?.accountId ?? ""))?.isAdmin).toBe(false);
    expect((await (await h.storageFactory(b)).statFile("/report.txt")).size).toBeGreaterThan(0);
    await expect(
      officeActor({ ...office.deps, repos: h.repos, clock: h.clock }, hashCookie(cookie), b),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      officeActor(
        { ...office.deps, repos: h.repos, clock: h.clock },
        hashCookie(cookieFrom(result)),
        b,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("preserves active identity when unlinking another linked identity", async () => {
    const h = accountsHarness();
    const a = await h.login();
    const linked = await h.call(ROUTES.account.identities, {
      method: "POST",
      cookie: a.cookie,
      body: { username: "bob", password: "bob-pass", currentPassword: "alice-pass" },
    });
    const me = MeResponse.parse(await linked.json());
    const result = await h.call(`${ROUTES.account.identities}/${a.me.activeIdentityId}`, {
      method: "DELETE",
      cookie: cookieFrom(linked),
    });
    expect(MeResponse.parse(await result.json()).activeIdentityId).toBe(me.activeIdentityId);
  });
  it("rejects bad inputs, missing cookies, bearer auth and mismatched cookie identity", async () => {
    const h = accountsHarness();
    const a = await h.login();
    const b = await h.login("bob");
    for (const body of [
      { username: "bob", password: "", currentPassword: "alice-pass" },
      { username: "bob", password: "bob-pass", currentPassword: "" },
      {
        username: "bob",
        password: "bob-pass",
        accountId: b.me.account.id,
        currentPassword: "alice-pass",
      },
      { username: "bob", password: "x".repeat(4097), currentPassword: "alice-pass" },
    ])
      expect(
        (await h.call(ROUTES.account.identities, { method: "POST", cookie: a.cookie, body }))
          .status,
      ).toBe(400);
    expect(
      (
        await h.call(ROUTES.account.identities, {
          method: "POST",
          body: { username: "bob", password: "bob-pass", currentPassword: "alice-pass" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await h.call(ROUTES.account.identities, {
          method: "POST",
          cookie: a.cookie,
          headers: { authorization: "Bearer ignored" },
          body: { username: "bob", password: "bob-pass" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.call(ROUTES.account.identities, {
          method: "POST",
          cookie: a.cookie,
          headers: { "x-identity-id": b.me.activeIdentityId },
          body: { username: "bob", password: "bob-pass" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await h.call(`${ROUTES.account.identities}/bad`, { method: "DELETE", cookie: a.cookie }))
        .status,
    ).toBe(400);
    expect(
      (
        await h.call(ROUTES.account.activeIdentity, {
          method: "POST",
          cookie: a.cookie,
          body: { identityId: "bad" },
        })
      ).status,
    ).toBe(400);
    expect((await h.call(ROUTES.account.search, { cookie: a.cookie })).status).toBe(400);
    expect(
      (
        await h.call(`${ROUTES.account.favorites}?identity=${a.me.activeIdentityId}`, {
          cookie: a.cookie,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.call(`${ROUTES.account.search}?q=a&identity=${a.me.activeIdentityId}`, {
          cookie: a.cookie,
        })
      ).status,
    ).toBe(400);
  });
  it("failed credential verification shares login limiter and never links", async () => {
    const h = accountsHarness();
    const a = await h.login();
    const link = vi.spyOn(h.links, "linkVerified");
    for (let n = 0; n < 5; n++)
      expect(
        (
          await h.call(ROUTES.account.identities, {
            method: "POST",
            cookie: a.cookie,
            body: { username: "bob", password: "wrong", currentPassword: "alice-pass" },
          })
        ).status,
      ).toBe(401);
    expect(link).not.toHaveBeenCalled();
    expect(
      (
        await h.call(ROUTES.auth.login, {
          method: "POST",
          body: { username: "bob", password: "bob-pass" },
        })
      ).status,
    ).toBe(429);
  });
  it("maps typed repository errors and conceals arbitrary SQL errors", async () => {
    const h = accountsHarness();
    const a = await h.login();
    const link = vi.spyOn(h.links, "linkVerified");
    for (const [code, status] of [
      ["missing_account", 401],
      ["missing_provider", 404],
      ["missing_identity", 404],
      ["forbidden", 403],
      ["last_identity", 409],
      ["invalid_session", 401],
    ] as const) {
      link.mockRejectedValueOnce(new IdentityLinksError(code));
      expect(
        (
          await h.call(ROUTES.account.identities, {
            method: "POST",
            cookie: a.cookie,
            body: { username: "bob", password: "bob-pass", currentPassword: "alice-pass" },
          })
        ).status,
      ).toBe(status);
    }
    link.mockRejectedValueOnce(new Error("SQL secret bind value"));
    const response = await h.call(ROUTES.account.identities, {
      method: "POST",
      cookie: a.cookie,
      body: { username: "bob", password: "bob-pass", currentPassword: "alice-pass" },
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("SQL secret");
    expect(h.logger.error).not.toHaveBeenCalled();
  });
});
it("passes optional TOTP through link verification and never mutates for invalid codes", async () => {
  const h = accountsHarness();
  const a = await h.login();
  const original = h.client.login.bind(h.client);
  const login = vi.spyOn(h.client, "login").mockImplementation(async (input) => {
    if (input.username === "bob" && input.otp !== "123456")
      throw new SftpgoError("bad OTP", "unauthorized", 401, "invalid OTP");
    return original(input);
  });
  expect(
    (
      await h.call(ROUTES.account.identities, {
        method: "POST",
        cookie: a.cookie,
        body: {
          username: "bob",
          password: "bob-pass",
          otp: "wrong",
          currentPassword: "alice-pass",
        },
      })
    ).status,
  ).toBe(401);
  expect(await h.repos.identities.listByAccount(a.me.account.id)).toHaveLength(1);
  const linked = await h.call(ROUTES.account.identities, {
    method: "POST",
    cookie: a.cookie,
    body: { username: "bob", password: "bob-pass", otp: "123456", currentPassword: "alice-pass" },
  });
  expect(linked.status).toBe(200);
  expect(login).toHaveBeenLastCalledWith({ username: "bob", password: "bob-pass", otp: "123456" });
  expect(login).toHaveBeenCalledWith({ username: "alice", password: "alice-pass" });
});
it("linking re-authenticates the signed-in login: missing or wrong owner password never links", async () => {
  const h = accountsHarness();
  const a = await h.login();
  const link = vi.spyOn(h.links, "linkVerified");
  const missing = await h.call(ROUTES.account.identities, {
    method: "POST",
    cookie: a.cookie,
    body: { username: "bob", password: "bob-pass" },
  });
  expect(missing.status).toBe(400);
  const wrong = await h.call(ROUTES.account.identities, {
    method: "POST",
    cookie: a.cookie,
    body: { username: "bob", password: "bob-pass", currentPassword: "not-alice" },
  });
  expect(wrong.status).toBe(401);
  expect(await wrong.text()).toContain("current password is incorrect");
  // The new login's own password must never stand in for the owner's.
  const swapped = await h.call(ROUTES.account.identities, {
    method: "POST",
    cookie: a.cookie,
    body: { username: "bob", password: "bob-pass", currentPassword: "bob-pass" },
  });
  expect(swapped.status).toBe(401);
  expect(link).not.toHaveBeenCalled();
  expect(await h.repos.identities.listByAccount(a.me.account.id)).toHaveLength(1);
  expect((await h.call(ROUTES.auth.me, { cookie: a.cookie })).status).toBe(200);
  // Guessing the owner's password through this route shares login's limiter.
  for (let n = 0; n < 3; n++)
    await h.call(ROUTES.account.identities, {
      method: "POST",
      cookie: a.cookie,
      body: { username: "bob", password: "bob-pass", currentPassword: "guess" },
    });
  expect(
    (
      await h.call(ROUTES.auth.login, {
        method: "POST",
        body: { username: "alice", password: "alice-pass" },
      })
    ).status,
  ).toBe(429);
});
it("login with a replaced SFTPGo password revokes the account's other sessions; same password keeps them", async () => {
  const h = accountsHarness();
  const first = await h.login();
  const second = await h.login();
  expect((await h.call(ROUTES.auth.me, { cookie: first.cookie })).status).toBe(200);
  const original = h.client.login.bind(h.client);
  vi.spyOn(h.client, "login").mockImplementation(async (input) =>
    input.username === "alice" && input.password === "alice-rotated"
      ? original({ ...input, password: "alice-pass" })
      : original(input),
  );
  const rotated = await h.call(ROUTES.auth.login, {
    method: "POST",
    body: { username: "alice", password: "alice-rotated" },
  });
  expect(rotated.status).toBe(200);
  const cookie = cookieFrom(rotated);
  expect((await h.call(ROUTES.auth.me, { cookie })).status).toBe(200);
  expect((await h.call(ROUTES.auth.me, { cookie: first.cookie })).status).toBe(401);
  expect((await h.call(ROUTES.auth.me, { cookie: second.cookie })).status).toBe(401);
  const again = await h.call(ROUTES.auth.login, {
    method: "POST",
    body: { username: "alice", password: "alice-rotated" },
  });
  expect(again.status).toBe(200);
  expect((await h.call(ROUTES.auth.me, { cookie })).status).toBe(200);
  expect((await h.call(ROUTES.auth.me, { cookie: cookieFrom(again) })).status).toBe(200);
  // Another user's sessions are never touched by alice's rotation.
  const bob = await h.login("bob");
  await h.call(ROUTES.auth.login, {
    method: "POST",
    body: { username: "alice", password: "alice-pass" },
  });
  expect((await h.call(ROUTES.auth.me, { cookie: bob.cookie })).status).toBe(200);
  expect((await h.call(ROUTES.auth.me, { cookie })).status).toBe(401);
});
it("unlinking revokes other sessions using that login and keeps sessions on other logins", async () => {
  const h = accountsHarness();
  const a = await h.login();
  const linked = await h.call(ROUTES.account.identities, {
    method: "POST",
    cookie: a.cookie,
    body: { username: "bob", password: "bob-pass", currentPassword: "alice-pass" },
  });
  const me = MeResponse.parse(await linked.json());
  const requester = cookieFrom(linked);
  // Two more sessions on the same account: one using bob (the login about to
  // be unlinked), one using alice.
  const viaBob = await h.login("bob");
  const viaAlice = await h.login();
  expect(viaBob.me.account.id).toBe(a.me.account.id);
  const result = await h.call(`${ROUTES.account.identities}/${me.activeIdentityId}`, {
    method: "DELETE",
    cookie: requester,
  });
  expect(result.status).toBe(200);
  expect((await h.call(ROUTES.auth.me, { cookie: cookieFrom(result) })).status).toBe(200);
  expect((await h.call(ROUTES.auth.me, { cookie: viaBob.cookie })).status).toBe(401);
  expect((await h.call(ROUTES.auth.me, { cookie: viaAlice.cookie })).status).toBe(200);
});
it("one address cannot spray passwords across usernames: a per-IP bucket blocks independently of the username", async () => {
  const h = accountsHarness();
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
it("re-authentication refuses a vanished active login and passes upstream outages through", async () => {
  const h = accountsHarness();
  const a = await h.login();
  const body = { username: "bob", password: "bob-pass", currentPassword: "alice-pass" };
  // Calling the service directly: the live-session check looks the identity up
  // once, then the re-authentication lookup sees it vanish.
  const input = {
    sessionId: a.cookie.slice("fdrive_session=".length),
    principal: {
      accountId: a.me.account.id,
      identityId: a.me.activeIdentityId,
      username: "alice",
      isAdmin: false,
      storage: await h.storageFactory(a.me.activeIdentityId),
    },
  };
  const active = await h.repos.identities.get(a.me.activeIdentityId);
  vi.spyOn(h.repos.identities, "get").mockResolvedValueOnce(active).mockResolvedValueOnce(null);
  await expect(h.service.link(input, { ...body, ip: "test" })).rejects.toMatchObject({
    kind: "unauthorized",
    message: "identity ownership changed; sign in again",
  });
  vi.spyOn(h.client, "login").mockRejectedValueOnce(new SftpgoError("down", "network", null, null));
  const outage = await h.call(ROUTES.account.identities, {
    method: "POST",
    cookie: a.cookie,
    body,
  });
  expect(outage.status).toBe(502);
  expect(await outage.text()).not.toContain("current password");
});
it("an undecryptable stored credential counts as replaced: the next login revokes older sessions", async () => {
  const h = accountsHarness();
  const stale = await h.login();
  await h.repos.credentials.put({
    identityId: stale.me.activeIdentityId,
    ciphertext: new Uint8Array([1, 2, 3]),
    keyId: "master-v1",
  });
  const fresh = await h.login();
  expect((await h.call(ROUTES.auth.me, { cookie: fresh.cookie })).status).toBe(200);
  expect((await h.call(ROUTES.auth.me, { cookie: stale.cookie })).status).toBe(401);
});
