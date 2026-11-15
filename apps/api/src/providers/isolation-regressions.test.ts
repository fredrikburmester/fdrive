import { createMemoryRepos } from "@fdrive/db/testing";
import { expect, it } from "vitest";
import { createApp } from "../app.ts";
import { authHarness } from "../auth/test-fixtures/index.ts";
import { createScopeResolver } from "../scoping/resolver.ts";
import { createSetupService } from "../setup/service.ts";
import {
  fakeProviderModule,
  memoryProviderService,
  seedProviderRow,
} from "./test-fixtures/index.ts";

it("keeps env setup complete and sessions usable after disabling its last provider", async () => {
  const h = authHarness();
  const row = await h.seeded;
  const login = await h.login();
  const setup = createSetupService({
    authService: h.auth.service,
    logins: h.repos.logins,
    passwords: h.passwords,
    localProvider: async () => row,
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
