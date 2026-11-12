import { randomUUID } from "node:crypto";
import {
  type FileEntry,
  isStorageError,
  type ProviderModule,
  StorageError,
  type StorageErrorKind,
  type StorageProvider,
  type StorageSession,
} from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/testkit";
import { serve } from "@hono/node-server";

export const USERNAME = "shared-user";
export const SHARED_PATH = "/same.txt";

/** How long a token the fixture mints lives, the way SFTPGo's JWTs did. */
const TOKEN_TTL_MS = 20 * 60 * 1000;
/** The path a login trades its password for a token at. */
export const TOKEN_PATH = "/token";
/** Storage calls are `GET /storage/<read>` or `POST /storage/<write>`, one request each. */
export const LIST_PATH = "/storage/list";
export const MKDIR_PATH = "/storage/mkdir";

/** Only counts leave the fixture. Authorization values never enter assertion output. */
export interface ProviderCalls {
  requests: number;
  passwords: number;
  bearers: number;
  mutations: number;
  foreignCredentials: number;
}

function deferred<T>() {
  let resolve = (_value: T) => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function createBarrier() {
  const entered = deferred<void>();
  const released = deferred<void>();
  return {
    async wait() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          entered.promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("provider barrier was not reached")), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async block() {
      entered.resolve();
      await released.promise;
    },
    release: () => released.resolve(),
  };
}

const STATUS_BY_KIND: Partial<Record<StorageErrorKind, number>> = {
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  bad_request: 400,
  unauthorized: 401,
};

