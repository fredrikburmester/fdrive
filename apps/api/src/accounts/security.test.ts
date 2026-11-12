import { randomUUID } from "node:crypto";
import { MeResponse, ROUTES } from "@fdrive/contracts";
import { StorageError } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/testkit";
import { expect, it, vi } from "vitest";
import { createLoginLimiter } from "../auth/login-limiter.js";
import { hashSessionId } from "../auth/sessions.js";
import { ApiHttpError } from "../errors.js";
import { fakeProviderModule, seedWebdavProvider } from "../providers/test-fixtures/index.ts";
import { verifyCredentials } from "./credentials.ts";
import { accountRepositoryCall } from "./errors.ts";
import { liveAccountSession } from "./service.ts";
import { accountsHarness } from "./test-fixtures/index.ts";

async function context(h: ReturnType<typeof accountsHarness>) {
  const a = await h.login();
  return {
    sessionId: a.cookie.slice("fdrive_session=".length),
    principal: {
      accountId: a.me.account.id,
      identityId: a.me.activeIdentityId,
      username: "alice",
      isAdmin: false,
      storage: await h.storageFactory(a.me.activeIdentityId),
    },
  };
}
it("requires a live cookie session with current account and identity ownership", async () => {
  const h = accountsHarness();
  const input = await context(h);
  await expect(
    liveAccountSession(h.deps, { ...input, sessionId: "missing" }),
  ).rejects.toMatchObject({ kind: "unauthorized" });
  await expect(
    liveAccountSession(h.deps, {
      ...input,
      principal: { ...input.principal, accountId: randomUUID() },
    }),
  ).rejects.toMatchObject({ kind: "unauthorized" });
  await expect(
    liveAccountSession(h.deps, {
      ...input,
      principal: { ...input.principal, identityId: randomUUID() },
    }),
  ).rejects.toMatchObject({ kind: "forbidden" });
  const session = await h.repos.sessions.getByIdHash(hashSessionId(input.sessionId), h.clock());
  if (!session) throw new Error("Missing session");
  vi.spyOn(h.repos.sessions, "getByIdHash").mockResolvedValue({
    ...session,
    activeIdentityId: null,
  });
  await expect(liveAccountSession(h.deps, input)).rejects.toMatchObject({ kind: "unauthorized" });
});
it("refuses cookie-free and cookie-account mismatches even when another resolver supplied a principal", async () => {
  const principal = {
    accountId: randomUUID(),
    identityId: randomUUID(),
    username: "fake",
    isAdmin: false,
    storage: createMemoryStorage(),
  };
  const h = accountsHarness({ principalResolver: async () => principal });
  expect((await h.call(ROUTES.account.favorites)).status).toBe(401);
  const a = await h.login();
  expect((await h.call(ROUTES.account.favorites, { cookie: a.cookie })).status).toBe(401);
});
it("rechecks session after upstream verification and revokes rotated sessions if final ownership validation fails", async () => {
  const h = accountsHarness();
  const input = await context(h);
  const verify = h.users.verify.bind(h.users);
  vi.spyOn(h.users, "verify").mockImplementation(async (username, password) => {
    const result = await verify(username, password);
    await h.repos.sessions.delete(hashSessionId(input.sessionId));
    return result;
  });
  const link = vi.spyOn(h.links, "linkVerified");
  await expect(
    h.service.link(input, {
      credential: { username: "bob", password: "bob-pass" },
      currentCredential: { password: "alice-pass" },
      ip: "test",
    }),
  ).rejects.toMatchObject({ kind: "unauthorized" });
  expect(link).not.toHaveBeenCalled();
  const other = accountsHarness();
  const own = await context(other);
  const rotate = vi.spyOn(other.links, "rotateSession");
  vi.spyOn(other.auth.service, "me").mockRejectedValue(
    new ApiHttpError("unauthorized", "ownership changed"),
  );
  await expect(
    other.service.link(own, {
      credential: { username: "bob", password: "bob-pass" },
      currentCredential: { password: "alice-pass" },
      ip: "test",
    }),
  ).rejects.toMatchObject({ kind: "unauthorized" });
  const rotated = await rotate.mock.results[0]?.value;
  if (!rotated) throw new Error("Missing rotation");
  expect(await other.repos.sessions.getByIdHash(rotated.idHash, other.clock())).toBeNull();
});
it("rejects login sessions raced by identity transfer, revocation, or final me lookup failure", async () => {
  for (const race of ["identity", "session", "me"] as const) {
    const h = accountsHarness();
    const original = h.links.loginVerified.bind(h.links);
    let hash = "";
    vi.spyOn(h.links, "loginVerified").mockImplementation(async (input) => {
      const result = await original(input);
      hash = result.session.idHash;
      if (race === "identity")
        vi.spyOn(h.repos.identities, "get").mockResolvedValueOnce({
          ...result.identity,
          accountId: randomUUID(),
        });
      if (race === "session") await h.repos.sessions.delete(hash);
      if (race === "me") vi.spyOn(h.repos.identities, "listByAccount").mockResolvedValueOnce([]);
      return result;
    });
    const response = await h.call(ROUTES.auth.login, {
      method: "POST",
      body: { credential: { username: "alice", password: "alice-pass" } },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await h.repos.sessions.getByIdHash(hash, h.clock())).toBeNull();
  }
});
it("labels each actual provider and validates final identity ownership before returning me", async () => {
  const h = accountsHarness();
  const input = await context(h);
  const provider = await h.repos.providers.ensure({
    type: "webdav",
    baseUrl: "https://other.test:8443",
  });
  await h.repos.identities.create({
    accountId: input.principal.accountId,
    providerId: provider.id,
    externalUsername: "other",
  });
  // A login on a storage type this build no longer has (an SFTPGo row from
  // before the local folder) is left out rather than failing the others.
  const retired = await h.repos.providers.ensure({ type: "sftpgo", baseUrl: "http://old.test" });
  await h.repos.identities.create({
    accountId: input.principal.accountId,
    providerId: retired.id,
    externalUsername: "alice",
  });
  const me = await h.auth.service.me(input.principal.accountId, input.principal.identityId);
  expect(me.identities.map((identity) => identity.providerLabel).sort()).toEqual([
    "Local folder",
    "other.test:8443",
  ]);
  vi.spyOn(h.repos.identities, "get").mockResolvedValueOnce(null);
  await expect(
    h.auth.service.me(input.principal.accountId, input.principal.identityId),
  ).rejects.toMatchObject({ kind: "unauthorized" });
  await expect(h.auth.service.me(randomUUID(), input.principal.identityId)).rejects.toMatchObject({
    kind: "internal",
  });
  vi.spyOn(h.repos.providers, "get").mockResolvedValue(null);
  await expect(
    h.auth.service.me(input.principal.accountId, input.principal.identityId),
  ).rejects.toMatchObject({ kind: "unauthorized" });
});
it("fails closed on provider changes and maps verification errors without database mutation", async () => {
  const h = accountsHarness();
  await h.seeded;
  const input = { credential: { username: "alice", password: "alice-pass" }, ip: "test" };
  const resolve = h.providers.resolve.bind(h.providers);
  vi.spyOn(h.providers, "resolve")
    .mockImplementationOnce(resolve)
    .mockRejectedValueOnce(
      new ApiHttpError("upstream_unavailable", "storage provider unavailable"),
    );
  await expect(verifyCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "unauthorized",
  });
  expect(await h.repos.identities.listAll()).toEqual([]);
  // A row re-addressed while the upstream login was in flight is a change
  // too: the password was verified by the old server, not the new one.
  const seededRow = await h.seeded;
  const realVerify = h.users.verify.bind(h.users);
  vi.spyOn(h.users, "verify").mockImplementationOnce(async (username, password) => {
    await h.repos.providers.update(seededRow.id, { baseUrl: "http://moved.test" });
    return realVerify(username, password);
  });
  await expect(verifyCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "unauthorized",
    message: "storage provider changed; sign in again",
  });
  expect(await h.repos.identities.listAll()).toEqual([]);
  await h.repos.providers.update(seededRow.id, { baseUrl: seededRow.baseUrl });
  vi.spyOn(h.limiter, "check").mockReturnValueOnce({ allowed: false });
  await expect(verifyCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "rate_limited",
    details: { retryAfterMs: 0 },
  });
  vi.spyOn(h.users, "verify").mockResolvedValueOnce({ result: "disabled" });
  await expect(verifyCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "forbidden",
    message: "forbidden",
  });
  vi.spyOn(h.users, "verify").mockRejectedValueOnce(new Error("private upstream"));
  await expect(verifyCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "upstream_unavailable",
  });
  const expected = new ApiHttpError("unauthorized", "safe");
  await expect(
    accountRepositoryCall(async () => {
      throw expected;
    }),
  ).rejects.toBe(expected);
});

