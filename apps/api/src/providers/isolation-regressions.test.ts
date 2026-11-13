import { createMemoryRepos } from "@fdrive/db/testing";
import { expect, it } from "vitest";
import { accountsHarness } from "../accounts/test-fixtures/index.ts";
import { createApp } from "../app.ts";
import { createAuthModule } from "../auth/index.ts";
import { createScopeResolver } from "../scoping/resolver.ts";
import { createSetupService } from "../setup/service.ts";
import {
  fakeProviderModule,
  memoryProviderService,
  seedProviderRow,
} from "./test-fixtures/index.ts";

it("scopes env administrators to the storage the deployment pins", async () => {
  const h = accountsHarness();
  await h.seeded;
  // A second row alice can also sign in to, which the deployment does not pin.
  const second = await seedProviderRow(h.repos, "http://second.test", { label: "Second" });
  const auth = createAuthModule({
    ...h.deps,
    providers: h.providers,
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
    authService: h.auth.service,
    accounts: h.repos.accounts,
    identities: h.repos.identities,
    settings: h.repos.settings,
    local: {
      provider: async () => row,
      userCount: () => h.repos.localUsers.count(),
      users: { createOwner: async () => async () => {} },
    },
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
  await h.repos.providers.update(row.id, { enabled: false });
  const response = await app.request("/api/v1/auth/me", { headers: { cookie: login.cookie } });
  expect(response.status).toBe(200);
  expect((await setup.status()).required).toBe(false);
  await h.repos.providers.update(row.id, { enabled: true });
  expect((await app.request("/api/v1/auth/me", { headers: { cookie: login.cookie } })).status).toBe(
    200,
  );
});

it("does not map storage that names no index root to the primary indexed scope", async () => {
  const repos = createMemoryRepos();
  const providers = memoryProviderService(repos, { modules: { local: fakeProviderModule() } });
  const second = await seedProviderRow(repos, "http://remote.test", { label: "Remote" });
  const account = await repos.accounts.create({ displayName: "Remote Alice" });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: second.id,
    externalUsername: "alice",
  });
  const resolver = createScopeResolver({ providers, indexRootNames: ["files"] });
  expect(second.config).toEqual({});
  expect(await resolver.verifiedIndexScopes(identity)).toEqual({
    available: false,
    reason: "no_roots",
  });
});
