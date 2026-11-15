import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_API, DesktopPairing, DesktopPairResult } from "@fdrive/contracts";
import { StorageError, type StorageProvider } from "@fdrive/core";
import type { Login } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createLocalStorage, createUserStorage, SHARED_WITH_ME } from "@fdrive/local";
import { createMemoryStorage } from "@fdrive/testkit";
import { afterEach, expect, it, vi } from "vitest";
import { activityFixture } from "../../test/activity-fixture.js";
import { memoryRepo } from "../../test/helpers/desktop-repo.js";
import { createApp } from "../app.js";
import type { Principal, PrincipalExtras } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { ApiHttpError } from "../errors.js";
import { createResolveTokenPrincipal } from "../tokens/principal.js";
import { createTokenService } from "../tokens/service.js";
import type { DesktopChanges } from "./changes.js";
import { createDesktopFiles } from "./files.js";
import { createDesktopPairing } from "./pairing.js";
import { registerDesktopRoutes } from "./routes.js";
import { createDesktopWrites, NO_WRITES } from "./writes.js";

const ALL_WRITES = { create: true, update: true, move: true, trash: true, restore: true };

it("runs the complete v2 routes with explicit grants, streamed content, receipts and revocation", async () => {
  const f = await fixture(true);
  const base = "/api/v2/desktop";
  const pair = f.pairing.create("Mac", "test", 2);
  // The route owns a separate transient pairing store, so pair through that API.
  const created = await f.app.request(`${base}/pairings`, {
    method: "POST",
    headers: { "x-requested-with": "fdrive", "content-type": "application/json" },
    body: JSON.stringify({ deviceName: "Mac" }),
  });
  expect(created.status).toBe(201);
  const request = DesktopPairing.parse(await created.json());
  expect(
    (
      await f.request(
        `/pairings/${request.id}/approve`,
        { access: "full" },
        { cookie: "fdrive_session=test" },
      )
    ).status,
  ).toBe(200);
  const polled = await f.app.request(`${base}/pairings/${request.id}/poll`, {
    method: "POST",
    headers: { "x-requested-with": "fdrive", "content-type": "application/json" },
    body: JSON.stringify({ secret: request.secret }),
  });
  const connected = (await polled.json()) as { credentials: Array<{ token: string }> };
  const token = connected.credentials[0]?.token;
  if (!token) throw Error("Missing token");
  const headers = {
    authorization: `Bearer ${token}`,
    "x-requested-with": "fdrive",
    "content-type": "application/json",
  };
  const call = (route: string, body?: unknown) =>
    f.app.request(base + route, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  expect(await (await call("/location")).json()).toMatchObject({
    protocolVersion: 2,
    readOnly: false,
  });
  expect((await f.request("/location", undefined, headers)).status).toBe(401);
  expect((await call("/operations/invalid")).status).toBe(400);
  expect((await call(`/operations/${randomUUID()}`)).status).toBe(404);
  expect((await call("/entries?path=/")).status).toBe(200);
  // Folder checks: advertised, answered from a listing's token, and strictly bounded.
  expect(await (await call("/location")).json()).toMatchObject({ listingChecks: true });
  const { token: rootToken } = (await (await call("/entries?path=/")).json()) as { token: string };
  expect(
    await (await call("/checks", { folders: [{ path: "/", token: rootToken }] })).json(),
  ).toEqual({ folders: [{ path: "/", status: "unchanged" }] });
  for (const folders of [
    [],
    Array.from({ length: 201 }, (_, index) => ({ path: `/f${index}`, token: "t" })),
    [
      { path: "/", token: "t" },
      { path: "/", token: "t" },
    ],
    [{ path: "relative", token: "t" }],
  ])
    expect((await call("/checks", { folders })).status).toBe(400);
  const anonymous = await f.app.request(`${base}/checks`, {
    method: "POST",
    headers: { "x-requested-with": "fdrive", "content-type": "application/json" },
    body: JSON.stringify({ folders: [{ path: "/", token: rootToken }] }),
  });
  expect(anonymous.status).toBe(401);
  expect((await call("/entry?path=/docs/a.txt")).status).toBe(200);
  expect(await (await call("/content?path=/docs/a.txt")).text()).toBe("alpha");
  // A rejected ID is refused outright rather than costing the caller its bytes.
  const hydration = async (id: string) =>
    (
      await f.app.request(`${base}/content?path=/docs/a.txt`, {
        headers: { ...headers, "x-fdrive-operation-id": id },
      })
    ).text();
  expect(await hydration("hydrate-1")).toBe("alpha");
  expect(await hydration("hydrate-1")).toBe("alpha");
  expect(await hydration("hydrate-2")).toBe("alpha");
  // Four hydrations, three materializations: the repeat under one ID is the
  // one the caller already made, and it is not attributed twice.
  expect(f.activity.operations.filter((row) => row.action === "file.materialize")).toHaveLength(3);
  expect(f.activity.outcomes.filter((row) => row.action === "file.materialize")).toHaveLength(3);
  expect(JSON.parse(await hydration("not valid")).error.kind).toBe("bad_request");
  expect((await call("/versions", { paths: ["/docs/a.txt"] })).status).toBe(200);
  const folderId = randomUUID();
  expect(
    (await call("/folders", { operationId: folderId, parentId: "root", name: "new-folder" }))
      .status,
  ).toBe(200);
  const folder = (await (await call(`/operations/${folderId}/commit`, {})).json()) as {
    item: { id: string; version: { content: string; metadata: string } };
  };
  const movedId = randomUUID();
  expect(
    (
      await call("/moves", {
        operationId: movedId,
        itemId: folder.item.id,
        parentId: "root",
        name: "renamed-folder",
        base: folder.item.version,
      })
    ).status,
  ).toBe(200);
  expect((await call(`/operations/${movedId}/commit`, {})).status).toBe(200);
  const operationId = randomUUID();
  const digest = createHash("sha256").update("").digest("hex");
  expect(
    (
      await call("/uploads", {
        operationId,
        parentId: "root",
        name: "empty",
        base: null,
        size: 0,
        sha256: digest,
      })
    ).status,
  ).toBe(200);
  expect(
    (await f.app.request(`${base}/operations/${operationId}/content`, { method: "PUT", headers }))
      .status,
  ).toBe(200);
  expect((await call(`/operations/${operationId}/commit`, {})).status).toBe(200);
  expect((await call(`/operations/${operationId}`)).status).toBe(200);
  expect((await call(`/operations/${operationId}/acknowledge`, {})).status).toBe(200);
  const cancelId = randomUUID();
  await call("/folders", { operationId: cancelId, parentId: "root", name: "cancelled" });
  expect((await call(`/operations/${cancelId}/cancel`, {})).status).toBe(200);
  expect((await call("/disconnect", {})).status).toBe(200);
  expect((await call("/location")).status).toBe(401);
  // Unknown pairing secrets and cancelled requests cannot be reused.
  expect((await call(`/pairings/${pair.id}/cancel`, { secret: pair.secret })).status).toBe(404);
  const next = DesktopPairing.parse(
    await (
      await f.app.request(`${base}/pairings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ deviceName: "Cancel" }),
      })
    ).json(),
  );
  expect((await call(`/pairings/${next.id}/cancel`, { secret: next.secret })).status).toBe(200);
  expect((await call(`/pairings/${next.id}/poll`, { secret: next.secret })).status).toBe(404);
});

/** Pairs a write-protocol location through the routes and returns a caller for it. */
async function pairWritable(f: Awaited<ReturnType<typeof fixture>>) {
  const base = "/api/v2/desktop";
  const json = { "x-requested-with": "fdrive", "content-type": "application/json" };
  const created = await f.app.request(`${base}/pairings`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ deviceName: "Mac" }),
  });
  const request = DesktopPairing.parse(await created.json());
  await f.request(
    `/pairings/${request.id}/approve`,
    { access: "full" },
    { cookie: "fdrive_session=test" },
  );
  const polled = await f.app.request(`${base}/pairings/${request.id}/poll`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ secret: request.secret }),
  });
  const token = ((await polled.json()) as { credentials: Array<{ token: string }> }).credentials[0]
    ?.token;
  if (!token) throw Error("Missing token");
  return (route: string, authorized = true) =>
    f.app.request(base + route, {
      headers: { ...json, ...(authorized ? { authorization: `Bearer ${token}` } : {}) },
    });
}

it("publishes nothing once the pairing is revoked or downgraded while a save hashes its base", async () => {
  const base = "/api/v2/desktop";
  const json = { "x-requested-with": "fdrive", "content-type": "application/json" };
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  for (const change of ["revoked", "downgraded"] as const) {
    const f = await fixture(true);
    const created = await f.app.request(`${base}/pairings`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ deviceName: "Mac" }),
    });
    const request = DesktopPairing.parse(await created.json());
    await f.request(
      `/pairings/${request.id}/approve`,
      { access: "full" },
      { cookie: "fdrive_session=test" },
    );
    const polled = await f.app.request(`${base}/pairings/${request.id}/poll`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ secret: request.secret }),
    });
    const token = ((await polled.json()) as { credentials: Array<{ token: string }> })
      .credentials[0]?.token;
    if (!token) throw Error("Missing token");
    const headers = { ...json, authorization: `Bearer ${token}` };
    const call = (route: string, body?: unknown) =>
      f.app.request(base + route, {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const entry = (await (await call("/entry?path=/docs/a.txt")).json()) as {
      id: string;
      parentId: string;
      version: { content: string; metadata: string };
    };
    const operationId = randomUUID();
    const prepared = await call("/uploads", {
      operationId,
      parentId: entry.parentId,
      itemId: entry.id,
      name: "a.txt",
      base: { ...entry.version, content: sha("alpha") },
      size: 5,
      sha256: sha("saved"),
    });
    expect(prepared.status).toBe(200);
    const sent = await f.app.request(`${base}/operations/${operationId}/content`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/octet-stream" },
      body: "saved",
    });
    expect(sent.status).toBe(200);
    // The token changes while the commit reads the file its save replaces.
    const [stored] = await f.repos.apiTokens.listByAccount(f.account.id);
    if (!stored) throw Error("Missing stored token");
    const findByHash = f.repos.apiTokens.findByHash.bind(f.repos.apiTokens);
    let changed = false;
    vi.spyOn(f.repos.apiTokens, "findByHash").mockImplementation(async (hash) => {
      const found = await findByHash(hash);
      return changed && found ? { ...found, access: { mode: "read", paths: ["/"] } } : found;
    });
    const download = f.storage.download.bind(f.storage);
    vi.spyOn(f.storage, "download").mockImplementation(async (path, options) => {
      if (path === "/docs/a.txt" && !changed) {
        changed = true;
        if (change === "revoked") await f.repos.apiTokens.delete(stored.id, f.account.id);
      }
      return download(path, options);
    });
    const commit = await call(`/operations/${operationId}/commit`, {});
    expect(commit.status, change).toBe(401);
    expect(changed).toBe(true);
    expect(await new Response((await download("/docs/a.txt")).body).text()).toBe("alpha");
  }
});

it("advertises the change feed and answers it", async () => {
  // Without a feed: nothing advertised, nothing served.
  const plain = await fixture(true);
  const plainCall = await pairWritable(plain);
  expect(await (await plainCall("/location")).json()).not.toHaveProperty("changeFeed");
  expect((await plainCall("/changes")).status).toBe(404);

  const read = vi.fn(async (_principal: Principal, since: string | undefined) => ({
    status: "resync" as const,
    anchor: since ?? "v1.start",
  }));
  const f = await fixture(true, { read });
  const call = await pairWritable(f);
  expect(await (await call("/location")).json()).toMatchObject({
    listingChecks: true,
    changeFeed: true,
  });
  expect(await (await call("/changes")).json()).toEqual({ status: "resync", anchor: "v1.start" });
  expect(await (await call("/changes?since=v1.mine")).json()).toEqual({
    status: "resync",
    anchor: "v1.mine",
  });
  expect(read.mock.calls.map(([principal, since]) => [principal.identityId, since])).toEqual([
    [f.identity.id, undefined],
    [f.identity.id, "v1.mine"],
  ]);
  for (const since of ["", "a".repeat(257)])
    expect((await call(`/changes?since=${since}`)).status).toBe(400);
  expect((await call("/changes", false)).status).toBe(401);
});

const desktopDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    desktopDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(writable = false, changes?: DesktopChanges) {
  const repos = createMemoryRepos();
  let now = new Date("2026-09-13T00:00:00Z");
  const clock = () => now;
  const activity = activityFixture(clock);
  const provider = await repos.providers.ensure({ type: "local", baseUrl: "local" });
  const user = (username: string) =>
    repos.logins.createUser({
      providerId: provider.id,
      username,
      passwordHash: "h",
      isAdmin: false,
      at: now,
    });
  const identity = await user("alice");
  const account = { id: identity.accountId };
  // Another person's login, on an account of its own.
  const second = await user("bob");
  const storage: StorageProvider = createMemoryStorage({
    "/docs/a.txt": "alpha",
    "/.trash/old": "trash",
    "/hidden/b.txt": "private",
  });
  const otherStorage = createMemoryStorage({ "/docs/a.txt": "bravo" });
  const deps = {
    ...repos,
    storage: { id: provider.id, name: async () => "Family files" },
    clock,
    principalFor: vi.fn(
      async (login: Login, extras?: PrincipalExtras): Promise<Principal> => ({
        accountId: login.accountId,
        identityId: login.identityId,
        username: login.username,
        isAdmin: login.isAdmin,
        storage: login.identityId === identity.id ? storage : otherStorage,
        ...extras,
      }),
    ),
  };
  const principal: Principal = {
    accountId: account.id,
    identityId: identity.id,
    username: "alice",
    storage,
    isAdmin: false,
    tokenAccess: { mode: "read", paths: ["/"] },
  };
  const pairing = createDesktopPairing(deps);
  const files = createDesktopFiles(deps);
  const app = createApp({
    config: loadConfig({
      DATABASE_URL: "postgres://localhost/fdrive",
      FDRIVE_STORAGE_ROOT: "/srv/files",
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 4).toString("base64"),
    }),
    logger: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} } as never,
    version: "test",
    startedAt: new Date(0),
    setupRequired: async () => false,
    principalResolver: async (c) => (c.req.header("cookie") ? principal : null),
    registerRoutes: (groups) =>
      registerDesktopRoutes(groups, {
        ...deps,
        ...(changes ? { changes } : {}),
        activity: activity.service,
        clientIp: () => "test",
        ...(writable
          ? {
              writes: createDesktopWrites({
                ...deps,
                repo: memoryRepo().repo,
                storageForIdentity: async () => storage,
              }),
            }
          : {}),
      }),
  });
  function request(route: string, body?: unknown, headers: Record<string, string> = {}) {
    return app.request(DESKTOP_API + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-requested-with": "fdrive", "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const owner = { accountId: account.id, identityId: identity.id };
  /** Pairs a Mac for alice through the pairing service and returns its one credential. */
  async function connect(access: "read" | "full" = "read", protocolVersion: 1 | 2 = 1) {
    const pair = pairing.create("Mac", "connect", protocolVersion);
    await pairing.approve(pair.id, owner, access);
    const result = await pairing.poll(pair.id, pair.secret);
    const credential = result.status === "connected" ? result.credentials[0] : undefined;
    if (!credential) throw new Error("Expected a credential");
    return credential;
  }
  return {
    repos,
    deps,
    activity,
    account,
    provider,
    identity,
    second,
    owner,
    connect,
    storage,
    principal,
    pairing,
    files,
    app,
    request,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

it("pairs the signed-in login once, confines desktop credentials, and revokes only the chosen location", async () => {
  const f = await fixture();
  const pair = DesktopPairing.parse(
    await (await f.request("/pairings", { deviceName: "My Mac" })).json(),
  );
  expect(
    await (await f.request(`/pairings/${pair.id}/poll`, { secret: pair.secret })).json(),
  ).toEqual({ status: "pending" });
  expect((await f.request(`/pairings/${pair.id}`)).status).toBe(401);
  const info = await f.request(`/pairings/${pair.id}`, undefined, {
    cookie: "fdrive_session=test",
  });
  expect(info.headers.get("cache-control")).toBe("no-store");
  expect(await info.json()).toMatchObject({
    code: pair.code,
    deviceName: "My Mac",
    approved: false,
  });
  expect(
    (
      await f.request(
        `/pairings/${pair.id}/approve`,
        { access: "read" },
        { cookie: "fdrive_session=test", authorization: "Bearer nope" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.app.request(`${DESKTOP_API}/pairings/${pair.id}/approve`, {
        method: "POST",
        headers: { cookie: "fdrive_session=test", "content-type": "application/json" },
        body: JSON.stringify({ access: "read" }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request(
        `/pairings/${pair.id}/approve`,
        { access: "read" },
        { cookie: "fdrive_session=test" },
      )
    ).status,
  ).toBe(200);
  const [first, retry] = await Promise.all(
    [1, 2].map(async () =>
      DesktopPairResult.parse(
        await (await f.request(`/pairings/${pair.id}/poll`, { secret: pair.secret })).json(),
      ),
    ),
  );
  expect(first).toEqual(retry);
  if (first?.status !== "connected") throw new Error("Expected credentials");
  // One location, in the list every Mac app reads.
  expect(first.credentials).toHaveLength(1);
  const one = first.credentials[0];
  if (!one) throw new Error("Expected a credential");
  const two = await f.connect();
  const headers = { authorization: `Bearer ${one.token}` };
  expect(await createResolveTokenPrincipal(f.deps)(one.token)).toBeNull();
  const mcp = await createTokenService(f.deps).create(f.owner, { name: "MCP" });
  expect(
    (await f.request("/location", undefined, { authorization: `Bearer ${mcp.token}` })).status,
  ).toBe(401);
  expect(
    (
      await f.request("/location", undefined, {
        authorization: `Bearer ${one.token.replace("fdd_", "fdr_")}`,
      })
    ).status,
  ).toBe(401);
  expect(await (await f.request("/location", undefined, headers)).json()).toMatchObject({
    identityId: f.identity.id,
    readOnly: true,
  });
  expect(
    await (await f.request("/entry?path=/docs/a.txt", undefined, headers)).json(),
  ).toMatchObject({ name: "a.txt", readable: true });
  expect(
    await (
      await f.request("/content?path=/docs/a.txt", undefined, {
        ...headers,
        "x-identity-id": f.second.id,
      })
    ).text(),
  ).toBe("alpha");
  expect(
    await (
      await f.request("/content?path=/docs/a.txt", undefined, {
        authorization: `Bearer ${two.token}`,
      })
    ).text(),
  ).toBe("alpha");
  expect((await f.request("/entries?path=/", undefined, headers)).status).toBe(200);
  expect((await f.request("/entry?path=relative", undefined, headers)).status).toBe(400);
  expect((await f.request("/content?path=/.trash/old", undefined, headers)).status).toBe(403);
  const hash = createHash("sha256").update("alpha").digest("hex");
  expect(await (await f.request("/versions", { paths: ["/docs/a.txt"] }, headers)).json()).toEqual({
    items: [{ path: "/docs/a.txt", version: hash, size: 5 }],
  });
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await f.app.request(`${DESKTOP_API}/content?path=/docs/a.txt`, {
      method,
      headers: { ...headers, "x-requested-with": "fdrive" },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  }
  expect((await f.request("/disconnect", {}, headers)).status).toBe(200);
  expect((await f.request("/location", undefined, headers)).status).toBe(401);
  expect(
    (await f.request("/location", undefined, { authorization: `Bearer ${two.token}` })).status,
  ).toBe(200);
  f.advance(366 * 86_400_000);
  expect(
    (await f.request("/location", undefined, { authorization: `Bearer ${two.token}` })).status,
  ).toBe(401);
});

it("says credential_gone only for a desktop credential the server no longer holds", async () => {
  const f = await fixture(true);
  /** The refusal's `error.details.code`; undefined for a plain 401. */
  async function refusal(version: 1 | 2, route: string, authorization?: string) {
    const response = await f.app.request(`/api/v${version}/desktop${route}`, {
      headers: { "x-requested-with": "fdrive", ...(authorization ? { authorization } : {}) },
    });
    expect(response.status, route).toBe(401);
    const body = (await response.json()) as {
      error: { kind: string; details?: { code?: string } };
    };
    expect(body.error.kind).toBe("unauthorized");
    return body.error.details?.code;
  }
  // Revoked by its Mac: every desktop route, on either protocol, says it is gone.
  const disconnected = await f.connect("full", 2);
  expect(
    (await f.request("/disconnect", {}, { authorization: `Bearer ${disconnected.token}` })).status,
  ).toBe(200);
  for (const route of ["/location", "/entries?path=/", "/content?path=/docs/a.txt"]) {
    for (const version of [1, 2] as const)
      expect(await refusal(version, route, `Bearer ${disconnected.token}`)).toBe("credential_gone");
  }
  // Revoked from the web, and one this server never issued (or a restore cleared).
  const fromWeb = await f.connect();
  await createTokenService(f.deps).revoke(fromWeb.tokenId, f.account.id);
  expect(await refusal(1, "/location", `Bearer ${fromWeb.token}`)).toBe("credential_gone");
  expect(await refusal(2, "/location", `Bearer fdd_${"A".repeat(43)}`)).toBe("credential_gone");
  // Expired: the server still holds it, so the Mac only signs out and can reconnect.
  const expiring = await f.connect("full", 2);
  f.advance(366 * 86_400_000);
  expect(await refusal(2, "/location", `Bearer ${expiring.token}`)).toBeUndefined();
  // A live credential on a route its grant does not reach, a foreign or malformed bearer, none.
  const full = await f.connect("full", 2);
  expect(await refusal(1, "/location", `Bearer ${full.token}`)).toBeUndefined();
  const mcp = await createTokenService(f.deps).create(f.owner, { name: "MCP" });
  expect(await refusal(2, "/location", `Bearer ${mcp.token}`)).toBeUndefined();
  expect(
    await refusal(2, "/location", `Bearer ${full.token.replace("fdd_", "fdr_")}`),
  ).toBeUndefined();
  expect(await refusal(2, "/location", "Bearer fdd_short")).toBeUndefined();
  expect(await refusal(2, "/location")).toBeUndefined();
});

it("requires the app secret, cancels issued credentials, expires pending requests and bounds admission", async () => {
  const f = await fixture();
  const pair = f.pairing.create("Mac", "owner");
  await expect(f.pairing.poll(pair.id, "wrong")).rejects.toMatchObject({ kind: "unauthorized" });
  await expect(f.pairing.cancel(pair.id, "wrong")).rejects.toMatchObject({ kind: "unauthorized" });
  await f.pairing.approve(pair.id, f.owner, "read");
  await expect(f.pairing.approve(pair.id, f.owner, "read")).rejects.toMatchObject({
    kind: "conflict",
  });
  const connected = await f.pairing.poll(pair.id, pair.secret);
  expect(connected.status).toBe("connected");
  await f.pairing.cancel(pair.id, pair.secret);
  expect(await f.repos.apiTokens.listByAccount(f.account.id)).toHaveLength(0);
  expect(() => f.pairing.info(pair.id)).toThrow("expired");
  const pending = f.pairing.create("Mac", "owner");
  await f.pairing.cancel(pending.id, pending.secret);
  const expired = f.pairing.create("Mac", "owner");
  f.advance(300_000);
  expect(() => f.pairing.info(expired.id)).toThrow("expired");
  for (let i = 0; i < 8; i++) f.pairing.create("Mac", "owner");
  expect(() => f.pairing.create("Mac", "owner")).toThrow("Too many");
  for (let i = 8; i < 512; i++) f.pairing.create("Mac", String(i));
  expect(() => f.pairing.create("Mac", "new")).toThrow("Too many");
});

it("revokes issued credentials the app never confirms and keeps confirmed ones", async () => {
  const f = await fixture();
  const pair = f.pairing.create("Mac", "owner");
  await expect(f.pairing.confirm(pair.id, pair.secret)).rejects.toMatchObject({
    kind: "conflict",
  });
  await f.pairing.approve(pair.id, f.owner, "read");
  await expect(f.pairing.confirm(pair.id, "wrong")).rejects.toMatchObject({
    kind: "unauthorized",
  });
  await expect(f.pairing.confirm(pair.id, pair.secret)).rejects.toMatchObject({
    kind: "conflict",
  });
  const connected = await f.pairing.poll(pair.id, pair.secret);
  expect(connected.status).toBe("connected");
  await f.pairing.confirm(pair.id, pair.secret);
  // The same bundle stays available inside the window; cancel no longer revokes it.
  expect(await f.pairing.poll(pair.id, pair.secret)).toEqual(connected);
  await f.pairing.cancel(pair.id, pair.secret);
  expect(await f.repos.apiTokens.listByAccount(f.account.id)).toHaveLength(1);
  // The HTTP routes own a separate pairing store; confirm through them as the app does.
  const routed = DesktopPairing.parse(
    await (await f.request("/pairings", { deviceName: "Routed Mac" })).json(),
  );
  await f.request(
    `/pairings/${routed.id}/approve`,
    { access: "read" },
    { cookie: "fdrive_session=test" },
  );
  await f.request(`/pairings/${routed.id}/poll`, { secret: routed.secret });
  expect((await f.request(`/pairings/${routed.id}/confirm`, { secret: "x" })).status).toBe(400);
  expect(
    (await f.request(`/pairings/${routed.id}/confirm`, { secret: routed.secret })).status,
  ).toBe(200);
  expect(await f.repos.apiTokens.listByAccount(f.account.id)).toHaveLength(2);
  const orphan = f.pairing.create("Mac", "owner");
  await f.pairing.approve(orphan.id, f.owner, "read");
  expect((await f.pairing.poll(orphan.id, orphan.secret)).status).toBe("connected");
  expect(await f.repos.apiTokens.listByAccount(f.account.id)).toHaveLength(3);
  f.advance(300_000);
  await f.pairing.sweep();
  expect(await f.repos.apiTokens.listByAccount(f.account.id)).toHaveLength(2);
  await expect(f.pairing.confirm(orphan.id, orphan.secret)).rejects.toMatchObject({
    kind: "not_found",
  });
  // Confirmation on the v2 route follows the same rules.
  const v2 = await f.app.request("/api/v2/desktop/pairings/unknown/confirm", {
    method: "POST",
    headers: { "x-requested-with": "fdrive", "content-type": "application/json" },
    body: JSON.stringify({ secret: orphan.secret }),
  });
  expect(v2.status).toBe(404);
});

it("revokes only the supplied desktop credential without building storage", async () => {
  const f = await fixture();
  const credential = await f.connect();
  const other = await f.connect();
  const mcp = await createTokenService(f.deps).create(f.owner, { name: "MCP" });
  f.deps.principalFor.mockClear();
  f.deps.principalFor.mockRejectedValue(
    new ApiHttpError("upstream_unavailable", "storage provider unavailable"),
  );
  for (const token of ["", mcp.token, mcp.token.replace("fdr_", "fdd_")]) {
    expect((await f.request("/disconnect", {}, { authorization: `Bearer ${token}` })).status).toBe(
      401,
    );
  }
  const response = await f.request(
    "/disconnect",
    {},
    {
      authorization: `Bearer ${credential.token}`,
    },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(
    (await f.repos.apiTokens.listByAccount(f.account.id)).map((token) => token.id).sort(),
  ).toEqual([other.tokenId, mcp.item.id].sort());
  expect(f.deps.principalFor).not.toHaveBeenCalled();
  // Expiration should not prevent cleanup of a credential whose hash is still stored.
  f.advance(366 * 86_400_000);
  expect(
    (await f.request("/disconnect", {}, { authorization: `Bearer ${other.token}` })).status,
  ).toBe(200);
});

it("refuses the location of a user an administrator disabled since connecting", async () => {
  const f = await fixture();
  const pair = f.pairing.create("Mac", "owner");
  await f.pairing.approve(pair.id, f.owner, "read");
  const result = await f.pairing.poll(pair.id, pair.secret);
  if (result.status !== "connected") throw new Error("Expected credentials");
  const credential = result.credentials[0];
  if (!credential) throw new Error("Expected a location");
  expect(credential.location).toMatchObject({
    providerId: f.provider.id,
    displayName: "Family files",
  });
  await f.repos.localUsers.update("alice", { disabled: true });
  expect(
    (await f.request("/location", undefined, { authorization: `Bearer ${credential.token}` }))
      .status,
  ).toBe(403);
});

it("bounds one IPv6 subscriber to eight pairing slots and preserves admission for others", async () => {
  const f = await fixture();
  let admitted = 0;
  for (let address = 1; address <= 64; address++) {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        f.pairing.create("Mac", `2001:db8:1234:5678::${address.toString(16)}`);
        admitted++;
      } catch (error) {
        expect(error).toMatchObject({ kind: "rate_limited" });
      }
    }
  }
  expect(admitted).toBe(8);
  expect(() => f.pairing.create("Other IPv6 Mac", "2001:db8:1234:5679::1")).not.toThrow();
  expect(() => f.pairing.create("IPv4 Mac", "203.0.113.9")).not.toThrow();
  f.advance(300_000);
  expect(() => f.pairing.create("Mac", "2001:db8:1234:5678::1")).not.toThrow();
});

it("rolls back a failed issuance and approves a pairing once", async () => {
  const f = await fixture();
  const pair = f.pairing.create("Mac", "owner");
  await f.pairing.approve(pair.id, f.owner, "read");
  f.deps.principalFor.mockRejectedValueOnce(new Error("upstream offline"));
  await expect(f.pairing.poll(pair.id, pair.secret)).rejects.toThrow();
  expect(await f.repos.apiTokens.listByAccount(f.account.id)).toHaveLength(0);
  const race = f.pairing.create("Mac", "owner");
  const approvals = await Promise.allSettled(
    [1, 2].map(() => f.pairing.approve(race.id, f.owner, "read")),
  );
  expect(approvals.filter((result) => result.status === "fulfilled")).toHaveLength(1);
});

it("cancels through HTTP and rejects malformed pairing requests", async () => {
  const f = await fixture();
  expect((await f.request("/pairings", { deviceName: "" })).status).toBe(400);
  const pair = DesktopPairing.parse(
    await (await f.request("/pairings", { deviceName: "Mac" })).json(),
  );
  expect((await f.request(`/pairings/${pair.id}/cancel`, { secret: pair.secret })).status).toBe(
    200,
  );
  expect((await f.request(`/pairings/${pair.id}/poll`, { secret: pair.secret })).status).toBe(404);
});

it("lists 10,000 metadata entries consistently, binding cursors to token, identity, path and expiry", async () => {
  const f = await fixture();
  const entries = Array.from({ length: 10_000 }, (_, index) => ({
    name: `${index}.txt`,
    path: `/${index}.txt`,
    kind: "file" as const,
    size: 5,
    modifiedAt: new Date(0),
    ext: "txt",
  }));
  const list = vi.spyOn(f.storage, "list").mockResolvedValue(entries);
  const download = vi.spyOn(f.storage, "download");
  f.storage.probeDirectoryRead = vi.fn(async () => {});
  const first = await f.files.list(f.principal, "/", "token");
  const cursor = first.nextCursor ?? "";
  await expect(f.files.list(f.principal, "/", "other-token", cursor)).rejects.toMatchObject({
    kind: "conflict",
  });
  await expect(
    f.files.list({ ...f.principal, identityId: "other" }, "/", "token", cursor),
  ).rejects.toMatchObject({ kind: "conflict" });
  await expect(
    f.files.list(f.principal, "/", "token", cursor.replace(":500", ":1")),
  ).rejects.toMatchObject({ kind: "bad_request" });
  list.mockResolvedValue([]); // Snapshot stays complete even if storage changes during paging.
  const all = [...first.entries];
  let next = first.nextCursor;
  while (next) {
    const page = await f.files.list(f.principal, "/", "token", next);
    all.push(...page.entries);
    next = page.nextCursor;
  }
  expect(all).toHaveLength(10_000);
  expect(new Set(all.map((entry) => entry.path)).size).toBe(10_000);
  expect(list).toHaveBeenCalledTimes(1);
  expect(download).not.toHaveBeenCalled();
  list.mockResolvedValue(entries);
  const expired = await f.files.list(f.principal, "/", "token");
  f.advance(120_000);
  await expect(
    f.files.list(f.principal, "/", "token", expired.nextCursor ?? ""),
  ).rejects.toMatchObject({ kind: "conflict" });
  list.mockResolvedValue([...entries, ...Array(100_001).fill(entries[0])]);
  await expect(f.files.list(f.principal, "/", "token")).rejects.toMatchObject({
    kind: "rate_limited",
  });
});

it("preserves ancestor visibility while enforcing grants, Trash exclusion, live permissions and symlink confinement", async () => {
  const f = await fixture();
  const principal = {
    ...f.principal,
    tokenAccess: { mode: "read" as const, paths: ["/docs/a.txt"] },
  };
  expect((await f.files.list(principal, "/", "token")).entries.map((entry) => entry.path)).toEqual([
    "/docs",
  ]);
  expect(
    (await f.files.list(principal, "/docs", "token")).entries.map((entry) => entry.name),
  ).toEqual(["a.txt"]);
  await expect(
    f.files.content(principal, "/hidden/b.txt", new AbortController().signal),
  ).rejects.toMatchObject({ kind: "forbidden" });
  await expect(f.files.list(f.principal, "/docs/a.txt", "token")).rejects.toMatchObject({
    kind: "bad_request",
  });
  await expect(
    f.files.content(f.principal, "/docs", new AbortController().signal),
  ).rejects.toMatchObject({ kind: "bad_request" });
  await expect(f.files.stat(f.principal, "/absent")).rejects.toMatchObject({ kind: "not_found" });
  vi.spyOn(f.storage, "list").mockResolvedValue([
    { path: "/link", name: "link", kind: "symlink", size: 0, modifiedAt: new Date(), ext: "" },
  ]);
  expect((await f.files.list(f.principal, "/", "token")).entries[0]?.readable).toBe(false);
  // Storage refuses a path through a link, and the connection says so.
  vi.spyOn(f.storage, "stat").mockRejectedValueOnce(
    new StorageError("forbidden", "symbolic links are not followed: /link"),
  );
  await expect(f.files.stat(f.principal, "/link")).rejects.toMatchObject({
    kind: "forbidden",
  });
  vi.mocked(f.storage.list).mockRejectedValue(new StorageError("forbidden", "revoked"));
  await expect(f.files.list(f.principal, "/", "token")).rejects.toMatchObject({
    kind: "forbidden",
  });
});

it("reads every entry with one stat and never lists its ancestors", async () => {
  const f = await fixture();
  const deep = "/docs/deep/er/c.txt";
  await f.storage.upload(deep, new TextEncoder().encode("charlie"), { mkdirParents: true });
  const list = vi.spyOn(f.storage, "list");
  const stat = vi.spyOn(f.storage, "stat");
  const signal = new AbortController().signal;
  expect(await f.files.stat(f.principal, deep)).toMatchObject({
    path: deep,
    kind: "file",
    size: 7,
  });
  await f.files.content(f.principal, deep, signal);
  await f.files.versions(f.principal, [deep, "/docs/a.txt"], signal);
  expect(list).not.toHaveBeenCalled();
  expect(stat.mock.calls).toEqual([[deep], [deep], [deep], ["/docs/a.txt"]]);
  // A listing reads the folder itself and nothing above it.
  await f.files.list(f.principal, "/docs/deep/er", "token");
  expect(list.mock.calls).toEqual([["/docs/deep/er"]]);
  // Another spelling of a stored name, as a disk that ignores case finds it, is not that item.
  stat.mockResolvedValueOnce({
    kind: "file",
    size: 5,
    modifiedAt: null,
    contentType: null,
    path: "/docs/a.txt",
  });
  await expect(f.files.stat(f.principal, "/docs/A.txt")).rejects.toMatchObject({
    kind: "not_found",
  });
});

it("refuses every read that reaches its item through a symbolic link, at any segment", async () => {
  const f = await fixture();
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-links-")));
  desktopDirectories.push(root);
  const home = join(root, "alice");
  await mkdir(join(home, "docs", "sub"), { recursive: true });
  await mkdir(join(home, ".fdrive-desktop", "state"), { recursive: true });
  await writeFile(join(home, "docs", "a.txt"), "alpha");
  await writeFile(join(home, "docs", "sub", "b.txt"), "bravo");
  await writeFile(join(home, ".fdrive-desktop", "state", "secret.txt"), "secret");
  await writeFile(join(root, "outside.txt"), "outside");
  // Into a folder fdrive keeps to itself, into an ordinary folder, and as the last segment.
  await symlink(join(home, ".fdrive-desktop"), join(home, "docs", "desk"));
  await symlink(join(home, "docs"), join(home, "alias"));
  await symlink(join(home, "docs", "sub"), join(home, "docs", "inner"));
  await symlink(join(home, "docs", "a.txt"), join(home, "a-link.txt"));
  await symlink(join(root, "outside.txt"), join(home, "out.txt"));
  await symlink(join(root, "nowhere"), join(home, "dangling"));
  const signal = new AbortController().signal;
  const full = { mode: "full" as const, paths: ["/"] };
  const writes = createDesktopWrites({
    ...f.deps,
    repo: memoryRepo().repo,
    // Only reads here; nothing is staged.
    storageForIdentity: async () => createMemoryStorage({}),
  });
  const refuses = async (principal: Principal, folders: string[], files: string[]) => {
    const writer = { ...principal, tokenAccess: full };
    for (const path of [...folders, ...files])
      await expect(f.files.stat(principal, path)).rejects.toMatchObject({ kind: "forbidden" });
    for (const path of folders) {
      await expect(f.files.list(principal, path, "token")).rejects.toMatchObject({
        kind: "forbidden",
      });
      expect((await writes.check(writer, [{ path, token: "v1:x" }], signal)).folders).toEqual([
        { path, status: "forbidden" },
      ]);
    }
    for (const path of files) {
      await expect(f.files.content(principal, path, signal)).rejects.toMatchObject({
        kind: "forbidden",
      });
      await expect(f.files.versions(principal, [path], signal)).rejects.toMatchObject({
        kind: "forbidden",
      });
    }
  };
  const own = { ...f.principal, storage: createLocalStorage({ home }) };
  await refuses(
    own,
    ["/docs/desk", "/docs/desk/state", "/alias", "/alias/sub", "/docs/inner"],
    ["/docs/desk/state/secret.txt", "/alias/a.txt", "/docs/inner/b.txt", "/a-link.txt"],
  );
  await expect(f.files.stat(own, "/out.txt")).rejects.toMatchObject({ kind: "forbidden" });
  await expect(f.files.stat(own, "/dangling")).rejects.toMatchObject({ kind: "forbidden" });
  // Listings show every link as one, unreadable, and the real paths still read.
  const kinds = async (principal: Principal, path: string) =>
    Object.fromEntries(
      (await f.files.list(principal, path, "token")).entries.map((entry) => [
        entry.name,
        `${entry.kind}${entry.readable ? "" : " (unreadable)"}`,
      ]),
    );
  expect(await kinds(own, "/")).toEqual({
    "a-link.txt": "symlink (unreadable)",
    alias: "symlink (unreadable)",
    dangling: "symlink (unreadable)",
    docs: "dir",
    "out.txt": "symlink (unreadable)",
  });
  expect(await kinds(own, "/docs")).toEqual({
    "a.txt": "file",
    desk: "symlink (unreadable)",
    inner: "symlink (unreadable)",
    sub: "dir",
  });
  expect(
    await new Response((await f.files.content(own, "/docs/sub/b.txt", signal)).body).text(),
  ).toBe("bravo");
  // The same holds inside a folder someone shares.
  await mkdir(join(root, "bob"));
  const shared = {
    ...f.principal,
    storage: createUserStorage({
      home: join(root, "bob"),
      shared: async () => [
        { name: "Docs", dir: join(home, "docs"), ownerHome: home, writable: false },
      ],
    }),
  };
  const docs = `/${SHARED_WITH_ME}/Docs`;
  await refuses(shared, [`${docs}/inner`, `${docs}/desk`], [`${docs}/inner/b.txt`]);
  expect(await kinds(shared, docs)).toMatchObject({
    desk: "symlink (unreadable)",
    inner: "symlink (unreadable)",
    sub: "dir",
  });
  expect(await f.files.stat(shared, `${docs}/sub/b.txt`)).toMatchObject({ kind: "file" });
});

it("detects equal-size replacements, rejects short streams and releases validation after cancellation", async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const first = await f.files.versions(f.principal, ["/docs/a.txt"], signal);
  await f.storage.upload("/docs/a.txt", new TextEncoder().encode("bravo"), { overwrite: true });
  expect((await f.files.versions(f.principal, ["/docs/a.txt"], signal)).items[0]?.version).not.toBe(
    first.items[0]?.version,
  );
  await expect(f.files.versions(f.principal, ["/docs"], signal)).rejects.toMatchObject({
    kind: "bad_request",
  });
  const original = f.storage.download;
  vi.spyOn(f.storage, "download").mockImplementation(async (path, options) => ({
    ...(await original(path, options)),
    contentLength: 999,
  }));
  await expect(f.files.versions(f.principal, ["/docs/a.txt"], signal)).rejects.toMatchObject({
    kind: "upstream_unavailable",
  });
  vi.mocked(f.storage.download).mockImplementation(original);
  const abort = new AbortController();
  abort.abort();
  await expect(f.files.versions(f.principal, ["/docs/a.txt"], abort.signal)).rejects.toThrow();
  const results = await Promise.allSettled(
    [1, 2].map(() => f.files.versions(f.principal, ["/docs/a.txt"], signal)),
  );
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
});

it("requires explicit write approval and never upgrades protocol-1 credentials", async () => {
  const f = await fixture();
  const legacy = f.pairing.create("Old Mac", "legacy");
  await expect(f.pairing.approve(legacy.id, f.owner, "full")).rejects.toMatchObject({
    kind: "bad_request",
  });
  const modern = f.pairing.create("New Mac", "modern", 2);
  expect(f.pairing.info(modern.id)).toMatchObject({ supportsWrites: true });
  await f.pairing.approve(modern.id, f.owner, "full");
  const result = await f.pairing.poll(modern.id, modern.secret);
  if (result.status !== "connected") throw new Error("Expected credentials");
  const first = result.credentials[0];
  if (!first) throw new Error("Expected a credential");
  expect((await f.pairing.resolve(first.token))?.tokenAccess?.mode).toBe("full");
  const read = await f.connect("read", 2);
  expect((await f.pairing.resolve(read.token))?.tokenAccess?.mode).toBe("read");
  // A requested write grant does not manufacture unsupported backend capabilities.
  expect(first.location).toMatchObject({ protocolVersion: 2, readOnly: true });
  expect(
    (await f.request("/location", undefined, { authorization: `Bearer ${first.token}` })).status,
  ).toBe(401);
  expect(await createResolveTokenPrincipal(f.deps)(first.token)).toBeNull();
});

it("rolls back the write credential when pairing expires or its login disappears during issuance", async () => {
  for (const fault of ["creation", "identity"] as const) {
    const f = await fixture(true);
    const pair = f.pairing.create("Mac", "test", 2);
    await f.pairing.approve(pair.id, f.owner, "full");
    const create = f.repos.apiTokens.create.bind(f.repos.apiTokens);
    vi.spyOn(f.repos.apiTokens, "create").mockImplementation(async (input) => {
      const token = await create(input);
      if (fault === "creation") f.advance(16 * 60_000);
      else vi.spyOn(f.repos.identities, "get").mockResolvedValue(null);
      return token;
    });
    await expect(f.pairing.poll(pair.id, pair.secret)).rejects.toMatchObject({
      kind: fault === "identity" ? "unauthorized" : "not_found",
    });
    expect(await f.repos.apiTokens.listByAccount(f.account.id)).toEqual([]);
  }
});

it("cancels an in-flight write credential issuance and tolerates a broken validation stream", async () => {
  const f = await fixture(true);
  const pair = f.pairing.create("Mac", "cancel", 2);
  await f.pairing.approve(pair.id, f.owner, "full");
  let release: (() => void) | undefined;
  let announce: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const create = f.repos.apiTokens.create.bind(f.repos.apiTokens);
  vi.spyOn(f.repos.apiTokens, "create").mockImplementation(async (input) => {
    announce?.();
    await blocked;
    return create(input);
  });
  const issuing = f.pairing.poll(pair.id, pair.secret);
  const rejection = expect(issuing).rejects.toMatchObject({ kind: "not_found" });
  await entered;
  const cancellation = f.pairing.cancel(pair.id, pair.secret);
  release?.();
  await cancellation;
  await rejection;
  expect(await f.repos.apiTokens.listByAccount(f.account.id)).toEqual([]);
  const download = f.storage.download.bind(f.storage);
  vi.spyOn(f.storage, "download").mockImplementation(async (...args) => ({
    ...(await download(...args)),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("Broken content stream"));
      },
    }),
  }));
  await expect(
    f.files.versions(f.principal, ["/docs/a.txt"], new AbortController().signal),
  ).rejects.toThrow("Broken content stream");
});

it("applies CSRF and browser ownership to v2 pairing while keeping v1 requests unchanged", async () => {
  const f = await fixture();
  const base = "/api/v2/desktop";
  expect(
    (
      await f.app.request(`${base}/pairings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceName: "Mac" }),
      })
    ).status,
  ).toBe(403);
  const created = await f.app.request(`${base}/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
    body: JSON.stringify({ deviceName: "Mac" }),
  });
  expect(created.status).toBe(201);
  const pair = DesktopPairing.parse(await created.json());
  expect(
    await (
      await f.request(`/pairings/${pair.id}`, undefined, { cookie: "fdrive_session=test" })
    ).json(),
  ).toMatchObject({ supportsWrites: true });
  expect(
    (
      await f.request(
        `/pairings/${pair.id}/approve`,
        { access: "full" },
        { cookie: "fdrive_session=test" },
      )
    ).status,
  ).toBe(200);
  const polled = await f.app.request(`${base}/pairings/${pair.id}/poll`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
    body: JSON.stringify({ secret: pair.secret }),
  });
  const result = (await polled.json()) as {
    credentials: { token: string; location: { protocolVersion: number } }[];
  };
  expect(result.credentials[0]?.location.protocolVersion).toBe(2);
  const bearer = `Bearer ${result.credentials[0]?.token}`;
  expect(
    (await f.app.request(`${base}/location`, { headers: { authorization: bearer } })).status,
  ).toBe(200);
  expect(
    (await f.app.request(`${base}/location`, { headers: { cookie: "fdrive_session=test" } }))
      .status,
  ).toBe(401);
  expect(
    (
      await f.app.request(`${base}/disconnect`, {
        method: "POST",
        headers: { authorization: bearer, "x-requested-with": "fdrive" },
      })
    ).status,
  ).toBe(200);
  expect(
    (await f.app.request(`${base}/location`, { headers: { authorization: bearer } })).status,
  ).toBe(401);
});

it("keeps no administrator recovery routes: commits resolve themselves", async () => {
  const f = await fixture(true);
  Object.assign(f.principal, { isAdmin: true, tokenAccess: undefined });
  const admin = { cookie: "fdrive_session=test" };
  expect((await f.request("/recovery", undefined, admin)).status).toBe(404);
  expect(
    (
      await f.request(
        `/recovery/${f.identity.id}/${randomUUID()}/resolve`,
        { outcome: "published" },
        admin,
      )
    ).status,
  ).toBe(404);
});

it("confirms a write-capable pairing through the v2 routes", async () => {
  const f = await fixture(true);
  const base = "/api/v2/desktop";
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    f.app.request(base + route, {
      method: "POST",
      headers: { "x-requested-with": "fdrive", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const request = DesktopPairing.parse(
    await (await post("/pairings", { deviceName: "Mac" })).json(),
  );
  expect(
    (
      await f.request(
        `/pairings/${request.id}/approve`,
        { access: "full" },
        { cookie: "fdrive_session=test" },
      )
    ).status,
  ).toBe(200);
  expect((await post(`/pairings/${request.id}/confirm`, { secret: request.secret })).status).toBe(
    409,
  );
  expect((await post(`/pairings/${request.id}/poll`, { secret: request.secret })).status).toBe(200);
  expect((await post(`/pairings/${request.id}/confirm`, { secret: request.secret })).status).toBe(
    200,
  );
});

it("expires unconfirmed pairings on its own timer without another request", async () => {
  vi.useFakeTimers();
  try {
    const f = await fixture();
    const pair = f.pairing.create("Mac", "owner");
    await f.pairing.approve(pair.id, f.owner, "read");
    expect((await f.pairing.poll(pair.id, pair.secret)).status).toBe("connected");
    expect(await f.repos.apiTokens.listByAccount(f.account.id)).toHaveLength(1);
    f.advance(300_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await f.pairing.sweep();
    expect(await f.repos.apiTokens.listByAccount(f.account.id)).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

it("writes with a full grant and nothing else, and reads with a read grant", async () => {
  const f = await fixture();
  async function location(mode: "full" | "read", wired = true) {
    const pairing = createDesktopPairing({
      ...f.deps,
      ...(wired
        ? {
            writeCapabilities: (principal: Principal) =>
              principal.tokenAccess?.mode === "full" ? ALL_WRITES : NO_WRITES,
          }
        : {}),
    });
    const pair = pairing.create("Mac", "access", 2);
    await pairing.approve(pair.id, f.owner, mode);
    const result = await pairing.poll(pair.id, pair.secret);
    if (result.status !== "connected") throw new Error("Expected credentials");
    return result.credentials[0]?.location;
  }
  expect(await location("full")).toMatchObject({
    protocolVersion: 2,
    readOnly: false,
    capabilities: ALL_WRITES,
    listingChecks: true,
  });
  expect(await location("read")).toMatchObject({ readOnly: true, capabilities: NO_WRITES });
  // A deployment without desktop writes wired lands read-only and checks no listings.
  const unwired = await location("full", false);
  expect(unwired).toMatchObject({ readOnly: true, capabilities: NO_WRITES });
  expect(unwired).not.toHaveProperty("listingChecks");
  expect(unwired).not.toHaveProperty("writeUnavailableReason");
});

it("advertises fdrive's 16 GiB upload limit to every writable location", async () => {
  const f = await fixture();
  const pair = f.pairing.create("Mac", "limits", 2);
  await f.pairing.approve(pair.id, f.owner, "full");
  const result = await f.pairing.poll(pair.id, pair.secret);
  if (result.status !== "connected") throw new Error("Expected credentials");
  expect(result.credentials[0]?.location).toMatchObject({ maxUploadBytes: 16 * 1024 ** 3 });
});
