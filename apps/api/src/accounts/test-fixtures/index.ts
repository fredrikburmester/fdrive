import { MeResponse } from "@fdrive/contracts";
import type { ProviderModule } from "@fdrive/core";
import { createMemoryRepos } from "@fdrive/db/testing";
import type { Logger } from "pino";
import { vi } from "vitest";
import { createApp } from "../../app.js";
import { createAuthModule, createLoginLimiter } from "../../auth/index.js";
import type { PrincipalResolver } from "../../auth/principal.js";
import { createIdentityStorageFactory } from "../../auth/storage-factory.ts";
import { memoryIdentityOperations } from "../../auth/test-fixtures/index.ts";
import { loadConfig } from "../../config.js";
import {
  FAST_PASSWORDS,
  localModuleFixture,
  seedLocalUsers,
  writeHomeFiles,
} from "../../local/test-fixtures/index.ts";
import { memoryProviderService } from "../../providers/test-fixtures/index.ts";
import { registerAccountsRoutes } from "../routes.ts";
import { createAccountsService } from "../service.ts";
import type { AccountsDeps } from "../types.ts";
import { createAccountViews } from "../views.ts";

/** The users every harness has, each signing in with `<username>-pass`. */
export const HARNESS_USERS = ["alice", "bob", "carol", "dave", "eve", "frank"] as const;

/**
 * A network that is never there: the local folder makes no requests, so
 * only modules a test adds (through `modules` and `wrapFetch`) reach one.
 */
const offline: typeof globalThis.fetch = async (input) => {
  throw new TypeError(`fetch failed: no network in tests (${String(input)})`);
};

/**
 * The API's auth and account routes over the deployment's local folder, as
 * production pins it: a temporary storage root with a home per user holding
 * `/a.docx` and `/report.txt`, and the users in the in-memory repos.
 */
export function accountsHarness(
  options: {
    principalResolver?: PrincipalResolver;
    wrapFetch?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch;
    /**
     * Modules by provider type, replacing the local folder's own: a fake
     * `local` module keeps the seeded row and the users' passwords
     * (`<username>-pass`) but changes how sign-in or storage behaves.
     */
    modules?: Readonly<Record<string, ProviderModule>>;
  } = {},
) {
  const now = { value: new Date("2026-09-07T00:00:00Z") };
  const clock = () => now.value;
  const repos = createMemoryRepos();
  const links = memoryIdentityOperations(repos);
  const master = Buffer.alloc(32, 13);
  const local = localModuleFixture(repos);
  const config = loadConfig({
    DATABASE_URL: "postgres://test/fdrive",
    FDRIVE_STORAGE_ROOT: local.root,
    FDRIVE_MASTER_KEY: master.toString("base64"),
    FDRIVE_COOKIE_SECURE: "auto",
  });
  for (const username of HARNESS_USERS) {
    writeHomeFiles(local.root, username, {
      "/a.docx": `${username} data`,
      "/report.txt": `${username} report`,
    });
  }
  const fetchImpl = options.wrapFetch?.(offline) ?? offline;
  // The module asks `local.users` whether a password is right and whether a
  // user is still active, so a test can spy on `users.verify` or
  // `users.status` to shape what it sees exactly as production would.
  const providers = memoryProviderService(repos, {
    fetch: fetchImpl,
    clock,
    modules: { local: local.module, ...options.modules },
  });
  const seeded = (async () => {
    await seedLocalUsers(
      repos,
      HARNESS_USERS.map((username) => ({ username, password: `${username}-pass` })),
    );
    await providers.seedFromEnvironment();
    const [row] = await repos.providers.list();
    if (row === undefined) throw new Error("the local folder was not seeded");
    return row;
  })();
  const limiter = createLoginLimiter({ clock });
  const storageFactory = createIdentityStorageFactory({
    providers,
    fetch: fetchImpl,
    clock,
  });
  const auth = createAuthModule({
    repos,
    identityLinks: links,
    providers,
    fetch: fetchImpl,
    master,
    clock,
    config,
    limiter,
    storageFactory,
  });
  const deps: AccountsDeps = {
    repos,
    links,
    auth: auth.service,
    providers,
    fetch: fetchImpl,
    limiter,
    master,
    clock,
    storageForIdentity: (identity) => storageFactory(identity.id),
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
    connectionStatus: async () => ({ required: false, providers: [] }),
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
    await seeded;
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
      body: { credential: { username, password: `${username}-pass` } },
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
    /** The storage root: each user's files are under `<root>/<username>`. */
    root: local.root,
    /** What the local module asks about users; spy on it to shape sign-ins. */
    users: local.users,
    passwords: FAST_PASSWORDS,
    providers,
    /** Resolves to the local folder's row once it and the users exist; `call` and `login` await it. */
    seeded,
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
