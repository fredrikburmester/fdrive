import { randomUUID } from "node:crypto";
import { ROUTES } from "@fdrive/contracts";
import { SftpgoError } from "@fdrive/sftpgo";
import { createMemoryStorage } from "@fdrive/testkit";
import { expect, it, vi } from "vitest";
import { createLoginLimiter } from "../auth/login-limiter.js";
import { hashSessionId } from "../auth/sessions.js";
import { ApiHttpError } from "../errors.js";
import { verifyCredentials } from "./credentials.ts";
import { accountRepositoryCall } from "./errors.ts";
import { liveAccountSession } from "./service.ts";
import { accountsHarness, HARNESS_BASE_URL } from "./test-fixtures/index.ts";

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
  const login = h.client.login.bind(h.client);
  vi.spyOn(h.client, "login").mockImplementation(async (credentials) => {
    const result = await login(credentials);
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
    type: "sftpgo",
    baseUrl: "https://other.test:8443",
  });
  await h.repos.identities.create({
    accountId: input.principal.accountId,
    providerId: provider.id,
    externalUsername: "other",
  });
  const me = await h.auth.service.me(input.principal.accountId, input.principal.identityId);
  expect(me.identities.map((identity) => identity.providerLabel).sort()).toEqual([
    "other.test:8443",
    "storage.test",
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
  const realLogin = h.client.login.bind(h.client);
  vi.spyOn(h.client, "login").mockImplementationOnce(async (body) => {
    await h.repos.providers.update(seededRow.id, { baseUrl: "http://moved.test" });
    return realLogin(body);
  });
  await expect(verifyCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "unauthorized",
    message: "storage provider changed; sign in again",
  });
  expect(await h.repos.identities.listAll()).toEqual([]);
  await h.repos.providers.update(seededRow.id, { baseUrl: HARNESS_BASE_URL });
  vi.spyOn(h.limiter, "check").mockReturnValueOnce({ allowed: false });
  await expect(verifyCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "rate_limited",
    details: { retryAfterMs: 0 },
  });
  vi.spyOn(h.client, "login").mockRejectedValueOnce(
    new SftpgoError("secret", "forbidden", 403, null),
  );
  await expect(verifyCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "forbidden",
    message: "forbidden",
  });
  vi.spyOn(h.client, "login").mockRejectedValueOnce(new Error("private upstream"));
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
  await h.repos.providers.ensure({ type: "sftpgo", baseUrl: "http://second.test" });
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
  const h = accountsHarness();
  await h.seeded;
  vi.spyOn(h.tokenSource, "prime").mockRejectedValueOnce(new Error("token store down"));
  const remove = vi.spyOn(h.repos.sessions, "delete");
  const res = await h.call(ROUTES.auth.login, {
    method: "POST",
    body: { credential: { username: "alice", password: "alice-pass" } },
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
