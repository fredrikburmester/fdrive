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
      body: {
        credential: { username: "bob", password: "bob-pass" },
        currentCredential: { password: "alice-pass" },
      },
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
    ).toEqual({ username: "bob", password: "bob-pass" });
    const own = await h.call(ROUTES.account.identities, {
      method: "POST",
      cookie,
      // The rotated session is now active as bob, so bob's password is the owner's.
      body: {
        credential: { username: "bob", password: "bob-pass" },
        currentCredential: { password: "bob-pass" },
      },
    });
    expect(own.status).toBe(200);
    expect(MeResponse.parse(await own.json()).identities).toHaveLength(2);
  });
  it("rejects a non-canonical provider ID before repository access", async () => {
    const h = accountsHarness();
    const alice = await h.login();
    const response = await h.call(ROUTES.account.identities, {
      method: "POST",
      cookie: alice.cookie,
      body: {
        providerId: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
        credential: { username: "bob", password: "bob-pass" },
        currentCredential: { password: "alice-pass" },
      },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { kind: "bad_request" } });
  });
  it("switches owned identities without rotation or expiry extension, and rejects foreign identity", async () => {
    const h = accountsHarness();
    const a = await h.login();
    const foreign = await h.login("carol");
    const linked = await h.call(ROUTES.account.identities, {
      method: "POST",
      cookie: a.cookie,
      body: {
        credential: { username: "bob", password: "bob-pass" },
        currentCredential: { password: "alice-pass" },
      },
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
          body: { currentCredential: { password: "alice-pass" } },
        })
      ).status,
    ).toBe(409);
    const linked = await h.call(ROUTES.account.identities, {
      method: "POST",
      cookie: a.cookie,
      body: {
        credential: { username: "bob", password: "bob-pass" },
        currentCredential: { password: "alice-pass" },
      },
    });
    const linkedMe = MeResponse.parse(await linked.json());
    const cookie = cookieFrom(linked);
    const b = linkedMe.activeIdentityId;
    const office = await officeHarness();

    const result = await h.call(`${ROUTES.account.identities}/${b}`, {
      method: "DELETE",
      cookie,
      body: { currentCredential: { password: "bob-pass" } },
    });
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
      body: {
        credential: { username: "bob", password: "bob-pass" },
        currentCredential: { password: "alice-pass" },
      },
    });
    const me = MeResponse.parse(await linked.json());
    const result = await h.call(`${ROUTES.account.identities}/${a.me.activeIdentityId}`, {
      method: "DELETE",
      cookie: cookieFrom(linked),
      body: { currentCredential: { password: "bob-pass" } },
    });
    expect(MeResponse.parse(await result.json()).activeIdentityId).toBe(me.activeIdentityId);
  });
  it("rejects bad inputs, missing cookies, bearer auth and mismatched cookie identity", async () => {
    const h = accountsHarness();
    const a = await h.login();
    const b = await h.login("bob");
    for (const body of [
      {
        credential: { username: "bob", password: "" },
        currentCredential: { password: "alice-pass" },
      },
      {
        credential: { username: "bob", password: "bob-pass" },
        currentCredential: { password: "" },
      },
      {
        credential: { username: "bob", password: "bob-pass" },
        accountId: b.me.account.id,
        currentCredential: { password: "alice-pass" },
      },
      {
        credential: { username: "bob", password: "x".repeat(4097) },
        currentCredential: { password: "alice-pass" },
      },
    ])
      expect(
        (await h.call(ROUTES.account.identities, { method: "POST", cookie: a.cookie, body }))
          .status,
      ).toBe(400);
    expect(
      (
        await h.call(ROUTES.account.identities, {
          method: "POST",
          body: {
            credential: { username: "bob", password: "bob-pass" },
            currentCredential: { password: "alice-pass" },
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await h.call(ROUTES.account.identities, {
          method: "POST",
          cookie: a.cookie,
          headers: { authorization: "Bearer ignored" },
          body: { credential: { username: "bob", password: "bob-pass" } },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.call(ROUTES.account.identities, {
          method: "POST",
          cookie: a.cookie,
          headers: { "x-identity-id": b.me.activeIdentityId },
          body: { credential: { username: "bob", password: "bob-pass" } },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.call(`${ROUTES.account.identities}/bad`, {
          method: "DELETE",
          cookie: a.cookie,
          body: { currentCredential: { password: "alice-pass" } },
        })
      ).status,
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
            body: {
              credential: { username: "bob", password: "wrong" },
              currentCredential: { password: "alice-pass" },
            },
          })
        ).status,
      ).toBe(401);
    expect(link).not.toHaveBeenCalled();
    expect(
      (
        await h.call(ROUTES.auth.login, {
          method: "POST",
          body: { credential: { username: "bob", password: "bob-pass" } },
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
            body: {
              credential: { username: "bob", password: "bob-pass" },
              currentCredential: { password: "alice-pass" },
            },
          })
        ).status,
      ).toBe(status);
    }
    link.mockRejectedValueOnce(new Error("SQL secret bind value"));
    const response = await h.call(ROUTES.account.identities, {
      method: "POST",
      cookie: a.cookie,
      body: {
        credential: { username: "bob", password: "bob-pass" },
        currentCredential: { password: "alice-pass" },
      },
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
          credential: { username: "bob", password: "bob-pass", otp: "wrong" },
          currentCredential: { password: "alice-pass" },
        },
      })
    ).status,
  ).toBe(401);
  expect(await h.repos.identities.listByAccount(a.me.account.id)).toHaveLength(1);
  const linked = await h.call(ROUTES.account.identities, {
    method: "POST",
    cookie: a.cookie,
    body: {
      credential: { username: "bob", password: "bob-pass", otp: "123456" },
      currentCredential: { password: "alice-pass" },
    },
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
    body: { credential: { username: "bob", password: "bob-pass" } },
  });
  expect(missing.status).toBe(400);
  const wrong = await h.call(ROUTES.account.identities, {
    method: "POST",
    cookie: a.cookie,
    body: {
      credential: { username: "bob", password: "bob-pass" },
      currentCredential: { password: "not-alice" },
    },
  });
  expect(wrong.status).toBe(401);
  expect(await wrong.text()).toContain("current password is incorrect");
  // The new login's own password must never stand in for the owner's.
  const swapped = await h.call(ROUTES.account.identities, {
    method: "POST",
    cookie: a.cookie,
    body: {
      credential: { username: "bob", password: "bob-pass" },
      currentCredential: { password: "bob-pass" },
    },
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
      body: {
        credential: { username: "bob", password: "bob-pass" },
        currentCredential: { password: "guess" },
      },
    });
  expect(
    (
      await h.call(ROUTES.auth.login, {
        method: "POST",
        body: { credential: { username: "alice", password: "alice-pass" } },
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
it("unlinking revokes other sessions using that login and keeps sessions on other logins", async () => {
  const h = accountsHarness();
  const a = await h.login();
  const linked = await h.call(ROUTES.account.identities, {
    method: "POST",
    cookie: a.cookie,
    body: {
      credential: { username: "bob", password: "bob-pass" },
      currentCredential: { password: "alice-pass" },
    },
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
    body: { currentCredential: { password: "bob-pass" } },
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
it("re-authentication refuses a vanished active login and passes upstream outages through", async () => {
  const h = accountsHarness();
  const a = await h.login();
  const body = {
    credential: { username: "bob", password: "bob-pass" },
    currentCredential: { password: "alice-pass" },
  };
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

it("unlinking re-authenticates the signed-in login: missing or wrong owner password never unlinks", async () => {
  const h = accountsHarness();
  const a = await h.login();
  const linked = await h.call(ROUTES.account.identities, {
    method: "POST",
    cookie: a.cookie,
    body: {
      credential: { username: "bob", password: "bob-pass" },
      currentCredential: { password: "alice-pass" },
    },
  });
  const cookie = cookieFrom(linked);
  const target = `${ROUTES.account.identities}/${a.me.activeIdentityId}`;
  const unlink = vi.spyOn(h.links, "unlink");
  expect((await h.call(target, { method: "DELETE", cookie })).status).toBe(400);
  // The session is active as bob now, so alice's password is not the owner's.
  for (const currentPassword of ["not-bob", "alice-pass"]) {
    const wrong = await h.call(target, {
      method: "DELETE",
      cookie,
      body: { currentCredential: { password: currentPassword } },
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("current password is incorrect");
  }
  expect(unlink).not.toHaveBeenCalled();
  expect(await h.repos.identities.listByAccount(a.me.account.id)).toHaveLength(2);
  expect((await h.call(ROUTES.auth.me, { cookie })).status).toBe(200);
  const ok = await h.call(target, {
    method: "DELETE",
    cookie,
    body: { currentCredential: { password: "bob-pass" } },
  });
  expect(ok.status).toBe(200);
  expect(await h.repos.identities.listByAccount(a.me.account.id)).toHaveLength(1);
});

it.each(["alice-pass", "alice-rotated"])(
  "handles a delayed verified login with %s after a password replacement",
  async (delayedPassword) => {
    const h = accountsHarness();
    const originalSession = await h.login();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = h.client.login.bind(h.client);
    let hold = true;
    vi.spyOn(h.client, "login").mockImplementation(async (input) => {
      const result = await original({ ...input, password: "alice-pass" });
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
    const stored = await h.repos.credentials.get(originalSession.me.activeIdentityId);
    if (stored === null) throw new Error("missing credential");
    expect(
      JSON.parse(new TextDecoder().decode(open(h.master, stored.ciphertext, stored.identityId)))
        .password,
    ).toBe("alice-rotated");
  },
);

it("claims setup through auth, preserves existing losers and creates no new losing identity", async () => {
  const h = accountsHarness();
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