function kindFor(status: number): StorageErrorKind {
  const found = Object.entries(STATUS_BY_KIND).find(([, code]) => code === status);
  return (found?.[0] as StorageErrorKind | undefined) ?? "upstream_unavailable";
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/**
 * A remote storage protocol with password logins and short-lived bearer
 * tokens, served over real TCP: the shape of a backend whose module mints
 * tokens (`ProviderModule.mint`), which no shipped backend has any more.
 * Each server keeps its own files and accepts only its own password.
 */
export async function startProviderServer(label: "A" | "B", clock: () => Date) {
  const password = `fixture-${label}-password`;
  const files = createMemoryStorage({ [SHARED_PATH]: `content from ${label}` });
  const tokens = new Set<string>();
  const ownBasic = basic(USERNAME, password);
  const calls: ProviderCalls = {
    requests: 0,
    passwords: 0,
    bearers: 0,
    mutations: 0,
    foreignCredentials: 0,
  };
  type Gate = ReturnType<typeof createBarrier> & {
    method: string;
    pathname: string;
    unauthorized: boolean;
  };
  const gates: Gate[] = [];
  const active = new Set<Gate>();

  async function storageCall(request: Request, operation: string): Promise<Response> {
    const url = new URL(request.url);
    const path = url.searchParams.get("path") ?? "/";
    switch (operation) {
      case "list":
        return Response.json(await files.list(path));
      case "stat":
        return Response.json(await files.stat(path));
      case "probe":
        await files.list(path);
        return new Response(null, { status: 204 });
      case "download":
        return new Response((await files.download(path)).body);
      case "upload":
        await files.upload(path, new Uint8Array(await request.arrayBuffer()), {
          mkdirParents: url.searchParams.get("parents") === "true",
        });
        return new Response(null, { status: 201 });
      case "mkdir":
        await files.mkdir(path, { parents: url.searchParams.get("parents") === "true" });
        return new Response(null, { status: 201 });
      default:
        return new Response("unknown operation", { status: 404 });
    }
  }

  async function handle(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") return new Response("ok");
    const authorization = request.headers.get("authorization");
    if (pathname === TOKEN_PATH) {
      if (authorization !== ownBasic) return new Response("wrong password", { status: 401 });
      const token = randomUUID();
      tokens.add(token);
      return Response.json({
        token,
        expiresAt: new Date(clock().getTime() + TOKEN_TTL_MS).toISOString(),
      });
    }
    if (!pathname.startsWith("/storage/")) return new Response("not found", { status: 404 });
    if (!authorization?.startsWith("Bearer ") || !tokens.has(authorization.slice(7))) {
      return new Response("token required", { status: 401 });
    }
    try {
      return await storageCall(request, pathname.slice("/storage/".length));
    } catch (error) {
      if (!isStorageError(error)) throw error;
      return new Response(error.message, { status: STATUS_BY_KIND[error.kind] ?? 500 });
    }
  }

  const listening = deferred<number>();
  const server = serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        calls.requests++;
        const authorization = request.headers.get("authorization");
        if (authorization?.startsWith("Basic ")) {
          calls.passwords++;
          if (authorization !== ownBasic) calls.foreignCredentials++;
        } else if (authorization?.startsWith("Bearer ")) {
          calls.bearers++;
          if (!tokens.has(authorization.slice(7))) calls.foreignCredentials++;
        }
        if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) calls.mutations++;
        const index = gates.findIndex(
          (gate) => gate.method === request.method && gate.pathname === pathname,
        );
        const gate = index < 0 ? undefined : gates.splice(index, 1)[0];
        if (gate !== undefined) {
          active.add(gate);
          await gate.block();
          active.delete(gate);
          if (gate.unauthorized) return new Response("fixture token expired", { status: 401 });
        }
        return handle(request);
      },
    },
    (info) => listening.resolve(info.port),
  );
  server.once("error", listening.reject);
  const baseUrl = `http://127.0.0.1:${await listening.promise}`;
  return {
    baseUrl,
    password,
    counts: () => ({ ...calls }),
    /** Reads `path` with this server's own login, over the same counted HTTP. */
    async read(path: string): Promise<string> {
      const login = await fetch(`${baseUrl}${TOKEN_PATH}`, {
        headers: { authorization: ownBasic },
      });
      const { token } = (await login.json()) as { token: string };
      const response = await fetch(`${baseUrl}/storage/download?path=${encodeURIComponent(path)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return response.text();
    },
    pause(method: string, pathname: string, unauthorized = false) {
      const gate = { ...createBarrier(), method, pathname, unauthorized };
      gates.push(gate);
      return gate;
    },
    async close() {
      for (const gate of [...gates, ...active]) gate.release();
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function unsupported(): never {
  throw new StorageError("bad_request", "the provider-binding fixture does not do this");
}

/**
 * Storage over the fixture protocol. Every call takes the session's current
 * token and, when the server answers 401, mints once more and retries, the
 * way a token-minting backend's storage does.
 */
function createFixtureStorage(
  baseUrl: string,
  session: StorageSession,
  fetchImpl: typeof globalThis.fetch,
): StorageProvider {
  async function call(
    method: "GET" | "POST",
    operation: string,
    params: Record<string, string>,
    body?: Uint8Array,
  ): Promise<Response> {
    const send = async (): Promise<Response> => {
      const token = await session.getToken();
      if (token === null) throw new StorageError("unauthorized", "no fixture token");
      const url = new URL(`/storage/${operation}`, baseUrl);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      try {
        return await fetchImpl(url, {
          method,
          headers: { authorization: `Bearer ${token}` },
          ...(body === undefined ? {} : { body }),
        });
      } catch (cause) {
        throw new StorageError("upstream_unavailable", "fixture server unreachable", { cause });
      }
    };
    let response = await send();
    if (response.status === 401) {
      await response.body?.cancel();
      await session.invalidateToken();
      response = await send();
    }
    if (!response.ok) {
      throw new StorageError(kindFor(response.status), await response.text());
    }
    return response;
  }
  const entries = async (response: Response): Promise<FileEntry[]> =>
    ((await response.json()) as (FileEntry & { modifiedAt: string })[]).map((entry) => ({
      ...entry,
      modifiedAt: new Date(entry.modifiedAt),
    }));
  async function stat(path: string) {
    const value = (await (await call("GET", "stat", { path })).json()) as {
      kind: FileEntry["kind"];
      size: number;
      modifiedAt: string | null;
      contentType: string | null;
    };
    return { ...value, modifiedAt: value.modifiedAt === null ? null : new Date(value.modifiedAt) };
  }
  return {
    list: async (path) => entries(await call("GET", "list", { path })),
    stat,
    async statFile(path) {
      const { size, modifiedAt, contentType } = await stat(path);
      return { size, modifiedAt, contentType };
    },
    async probeDirectoryRead(path) {
      await (await call("GET", "probe", { path })).body?.cancel();
    },
    async download(path) {
      const response = await call("GET", "download", { path });
      if (response.body === null) throw new StorageError("internal", "empty fixture download");
      return {
        status: 200,
        body: response.body,
        contentLength: null,
        contentRange: null,
        contentType: null,
        lastModified: null,
      };
    },
    async upload(path, body, opts) {
      const bytes =
        body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
      await call("POST", "upload", { path, parents: String(opts?.mkdirParents === true) }, bytes);
    },
    async mkdir(path, opts) {
      await call("POST", "mkdir", { path, parents: String(opts?.parents === true) });
    },
    move: unsupported,
    copy: unsupported,
    deleteFile: unsupported,
    deleteDir: unsupported,
  };
}

/**
 * The module for `startProviderServer`'s protocol: password login, minted
 * tokens and storage over them. It fills the WebDAV slot of the provider
 * registry, since provider types are a closed list, and stands in for any
 * remote backend that mints tokens.
 */
export function providerFixtureModule(): ProviderModule {
  async function login(
    baseUrl: string,
    username: string,
    password: string,
    ctx: { fetch: typeof globalThis.fetch },
  ) {
    let response: Response;
    try {
      response = await ctx.fetch(`${baseUrl}${TOKEN_PATH}`, {
        headers: { authorization: basic(username, password) },
      });
    } catch (cause) {
      throw new StorageError("upstream_unavailable", "fixture server unreachable", { cause });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new StorageError(kindFor(response.status), "fixture login refused");
    }
    const value = (await response.json()) as { token: string; expiresAt: string };
    return { token: value.token, expiresAt: new Date(value.expiresAt) };
  }
  return {
    type: "webdav",
    label: "Token fixture",
    configFields: [],
    credentialFields: [
      { name: "username", label: "Username", kind: "text", required: true },
      { name: "password", label: "Password", kind: "password", required: true },
    ],
    capabilities: {
      zip: false,
      setModifiedAt: false,
      atomicMove: false,
      trash: false,
      shares: false,
      office: false,
      shareWithPeople: false,
      index: true,
    },
    trash: "none",
    shares: "none",
    indexRootName: () => "files",
    async probe(instance, ctx) {
      const response = await ctx.fetch(`${instance.baseUrl}/healthz`);
      return { ok: response.ok, detail: response.ok ? "reachable" : "unreachable" };
    },
    async authenticate(instance, credential, ctx) {
      const username = credential.username ?? ctx.expectedUsername;
      if (username === undefined) throw new StorageError("unauthorized", "username required");
      if (ctx.expectedUsername !== undefined && username !== ctx.expectedUsername) {
        throw new StorageError("unauthorized", "credential names a different user");
      }
      const token = await login(instance.baseUrl, username, credential.password ?? "", ctx);
      return { externalUsername: username, token };
    },
    mint(instance, session, ctx) {
      return login(
        instance.baseUrl,
        session.externalUsername,
        session.credential.password ?? "",
        ctx,
      );
    },
    createStorage(instance, session, ctx) {
      return createFixtureStorage(instance.baseUrl, session, ctx.fetch);
    },
  };
}
