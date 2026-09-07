import { MeResponse, type SearchResponse } from "@fdrive/contracts";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createFakeSftpgoServer, createSftpgoClient } from "@fdrive/sftpgo";
import type { Logger } from "pino";
import { vi } from "vitest";
import { createApp } from "../../app.js";
import { createAuthModule, createLoginLimiter, createTokenSource } from "../../auth/index.js";
import type { PrincipalResolver } from "../../auth/principal.js";
import { createIdentityClientResolver } from "../../auth/provider-client.ts";
import { createIdentityStorageFactory } from "../../auth/storage-factory.ts";
import { memoryIdentityOperations } from "../../auth/test-fixtures/index.ts";
import { loadConfig } from "../../config.js";
import { createConnectionStore } from "../../connection/store.js";
import { registerAccountsRoutes } from "../routes.ts";
import { createAccountsService } from "../service.ts";
import type { AccountsDeps } from "../types.ts";
import { createAccountViews } from "../views.ts";

export function accountsHarness(
  options: {
    principalResolver?: PrincipalResolver;
    wrapFetch?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch;
  } = {},
) {
  const now = { value: new Date("2026-09-07T00:00:00Z") };
  const clock = () => now.value;
  const repos = createMemoryRepos();
  const links = memoryIdentityOperations(repos);
  const master = Buffer.alloc(32, 13);
  const config = loadConfig({
    DATABASE_URL: "postgres://test/fdrive",
    SFTPGO_URL: "http://storage.test",
    FDRIVE_MASTER_KEY: master.toString("base64"),
    FDRIVE_COOKIE_SECURE: "auto",
  });
  const server = createFakeSftpgoServer({
    users: ["alice", "bob", "carol", "dave", "eve", "frank"].map((username) => ({
      username,
      password: `${username}-pass`,
      permissions: { "/": ["*"] },
    })),
    files: Object.fromEntries(
      ["alice", "bob", "carol", "dave", "eve", "frank"].map((username) => [
        username,
        { "/a.docx": `${username} data`, "/report.txt": `${username} report` },
      ]),
    ),
    now: clock,
  });
  const client = createSftpgoClient({
    baseUrl: "http://storage.test",
    fetch: options.wrapFetch?.(server.fetch) ?? server.fetch,
  });
  const connectionStore = createConnectionStore({
    settings: repos.settings,
    envUrl: config.sftpgoUrl,
    defaultHomeTemplate: config.fdriveHomeTemplate,
    clock,
  });
  const clientForBaseUrl = () => client;
  const clientForIdentity = createIdentityClientResolver({
    identities: repos.identities,
    providers: repos.providers,
    connections: connectionStore,
    clientForBaseUrl,
  });
  const tokenSource = createTokenSource({ repos, master, clock, clientForIdentity });
  const limiter = createLoginLimiter({ clock });
  const storageFactory = createIdentityStorageFactory({ clientForIdentity, tokenSource });
  const auth = createAuthModule({
    repos,
    identityLinks: links,
    clientForBaseUrl,
    clientForIdentity,
    master,
    clock,
    config,
    limiter,
    tokenSource,
    connectionStore,
    storageFactory,
  });
  const emptySearch: SearchResponse = {
    query: "report",
    sections: { folders: [], files: [], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 0,
  };
  const deps: AccountsDeps = {
    repos,
    links,
    auth: auth.service,
    tokenSource,
    clientForBaseUrl,
    limiter,
    master,
    clock,
    connectionStore,
    storageForIdentity: (identity) => storageFactory(identity.id),
    searchForIdentity: async () => emptySearch,
  };
  const service = createAccountsService(deps);
  const views = createAccountViews(deps);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const app = createApp({
    config,
    clock,
    logger,
    version: "test",
    startedAt: clock(),
    principalResolver: options.principalResolver ?? auth.principalResolver,
    registerRoutes: (groups) => {
      auth.registerRoutes(groups);
      registerAccountsRoutes(groups, { service, views, config, clock });
    },
  });
  async function call(
    path: string,
    options: {
      cookie?: string;
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    return app.request(path, {
      method: options.method ?? "GET",
      headers: {
        "x-requested-with": "fdrive",
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }
  async function login(username = "alice") {
    const response = await call("/api/v1/auth/login", {
      method: "POST",
      body: { username, password: `${username}-pass` },
    });
    const me = MeResponse.parse(await response.json());
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Missing cookie");
    return { cookie, me };
  }
  return {
    now,
    clock,
    repos,
    links,
    master,
    config,
    server,
    client,
    connectionStore,
    tokenSource,
    limiter,
    auth,
    deps,
    service,
    views,
    logger,
    app,
    call,
    login,
    storageFactory,
  };
}
export type AccountsHarness = ReturnType<typeof accountsHarness>;
export function cookieFrom(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Missing rotated cookie");
  return cookie;
}
