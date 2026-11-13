import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderModule, StorageProvider } from "@fdrive/core";
import { createMemoryShareRepo } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createLocalModule, type LocalUsers, type SharedGrant } from "@fdrive/local";
import type { Logger } from "pino";
import { onTestFinished, vi } from "vitest";
import { activityFixture } from "../../../test/activity-fixture.js";
import { createApp } from "../../app.ts";
import { createAuthModule, createLoginLimiter, createTokenSource } from "../../auth/index.ts";
import { createIdentityStorageFactory } from "../../auth/storage-factory.ts";
import { memoryIdentityOperations } from "../../auth/test-fixtures/index.ts";
import { type AppConfig, loadConfig } from "../../config.ts";
import { createProviderService } from "../../providers/service.ts";
import { createShareCredentialCodec } from "../credentials.ts";
import { createShareLimiter } from "../limiter.ts";
import { createScryptSharePasswords } from "../passwords.ts";
import { registerSharesRoutes } from "../routes.ts";
import { createSharesService } from "../service.ts";
import type { ShareZipLimits } from "../zip-limits.ts";

type RouteDeps = Parameters<typeof registerSharesRoutes>[1];

/** The first `Set-Cookie` pair of `response`, ready for a `cookie` header. */
export function cookieFrom(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Missing cookie");
  return cookie;
}

/** Reshapes the local folder's module so every storage it builds is replaced by `patch`'s. */
export function patchStorage(
  patch: (storage: StorageProvider) => StorageProvider,
): (module: ProviderModule) => ProviderModule {
  return (module) => ({
    ...module,
    createStorage: (...args) => patch(module.createStorage(...args)),
  });
}

/** Every user the local folder knows; each signs in with `<name>-pass`. */
export const SHARE_USERS = ["alice", "bob", "carol"] as const;

export interface SharesHarnessOptions {
  readonly limiterCapacity?: number;
  /** Reshapes the local folder's module, say to take its shares or its zip away. */
  readonly local?: (module: ProviderModule) => ProviderModule;
  /** The owner's Trash folder, which shares must keep out of. */
  readonly trashPath?: string;
  /** Folders other users share with a user, by that user's name. */
  readonly grants?: Readonly<Record<string, readonly SharedGrant[]>>;
  readonly config?: Partial<AppConfig>;
  readonly zipLimits?: Partial<ShareZipLimits>;
  readonly routes?: Partial<
    Pick<RouteDeps, "indexQueries" | "resolver" | "thumbsDir" | "fileReader" | "thumbnailsEnabled">
  >;
}

/**
 * The shares API over the real local folder module: a temporary root with
 * one home per user, fdrive's own sign-in, the identity storage factory
 * every feature uses, and nothing on the network. Each user starts with
 * `/a.docx` (`<name> data`) and `/report.txt` (`<name> report`).
 */