it("requires a provider id once several providers are enabled", async () => {
  const h = accountsHarness();
  await h.seeded;
  await h.repos.providers.ensure({ type: "webdav", baseUrl: "http://second.test" });
  await expect(
    verifyCredentials(h.deps, {
      credential: { username: "alice", password: "alice-pass" },
      ip: "test",
    }),
  ).rejects.toMatchObject({ kind: "bad_request" });
  expect(
    (
      await h.call(ROUTES.auth.login, {
        method: "POST",
        body: { credential: { username: "alice", password: "alice-pass" } },
      })
    ).status,
  ).toBe(400);
});

it("drops the new session when priming the upstream token fails after login", async () => {
  // Storage that mints a token while it signs in, which login primes.
  const h = accountsHarness({
    modules: {
      webdav: fakeProviderModule({
        authenticate: async () => ({
          externalUsername: "alice",
          token: { token: "minted", expiresAt: new Date("2026-09-08T00:00:00Z") },
        }),
      }),
    },
  });
  await h.seeded;
  const row = await seedWebdavProvider(h.repos, "http://dav.test");
  vi.spyOn(h.tokenSource, "prime").mockRejectedValueOnce(new Error("token store down"));
  const remove = vi.spyOn(h.repos.sessions, "delete");
  const res = await h.call(ROUTES.auth.login, {
    method: "POST",
    body: { providerId: row.id, credential: { username: "alice", password: "alice-pass" } },
  });
  expect(res.status).toBe(500);
  expect(remove).toHaveBeenCalledTimes(1);
});

