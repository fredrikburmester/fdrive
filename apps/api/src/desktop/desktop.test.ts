import { createHash } from "node:crypto";
import { DESKTOP_API, DesktopPairing, DesktopPairResult } from "@fdrive/contracts";
import { StorageError } from "@fdrive/core";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createMemoryStorage } from "@fdrive/testkit";
import { expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { ApiHttpError } from "../errors.js";
import { createResolveTokenPrincipal } from "../tokens/principal.js";
import { createTokenService } from "../tokens/service.js";
import { createDesktopFiles } from "./files.js";
import { createDesktopPairing } from "./pairing.js";
import { registerDesktopRoutes } from "./routes.js";

async function fixture() {
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
  const storage = createMemoryStorage({
    "/docs/a.txt": "alpha",
    "/.trash/old": "trash",
    "/hidden/b.txt": "private",
  });
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
    registerRoutes: (groups) => registerDesktopRoutes(groups, { ...deps, clientIp: () => "test" }),
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
