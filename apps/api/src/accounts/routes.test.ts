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
      body: { username: "bob", password: "bob-pass" },
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
      body: { username: "bob", password: "bob-pass" },
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
      body: { username: "bob", password: "bob-pass" },
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
      body: { username: "bob", password: "bob-pass" },
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
      body: { username: "bob", password: "bob-pass" },
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
      { username: "bob", password: "" },
      { username: "bob", password: "bob-pass", accountId: b.me.account.id },
      { username: "bob", password: "x".repeat(4097) },
    ])
      expect(
        (await h.call(ROUTES.account.identities, { method: "POST", cookie: a.cookie, body }))
          .status,
      ).toBe(400);
    expect(
      (
        await h.call(ROUTES.account.identities, {
          method: "POST",
          body: { username: "bob", password: "bob-pass" },
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
            body: { username: "bob", password: "wrong" },
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
            body: { username: "bob", password: "bob-pass" },
          })
        ).status,
      ).toBe(status);
    }
    link.mockRejectedValueOnce(new Error("SQL secret bind value"));
    const response = await h.call(ROUTES.account.identities, {
      method: "POST",
      cookie: a.cookie,
      body: { username: "bob", password: "bob-pass" },
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
        body: { username: "bob", password: "bob-pass", otp: "wrong" },
      })
    ).status,
  ).toBe(401);
  expect(await h.repos.identities.listByAccount(a.me.account.id)).toHaveLength(1);
  const linked = await h.call(ROUTES.account.identities, {
    method: "POST",
    cookie: a.cookie,
    body: { username: "bob", password: "bob-pass", otp: "123456" },
  });
  expect(linked.status).toBe(200);
  expect(login).toHaveBeenLastCalledWith({ username: "bob", password: "bob-pass", otp: "123456" });
});