it("holds the per-address spray bound across a whole IPv6 /64, not per address", async () => {
  const h = accountsHarness();
  await h.seeded;
  // One machine routinely owns its entire /64, so keying the bound on the
  // address alone hands it a fresh allowance per attempt.
  const from = (host: number) => `2001:db8:1:2::${host.toString(16)}`;
  for (let host = 1; host <= 5; host += 1) {
    await expect(
      verifyCredentials(h.deps, {
        credential: { username: `user${host}`, password: "wrong" },
        ip: from(host),
      }),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  }

  // A sixth address in that /64 is the same caller, even with a valid password...
  await expect(
    verifyCredentials(h.deps, {
      credential: { username: "alice", password: "alice-pass" },
      ip: from(6),
    }),
  ).rejects.toMatchObject({ kind: "rate_limited" });
  // ...while a neighbouring /64 is a different one.
  await expect(
    verifyCredentials(h.deps, {
      credential: { username: "alice", password: "alice-pass" },
      ip: "2001:db8:1:3::1",
    }),
  ).resolves.toMatchObject({ externalUsername: "alice" });
});

it("bounds one address block's share of limiter capacity so another address still signs in", async () => {
  const h = accountsHarness();
  await h.seeded;
  // A capacity this small stands in for the 10 000 default: what matters is
  // that one caller's footprint is its block's budget rather than a slot per
  // address it can source from.
  const limiter = createLoginLimiter({ clock: h.clock, capacity: 8, maxKeysPerGroup: 2 });
  const deps = { ...h.deps, limiter };
  for (let host = 1; host <= 40; host += 1) {
    await verifyCredentials(deps, {
      credential: { username: `ghost-${host}`, password: "wrong" },
      ip: `2001:db8:1:2::${host.toString(16)}`,
    }).catch(() => undefined);
  }

  await expect(
    verifyCredentials(deps, {
      credential: { username: "bob", password: "bob-pass" },
      ip: "203.0.113.50",
    }),
  ).resolves.toMatchObject({ externalUsername: "bob" });
  // The attacker's own block is still throttled, and so is a username it
  // hammers from a single address.
  await expect(
    verifyCredentials(deps, {
      credential: { username: "alice", password: "alice-pass" },
      ip: "2001:db8:1:2::1",
    }),
  ).rejects.toMatchObject({ kind: "rate_limited" });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await expect(
      verifyCredentials(deps, {
        credential: { username: "carol", password: "wrong" },
        ip: "203.0.113.51",
      }),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  }
  await expect(
    verifyCredentials(deps, {
      credential: { username: "carol", password: "carol-pass" },
      ip: "203.0.113.51",
    }),
  ).rejects.toMatchObject({ kind: "rate_limited" });
});

it("primes the token storage minted while verifying a linked login", async () => {
  const h = accountsHarness({
    modules: {
      webdav: fakeProviderModule({
        authenticate: async (_instance, credential) => ({
          externalUsername: credential.username ?? "",
          token: { token: "from-link", expiresAt: new Date("2026-09-08T00:00:00Z") },
        }),
        mint: vi.fn(async () => {
          throw new Error("must not mint");
        }),
      }),
    },
  });
  const alice = await h.login();
  const row = await seedWebdavProvider(h.repos, "http://dav.test");
  const linked = await h.call(ROUTES.account.identities, {
    method: "POST",
    cookie: alice.cookie,
    body: {
      providerId: row.id,
      credential: { username: "alice", password: "alice-pass" },
      currentCredential: { password: "alice-pass" },
    },
  });
  expect(linked.status).toBe(200);
  const me = MeResponse.parse(await linked.json());
  expect(me.activeIdentityId).not.toBe(alice.me.activeIdentityId);
  expect(await h.tokenSource.get(me.activeIdentityId)).toBe("from-link");
});

it("passes the storage's own reason for refusing a user, and hides any other failure", async () => {
  let failure: unknown = new StorageError("forbidden", "refused", {
    details: { detail: "account locked by the server" },
  });
  const h = accountsHarness({
    modules: {
      webdav: fakeProviderModule({
        authenticate: async () => {
          throw failure;
        },
      }),
    },
  });
  await h.seeded;
  const row = await seedWebdavProvider(h.repos, "http://dav.test");
  const input = {
    providerId: row.id,
    credential: { username: "alice", password: "alice-pass" },
    ip: "test",
  };
  await expect(verifyCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "forbidden",
    message: "account locked by the server",
  });
  failure = new Error("socket hang up at 10.0.0.5");
  await expect(verifyCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "upstream_unavailable",
    message: "storage provider is unavailable",
  });
  expect(await h.repos.identities.listAll()).toEqual([]);
});
