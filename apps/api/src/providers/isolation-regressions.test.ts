import { expect, it } from "vitest";
import { accountsHarness } from "../accounts/test-fixtures/index.ts";
import { createApp } from "../app.ts";
import { createAuthModule } from "../auth/index.ts";
import { createScopeResolver } from "../scoping/resolver.ts";
import { fakeStorageProvider, fileEntry } from "../scoping/test-fixtures/index.ts";
import { createSetupClaimStore } from "../setup/claim.ts";
import { createSetupService } from "../setup/service.ts";

it("does not grant an env administrator username on a second provider", async () => {
  const h = accountsHarness();
  await h.seeded;
  const second = await h.providers.create({
    type: "sftpgo",
    label: "Second",
    baseUrl: "http://second.test",
  });
  const auth = createAuthModule({
    ...h.deps,
    providers: h.providers,
    tokenSource: h.tokenSource,
    identityLinks: h.links,
    config: h.config,
    storageFactory: h.storageFactory,
    adminUsernames: ["alice"],
  });
  const result = await auth.service.login({
    providerId: second.id,
    credential: { username: "alice", password: "alice-pass" },
    ip: "review",
    userAgent: null,
  });
  expect((await h.repos.accounts.get(result.me.account.id))?.isAdmin).toBe(false);
  expect(result.me.isAdmin).toBe(false);
  const original = await h.seeded;
  const admin = await auth.service.login({
    providerId: original.id,
    credential: { username: "alice", password: "alice-pass" },
    ip: "review",
    userAgent: null,
  });
  expect(admin.me.isAdmin).toBe(true);
});

it("keeps env setup complete and sessions usable after disabling its last provider", async () => {
  const h = accountsHarness();
  const row = await h.seeded;
  const login = await h.login();
  const setup = createSetupService({
    providers: h.providers,
    authService: h.auth.service,
    accounts: h.repos.accounts,
    claims: createSetupClaimStore(h.repos.settings),
    hasEnvUrl: true,
  });
  const app = createApp({
    config: h.config,
    clock: h.clock,
    logger: h.logger,
    version: "review",
    startedAt: h.clock(),
    principalResolver: h.auth.principalResolver,
    connectionStatus: async () => ({ required: (await setup.status()).required, providers: [] }),
    registerRoutes: (groups) => h.auth.registerRoutes(groups),
  });
  expect((await app.request("/api/v1/auth/me", { headers: { cookie: login.cookie } })).status).toBe(
    200,
  );
  await h.providers.update(row.id, { enabled: false });
  const response = await app.request("/api/v1/auth/me", { headers: { cookie: login.cookie } });
  expect(response.status).toBe(200);
  expect((await setup.status()).required).toBe(false);
  await h.providers.update(row.id, { enabled: true });
  expect((await app.request("/api/v1/auth/me", { headers: { cookie: login.cookie } })).status).toBe(
    200,
  );
});

it("does not map a remote provider to the primary indexed scope by default", async () => {
  const h = accountsHarness();
  await h.seeded;
  const second = await h.providers.create({
    type: "sftpgo",
    label: "Remote",
    baseUrl: "http://remote.test",
  });
  const account = await h.repos.accounts.create({ displayName: "Remote Alice" });
  const identity = await h.repos.identities.create({
    accountId: account.id,
    providerId: second.id,
    externalUsername: "alice",
  });
  const resolver = createScopeResolver({
    providers: h.repos.providers,
    clock: h.clock,
    overrides: { get: async () => null, set: async () => {}, reset: async () => {} },
    mountMappings: { get: async () => [], set: async () => {} },
    indexRoots: [{ name: "sftpgo", sftpgoPath: "/primary-server-files", indexerPath: "/data" }],
    storageForIdentity: async () =>
      fakeStorageProvider({ list: async () => [fileEntry("report.txt")] }),
    indexer: {
      directory: async () => ({
        ok: true,
        data: { items: [{ name: "report.txt", kind: "file" }], overflow: false },
      }),
    },
  });
  expect(second.config).toEqual({});
  expect(await resolver.verifiedIndexScopes(identity)).toMatchObject({
    available: false,
    reason: "no_roots",
  });
});

it("refuses an endpoint update when the first identity appeared after the initial count", async () => {
  const h = accountsHarness();
  await h.seeded;
  const second = await h.providers.create({
    type: "sftpgo",
    label: "Second",
    baseUrl: "http://original.test",
  });
  const count = h.repos.identities.countByProvider;
  let reached!: () => void;
  const atCount = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let resume!: () => void;
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  h.repos.identities.countByProvider = async (id) => {
    const result = await count(id);
    reached();
    await barrier;
    return result;
  };
  const update = h.providers.update(second.id, { baseUrl: "http://replacement.test" });
  await atCount;
  const login = await h.auth.service.login({
    providerId: second.id,
    credential: { username: "alice", password: "alice-pass" },
    ip: "review",
    userAgent: null,
  });
  resume();
  await expect(update).rejects.toMatchObject({ kind: "conflict" });
  expect((await h.providers.forIdentity(login.me.activeIdentityId)).provider.baseUrl).toBe(
    "http://original.test",
  );
  expect(await h.tokenSource.credential(login.me.activeIdentityId)).toEqual({
    username: "alice",
    password: "alice-pass",
  });
});