export function sharesHarness(options: SharesHarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "fdrive-shares-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  function at(path: string, username: string): string {
    return join(root, username, ...path.split("/").filter((part) => part !== ""));
  }
  /** Writes `content` at `path` in `username`'s files, creating its folders. */
  function write(path: string, content: string | Uint8Array, username = "alice"): void {
    mkdirSync(dirname(at(path, username)), { recursive: true });
    writeFileSync(at(path, username), content);
  }
  function mkdir(path: string, username = "alice"): void {
    mkdirSync(at(path, username), { recursive: true });
  }
  function read(path: string, username = "alice"): string {
    return readFileSync(at(path, username), "utf8");
  }
  function remove(path: string, username = "alice"): void {
    rmSync(at(path, username), { recursive: true, force: true });
  }
  for (const username of SHARE_USERS) {
    write("/a.docx", `${username} data`, username);
    write("/report.txt", `${username} report`, username);
  }

  const now = { value: new Date("2026-09-07T00:00:00Z") };
  const clock = () => now.value;
  const repos = createMemoryRepos();
  const links = memoryIdentityOperations(repos);
  const master = Buffer.alloc(32, 13);
  const config: AppConfig = {
    ...loadConfig({
      DATABASE_URL: "postgres://test/fdrive",
      FDRIVE_MASTER_KEY: master.toString("base64"),
      FDRIVE_COOKIE_SECURE: "auto",
      FDRIVE_STORAGE_ROOT: root,
    }),
    ...options.config,
  };
  const users: LocalUsers = {
    async verify(username, password) {
      const known = SHARE_USERS.find((name) => name === username);
      return known !== undefined && password === `${known}-pass`
        ? { result: "ok", username: known }
        : { result: "invalid" };
    },
    async status(username) {
      return SHARE_USERS.some((name) => name === username) ? "active" : "missing";
    },
    async shared(username) {
      return options.grants?.[username] ?? [];
    },
  };
  const localModule = createLocalModule({ root, users });
  // The local folder never calls the network.
  const fetchImpl: typeof globalThis.fetch = async () => {
    throw new Error("the shares harness has no network");
  };
  const providers = createProviderService({
    repos,
    fetch: fetchImpl,
    clock,
    environment: { indexRootNames: [] },
    modules: { local: options.local?.(localModule) ?? localModule },
  });
  const seeded = (async () => {
    const row = await repos.providers.ensure({ type: "local", baseUrl: "local" });
    return repos.providers.update(row.id, { enabled: true, managedByEnv: true });
  })();
  const tokenSource = createTokenSource({ repos, providers, master, clock, fetch: fetchImpl });
  const storageFactory = createIdentityStorageFactory({
    providers,
    tokenSource,
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
    limiter: createLoginLimiter({ clock }),
    tokenSource,
    storageFactory,
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const activity = activityFixture(clock);
  const shares = createMemoryShareRepo();
  // Cheap parameters keep the many password checks below fast; the scheme
  // and its defaults have their own tests.
  const passwords = createScryptSharePasswords({ cost: 1024, blockSize: 8, parallelization: 1 });
  const service = createSharesService({
    repos,
    shares,
    providers,
    storageFor: storageFactory,
    trashPathFor: async () => options.trashPath ?? null,
    passwords,
    ...(options.zipLimits === undefined ? {} : { zipLimits: options.zipLimits }),
    clock,
  });
  const codec = createShareCredentialCodec(master, clock);
  const limiter = createShareLimiter(clock, options.limiterCapacity);
  const app = createApp({
    config,
    logger,
    clock,
    version: "test",
    startedAt: clock(),
    principalResolver: auth.principalResolver,
    connectionStatus: async () => ({ required: false, providers: [] }),
    registerRoutes: (groups) => {
      auth.registerRoutes(groups);
      registerSharesRoutes(groups, {
        activity: activity.service,
        service,
        codec,
        limiter,
        config,
        indexQueries: {
          rootIdsByName: async () => ({}),
          fileByPath: async () => null,
          thumbnail: async () => null,
        },
        resolver: { verifiedIndexScopes: async () => ({ available: false, reason: "no_roots" }) },
        identities: repos.identities,
        thumbsDir: undefined,
        ...options.routes,
      });
    },
  });
  async function request(
    path: string,
    init: {
      method?: string;
      cookie?: string;
      body?: unknown;
      raw?: string | ReadableStream<Uint8Array>;
      headers?: Record<string, string>;
    } = {},
  ) {
    await seeded;
    const request: RequestInit & { duplex?: "half" } = {
      method: init.method ?? "GET",
      headers: {
        "x-requested-with": "fdrive",
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
      ...(init.body === undefined
        ? init.raw === undefined
          ? {}
          : { body: init.raw }
        : { body: JSON.stringify(init.body) }),
    };
    if (init.raw instanceof ReadableStream) request.duplex = "half";
    return app.request(path, request);
  }
  /** Signs in as `username` on the local folder, or on `providerId` with `password`. */
  async function login(
    username = "alice",
    credentials: { providerId?: string; password?: string } = {},
  ) {
    const res = await request("/api/v1/auth/login", {
      method: "POST",
      body: {
        ...(credentials.providerId === undefined ? {} : { providerId: credentials.providerId }),
        credential: { username, password: credentials.password ?? `${username}-pass` },
      },
    });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
    return cookieFrom(res);
  }
  async function create(cookie: string, patch: Record<string, unknown> = {}) {
    const response = await request("/api/v1/shares", {
      method: "POST",
      cookie,
      body: { name: "Document", paths: ["/a.docx"], scope: "read", ...patch },
    });
    if (response.status !== 201) throw new Error(await response.text());
    return response.json() as Promise<{ id: string; hasPassword: boolean }>;
  }
  return {
    root,
    now,
    clock,
    repos,
    config,
    providers,
    storageFactory,
    shares,
    passwords,
    service,
    codec,
    limiter,
    activity,
    logger,
    app,
    request,
    login,
    create,
    write,
    mkdir,
    read,
    remove,
  };
}
export type SharesHarness = ReturnType<typeof sharesHarness>;
