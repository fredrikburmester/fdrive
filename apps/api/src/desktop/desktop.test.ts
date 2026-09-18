import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_API, DesktopPairing, DesktopPairResult } from "@fdrive/contracts";
import { StorageError, type StorageProvider } from "@fdrive/core";
import type { DesktopEffectsRepo } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createMemoryStorage } from "@fdrive/testkit";
import { afterEach, expect, it, vi } from "vitest";
import { memoryRepo } from "../../test/helpers/desktop-repo.js";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { ApiHttpError } from "../errors.js";
import { createResolveTokenPrincipal } from "../tokens/principal.js";
import { createTokenService } from "../tokens/service.js";
import { createDesktopFiles } from "./files.js";
import { createDesktopPairing } from "./pairing.js";
import { registerDesktopRoutes } from "./routes.js";
import { createDesktopWrites, type DesktopWriteGate, NO_WRITES } from "./writes.js";

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
        { identityIds: [f.identity.id], access: { [f.identity.id]: "full" } },
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
  expect((await call("/operations/" + randomUUID())).status).toBe(404);
  expect((await call("/entries?path=/")).status).toBe(200);
  expect((await call("/entry?path=/docs/a.txt")).status).toBe(200);
  expect(await (await call("/content?path=/docs/a.txt")).text()).toBe("alpha");
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

const desktopDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    desktopDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(writable = false, recovery?: Pick<DesktopEffectsRepo, "status">) {
  const repos = createMemoryRepos();
  let now = new Date("2026-09-13T00:00:00Z");
  const clock = () => now;
  const account = await repos.accounts.create({ displayName: "Alice" });
  const provider = await repos.providers.ensure({
    type: "sftpgo",
    baseUrl: "https://sftpgo.invalid",
  });
  const secondProvider = await repos.providers.ensure({
    type: "webdav",
    baseUrl: "https://dav.invalid",
  });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
  const second = await repos.identities.create({
    accountId: account.id,
    providerId: secondProvider.id,
    externalUsername: "alice",
  });
  const storage: StorageProvider = createMemoryStorage({
    "/docs/a.txt": "alpha",
    "/.trash/old": "trash",
    "/hidden/b.txt": "private",
  });
  if (writable) {
    const raw = { ...storage };
    storage.withWriteLease = async (action) => action(raw);
  }
  const stateDir = writable ? await mkdtemp(join(tmpdir(), "desktop-routes-")) : undefined;
  if (stateDir) desktopDirectories.push(stateDir);
  const otherStorage = createMemoryStorage({ "/docs/a.txt": "bravo" });
  const deps = {
    ...repos,
    clock,
    storageFactory: vi.fn(async (id: string) => (id === identity.id ? storage : otherStorage)),
    trashPathForStorage: () => "/.trash",
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
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 4).toString("base64"),
    }),
    logger: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} } as never,
    version: "test",
    startedAt: new Date(0),
    connectionStatus: async () => ({
      required: false,
      providers: [{ type: "sftpgo", host: "sftpgo.invalid" }],
    }),
    principalResolver: async (c) => (c.req.header("cookie") ? principal : null),
    registerRoutes: (groups) =>
      registerDesktopRoutes(groups, {
        ...deps,
        ...(recovery ? { recovery } : {}),
        clientIp: () => "test",
        ...(stateDir
          ? { writes: createDesktopWrites({ ...deps, repo: memoryRepo().repo, stateDir }) }
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
  return {
    repos,
    deps,
    account,
    provider,
    identity,
    second,
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

it("pairs selected identities once, confines desktop credentials, and revokes only the chosen location", async () => {
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
        { identityIds: [f.identity.id] },
        { cookie: "fdrive_session=test", authorization: "Bearer nope" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.app.request(`${DESKTOP_API}/pairings/${pair.id}/approve`, {
        method: "POST",
        headers: { cookie: "fdrive_session=test", "content-type": "application/json" },
        body: JSON.stringify({ identityIds: [f.identity.id] }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request(
        `/pairings/${pair.id}/approve`,
        { identityIds: [f.identity.id, f.second.id] },
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
  expect(first.credentials).toHaveLength(2);
  const one = first.credentials[0];
  const two = first.credentials[1];
  if (!one || !two) throw new Error("Expected two credentials");
  const headers = { authorization: `Bearer ${one.token}` };
  expect(await createResolveTokenPrincipal(f.deps)(one.token)).toBeNull();
  const mcp = await createTokenService(f.deps).create(f.account.id, { name: "MCP" });
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
  ).toBe("bravo");
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

it("requires the app secret, cancels issued credentials, expires pending requests and bounds admission", async () => {
  const f = await fixture();
  const pair = f.pairing.create("Mac", "owner");
  await expect(f.pairing.poll(pair.id, "wrong")).rejects.toMatchObject({ kind: "unauthorized" });
  await expect(f.pairing.cancel(pair.id, "wrong")).rejects.toMatchObject({ kind: "unauthorized" });
  await expect(
    f.pairing.approve(pair.id, "different-account", [f.identity.id]),
  ).rejects.toMatchObject({ kind: "forbidden" });
  await f.pairing.approve(pair.id, f.account.id, [f.identity.id, f.identity.id]);
  await expect(f.pairing.approve(pair.id, f.account.id, [f.identity.id])).rejects.toMatchObject({
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
  await f.pairing.approve(pair.id, f.account.id, [f.identity.id]);
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
    { identityIds: [f.identity.id] },
    { cookie: "fdrive_session=test" },
  );
  await f.request(`/pairings/${routed.id}/poll`, { secret: routed.secret });
  expect((await f.request(`/pairings/${routed.id}/confirm`, { secret: "x" })).status).toBe(400);
  expect(
    (await f.request(`/pairings/${routed.id}/confirm`, { secret: routed.secret })).status,
  ).toBe(200);
  expect(await f.repos.apiTokens.listByAccount(f.account.id)).toHaveLength(2);
  const orphan = f.pairing.create("Mac", "owner");
  await f.pairing.approve(orphan.id, f.account.id, [f.identity.id]);
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

it("revokes only the supplied desktop credential without resolving disabled storage", async () => {
  const f = await fixture();
  const pair = f.pairing.create("Mac", "owner");
  await f.pairing.approve(pair.id, f.account.id, [f.identity.id, f.second.id]);
  const result = await f.pairing.poll(pair.id, pair.secret);
  if (result.status !== "connected") throw new Error("Expected credentials");
  const credential = result.credentials[0];
  const other = result.credentials[1];
  if (!credential || !other) throw new Error("Expected two locations");
  const mcp = await createTokenService(f.deps).create(f.account.id, { name: "MCP" });
  await f.repos.providers.update(f.provider.id, { enabled: false });
  f.deps.storageFactory.mockClear();
  f.deps.storageFactory.mockRejectedValue(
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
  expect(f.deps.storageFactory).not.toHaveBeenCalled();
  // Expiration should not prevent cleanup of a credential whose hash is still stored.
  f.advance(366 * 86_400_000);
  expect(
    (await f.request("/disconnect", {}, { authorization: `Bearer ${other.token}` })).status,
  ).toBe(200);
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

it("rolls back partial issuance and rejects ownership changes during pairing", async () => {
  const f = await fixture();
  const pair = f.pairing.create("Mac", "owner");
  await f.pairing.approve(pair.id, f.account.id, [f.identity.id, f.second.id]);
  f.deps.storageFactory.mockRejectedValueOnce(new Error("upstream offline"));
  await expect(f.pairing.poll(pair.id, pair.secret)).rejects.toThrow();
  expect(await f.repos.apiTokens.listByAccount(f.account.id)).toHaveLength(0);
  await expect(f.pairing.location({ ...f.principal, accountId: "other" })).rejects.toMatchObject({
    kind: "unauthorized",
  });
  const race = f.pairing.create("Mac", "owner");
  const approvals = await Promise.allSettled(
    [1, 2].map(() => f.pairing.approve(race.id, f.account.id, [f.identity.id])),
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
  await expect(
    f.files.stat(f.principal, `/${Array(129).fill("a").join("/")}`),
  ).rejects.toMatchObject({ kind: "bad_request" });
  vi.spyOn(f.storage, "list").mockResolvedValue([
    { path: "/link", name: "link", kind: "symlink", size: 0, modifiedAt: new Date(), ext: "" },
  ]);
  expect((await f.files.list(f.principal, "/", "token")).entries[0]?.readable).toBe(false);
  await expect(f.files.stat(f.principal, "/link/secret")).rejects.toMatchObject({
    kind: "forbidden",
  });
  vi.mocked(f.storage.list).mockRejectedValue(new StorageError("forbidden", "revoked"));
  await expect(f.files.list(f.principal, "/", "token")).rejects.toMatchObject({
    kind: "forbidden",
  });
});

it("detects equal-size replacements, rejects short streams and releases validation after cancellation", async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const first = await f.files.versions(f.principal, ["/docs/a.txt"], signal);
  await f.storage.upload("/docs/a.txt", new TextEncoder().encode("bravo"));
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

it("requires explicit per-identity write approval and never upgrades protocol-1 credentials", async () => {
  const f = await fixture();
  const legacy = f.pairing.create("Old Mac", "legacy");
  await expect(
    f.pairing.approve(legacy.id, f.account.id, [f.identity.id], {
      [f.identity.id]: "full",
    }),
  ).rejects.toMatchObject({ kind: "bad_request" });
  const modern = f.pairing.create("New Mac", "modern", 2);
  expect(f.pairing.info(modern.id)).toMatchObject({ supportsWrites: true });
  await expect(
    f.pairing.approve(modern.id, f.account.id, [f.identity.id], {
      [f.second.id]: "full",
    }),
  ).rejects.toMatchObject({ kind: "bad_request" });
  await f.pairing.approve(modern.id, f.account.id, [f.identity.id, f.second.id], {
    [f.identity.id]: "full",
  });
  const result = await f.pairing.poll(modern.id, modern.secret);
  if (result.status !== "connected") throw new Error("Expected credentials");
  const first = result.credentials[0];
  const second = result.credentials[1];
  if (!first || !second) throw new Error("Expected both identities");
  const one = await f.pairing.resolve(first.token);
  const two = await f.pairing.resolve(second.token);
  expect(one?.tokenAccess?.mode).toBe("full");
  expect(two?.tokenAccess?.mode).toBe("read");
  // A requested write grant does not manufacture unsupported backend capabilities.
  expect(first.location).toMatchObject({ protocolVersion: 2, readOnly: true });
  expect(
    (await f.request("/location", undefined, { authorization: `Bearer ${first.token}` })).status,
  ).toBe(401);
  expect(await createResolveTokenPrincipal(f.deps)(first.token)).toBeNull();
});

it("rolls back every write credential when pairing expires or its identity disappears during issuance", async () => {
  for (const fault of ["creation", "between-identities", "identity"] as const) {
    const f = await fixture(true);
    const pair = f.pairing.create("Mac", "test", 2);
    await f.pairing.approve(pair.id, f.account.id, [f.identity.id, f.second.id], {
      [f.identity.id]: "full",
    });
    if (fault === "between-identities") {
      f.deps.storageFactory.mockImplementation(async () => {
        f.advance(16 * 60_000);
        return f.storage;
      });
    } else {
      const create = f.repos.apiTokens.create.bind(f.repos.apiTokens);
      vi.spyOn(f.repos.apiTokens, "create").mockImplementation(async (input) => {
        const token = await create(input);
        if (fault === "creation") f.advance(16 * 60_000);
        else vi.spyOn(f.repos.identities, "get").mockResolvedValue(null);
        return token;
      });
    }
    await expect(f.pairing.poll(pair.id, pair.secret)).rejects.toMatchObject({
      kind: fault === "identity" ? "unauthorized" : "not_found",
    });
    expect(await f.repos.apiTokens.listByAccount(f.account.id)).toEqual([]);
  }
});

it("cancels an in-flight write credential issuance and tolerates a broken validation stream", async () => {
  const f = await fixture(true);
  const pair = f.pairing.create("Mac", "cancel", 2);
  await f.pairing.approve(pair.id, f.account.id, [f.identity.id], { [f.identity.id]: "full" });
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
        { identityIds: [f.identity.id], access: { [f.identity.id]: "full" } },
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

it("limits recovery status to administrators and returns safe bounded job details", async () => {
  const status = vi.fn(async () => [
    {
      identityId: randomUUID(),
      operationId: randomUUID(),
      attempts: 1,
      lastError: "Retry scheduled",
      createdAt: new Date(0),
      nextAttemptAt: new Date(5000),
    },
  ]);
  const f = await fixture(false, { status });
  expect((await f.request("/recovery")).status).toBe(401);
  expect((await f.request("/recovery", undefined, { cookie: "fdrive_session=test" })).status).toBe(
    403,
  );
  expect(status).not.toHaveBeenCalled();
  Object.assign(f.principal, { isAdmin: true, tokenAccess: undefined });
  const response = await f.request("/recovery", undefined, { cookie: "fdrive_session=test" });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    pending: [{ attempts: 1, nextAttemptAt: new Date(5000).toISOString() }],
  });
  const unavailable = await fixture();
  Object.assign(unavailable.principal, { isAdmin: true, tokenAccess: undefined });
  expect(
    (await unavailable.request("/recovery", undefined, { cookie: "fdrive_session=test" })).status,
  ).toBe(502);
  // Uncertain commits are listed for administrators and resolved only through storage evidence.
  const writable = await fixture(true, { status: vi.fn(async () => []) });
  const admin = { cookie: "fdrive_session=test" };
  const resolve = `/recovery/${writable.identity.id}/${randomUUID()}/resolve`;
  expect((await writable.request(resolve, { outcome: "discarded" }, admin)).status).toBe(403);
  Object.assign(writable.principal, { isAdmin: true, tokenAccess: undefined });
  expect((await writable.request(resolve, { outcome: "later" }, admin)).status).toBe(400);
  expect((await writable.request(resolve, { outcome: "discarded" }, admin)).status).toBe(404);
  expect(
    (
      await writable.request(
        `/recovery/${randomUUID()}/${randomUUID()}/resolve`,
        { outcome: "discarded" },
        admin,
      )
    ).status,
  ).toBe(404);
  expect(await (await writable.request("/recovery", undefined, admin)).json()).toEqual({
    pending: [],
    uncertain: [],
  });
  expect(
    (
      await writable.request(
        `/recovery/not-a-uuid/${randomUUID()}/resolve`,
        { outcome: "discarded" },
        admin,
      )
    ).status,
  ).toBe(400);
  Object.assign(unavailable.principal, { isAdmin: true, tokenAccess: undefined });
  expect(
    (
      await unavailable.request(
        `/recovery/${unavailable.identity.id}/${randomUUID()}/resolve`,
        { outcome: "discarded" },
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
        { identityIds: [f.identity.id], access: { [f.identity.id]: "full" } },
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
    await f.pairing.approve(pair.id, f.account.id, [f.identity.id]);
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

it("explains a read-only full grant by every unmet gate", async () => {
  const f = await fixture();
  async function reason(
    identityId: string,
    missing: readonly DesktopWriteGate[] | null,
    mode: "full" | "read" = "full",
  ) {
    const pairing = createDesktopPairing({
      ...f.deps,
      ...(missing ? { writeAvailability: async () => ({ capabilities: NO_WRITES, missing }) } : {}),
    });
    const pair = pairing.create("Mac", "reasons", 2);
    await pairing.approve(pair.id, f.account.id, [identityId], { [identityId]: mode });
    const result = await pairing.poll(pair.id, pair.secret);
    if (result.status !== "connected") throw new Error("Expected credentials");
    const location = result.credentials[0]?.location;
    expect(location).toMatchObject({ protocolVersion: 2, readOnly: true });
    return location && "writeUnavailableReason" in location
      ? location.writeUnavailableReason
      : undefined;
  }
  expect(await reason(f.identity.id, ["state_dir"])).toBe(
    "Read-only until an administrator sets FDRIVE_DESKTOP_STATE_DIR on this server.",
  );
  expect(await reason(f.identity.id, ["publish_lock"])).toBe(
    "Read-only until an administrator configures the desktop publish lock on this server.",
  );
  // Both gates unmet: naming only one would promise writes it cannot deliver.
  expect(await reason(f.second.id, ["state_dir", "publish_lock"])).toBe(
    "Read-only until an administrator sets FDRIVE_DESKTOP_STATE_DIR on this server and configures the desktop publish lock on this server.",
  );
  // A deployment without desktop writes wired says so without guessing at a cause.
  expect(await reason(f.identity.id, null)).toBe(
    "Finder writes are turned off on this server. Files stay read-only.",
  );
  // A read grant is read-only by choice and carries no reason.
  expect(await reason(f.identity.id, ["state_dir"], "read")).toBeUndefined();
});

it("advertises the smaller of fdrive's upload ceiling and what the storage can publish", async () => {
  const f = await fixture();
  async function advertised(maxPublishBytes?: number) {
    const bounded = maxPublishBytes === undefined ? f.storage : { ...f.storage, maxPublishBytes };
    const pairing = createDesktopPairing({ ...f.deps, storageFactory: vi.fn(async () => bounded) });
    const pair = pairing.create("Mac", "limits", 2);
    await pairing.approve(pair.id, f.account.id, [f.identity.id], { [f.identity.id]: "full" });
    const result = await pairing.poll(pair.id, pair.secret);
    if (result.status !== "connected") throw new Error("Expected credentials");
    const location = result.credentials[0]?.location;
    return location && "maxUploadBytes" in location ? location.maxUploadBytes : undefined;
  }
  expect(await advertised()).toBe(16 * 1024 ** 3);
  // S3's copy ceiling. Telling the Mac app 16 GiB would spend a whole transfer
  // before publication refused it and left the commit needing an administrator.
  expect(await advertised(5 * 1024 ** 3)).toBe(5 * 1024 ** 3);
});
