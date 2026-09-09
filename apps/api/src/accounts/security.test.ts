import { randomUUID } from "node:crypto";
import { ROUTES } from "@fdrive/contracts";
import { SftpgoError } from "@fdrive/sftpgo";
import { expect, it, vi } from "vitest";
import { createMemoryStorage } from "../../test/fixtures/memory-storage.js";
import { hashSessionId } from "../auth/sessions.js";
import { ApiHttpError } from "../errors.js";
import { verifyAccountCredentials } from "./credentials.ts";
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
  const login = h.client.login.bind(h.client);
  vi.spyOn(h.client, "login").mockImplementation(async (credentials) => {
    const result = await login(credentials);
    await h.repos.sessions.delete(hashSessionId(input.sessionId));
    return result;
  });
  const link = vi.spyOn(h.links, "linkVerified");
  await expect(
    h.service.link(input, {
      username: "bob",
      password: "bob-pass",
      currentPassword: "alice-pass",
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
      username: "bob",
      password: "bob-pass",
      currentPassword: "alice-pass",
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
      body: { username: "alice", password: "alice-pass" },
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
it("fails closed on connection changes and maps verification errors without database mutation", async () => {
  const h = accountsHarness();
  const input = { username: "alice", password: "alice-pass", ip: "test" };
  const connection = await h.connectionStore.current();
  vi.spyOn(h.connectionStore, "current")
    .mockResolvedValueOnce(connection)
    .mockResolvedValueOnce(null);
  await expect(verifyAccountCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "unauthorized",
  });
  expect(await h.repos.identities.listAll()).toEqual([]);
  vi.spyOn(h.limiter, "check").mockReturnValueOnce({ allowed: false });
  await expect(verifyAccountCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "rate_limited",
    details: { retryAfterMs: 0 },
  });
  vi.spyOn(h.client, "login").mockRejectedValueOnce(
    new SftpgoError("secret", "forbidden", 403, null),
  );
  await expect(verifyAccountCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "forbidden",
    message: "forbidden",
  });
  vi.spyOn(h.client, "login").mockRejectedValueOnce(new Error("private upstream"));
  await expect(verifyAccountCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "upstream_unavailable",
  });
  const expected = new ApiHttpError("unauthorized", "safe");
  await expect(
    accountRepositoryCall(async () => {
      throw expected;
    }),
  ).rejects.toBe(expected);
});
