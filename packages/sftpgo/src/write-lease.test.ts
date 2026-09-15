import type { StorageProvider, StorageSession } from "@fdrive/core";
import { afterEach, expect, it, vi } from "vitest";
import { createSftpgoClient } from "./client.js";
import { createFakeSftpgoServer } from "./fake/server.js";
import { sftpgoModule } from "./module.js";
import {
  SFTPGO_LEASE_ERROR_HEADER,
  SFTPGO_LEASE_HEADER,
  SFTPGO_OPTIMISTIC_MODE,
  SFTPGO_WRITE_PROTOCOL,
  withSftpgoWriteLease,
} from "./write-lease.js";

const token = "a".repeat(64);
const baseUrl = "http://sftpgo.test/prefix";
const grant = { protocol: SFTPGO_WRITE_PROTOCOL, token, timeoutSeconds: 60 };
const leaseUrl = `${baseUrl}/api/v2/user/fdrive/lease`;
afterEach(() => vi.useRealTimers());

async function fixture(lease?: (init: RequestInit) => Response | Promise<Response>) {
  const fake = createFakeSftpgoServer({
    users: [{ username: "alice", password: "secret", permissions: { "/": ["*"] } }],
    files: { alice: { "/original.txt": "original" } },
  });
  const jwt = await createSftpgoClient({ baseUrl: "http://sftpgo.test", fetch: fake.fetch }).login({
    username: "alice",
    password: "secret",
  });
  const calls: {
    url: string;
    method: string;
    headers: Headers;
    signal: AbortSignal | null | undefined;
  }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      signal: init.signal,
    });
    if (String(input) === leaseUrl)
      return lease
        ? lease(init)
        : init.method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json(grant);
    // The fake receives an unprefixed path, mirroring a reverse proxy.
    return fake.fetch(String(input).replace("/prefix/api/", "/api/"), init);
  };
  const options = {
    baseUrl,
    fetch,
    withToken: async <T>(fn: (jwt: string) => Promise<T>) => fn(jwt.accessToken),
  };
  const session: StorageSession = {
    externalUsername: "alice",
    getCredential: async () => ({ password: "secret" }),
    getToken: async () => jwt.accessToken,
    invalidateToken: async () => {},
  };
  return { options, calls, session };
}

it("is opt-in and never exposes leases for stock or unknown modes", async () => {
  const f = await fixture();
  for (const mode of [undefined, "", "optimistic", "apache-webdav-exclusive"]) {
    expect(
      sftpgoModule.createStorage(
        { id: "p", baseUrl, config: { desktopWriteMode: mode } },
        f.session,
        { fetch: f.options.fetch },
      ).withWriteLease,
    ).toBeUndefined();
  }
  const storage = sftpgoModule.createStorage(
    { id: "p", baseUrl, config: { desktopWriteMode: SFTPGO_WRITE_PROTOCOL } },
    f.session,
    { fetch: f.options.fetch },
  );
  expect(storage.withWriteLease).toBeTypeOf("function");
  await storage.withWriteLease?.((scoped) => scoped.list("/"));
  expect(f.calls.map((c) => c.method)).toEqual(["POST", "GET", "DELETE"]);
});

it("binds bearer and opaque lease to every scoped call, preserves prefix, then disables captured storage", async () => {
  const f = await fixture();
  let captured: StorageProvider | undefined;
  await withSftpgoWriteLease(f.options, async (storage) => {
    captured = storage;
    expect((await storage.list("/"))[0]?.name).toBe("original.txt");
    await storage.upload("/created.txt", new TextEncoder().encode("new"), { overwrite: false });
    await storage.move("/created.txt", "/moved.txt", { overwrite: false });
  });
  expect(f.calls.every((c) => c.url.startsWith(`${baseUrl}/api/v2/user/`))).toBe(true);
  expect(f.calls[0]?.headers.get(SFTPGO_LEASE_HEADER)).toBeNull();
  for (const call of f.calls.slice(1)) {
    expect(call.headers.get(SFTPGO_LEASE_HEADER)).toBe(token);
    expect(call.headers.get("authorization")).toMatch(/^Bearer /);
  }
  const count = f.calls.length;
  await expect(captured?.deleteFile("/original.txt")).rejects.toMatchObject({ kind: "conflict" });
  expect(f.calls).toHaveLength(count);
});

it("protects existing destinations and releases when an action fails", async () => {
  const f = await fixture();
  await expect(
    withSftpgoWriteLease(f.options, async (storage) => {
      await expect(
        storage.upload("/original.txt", new Uint8Array(), { overwrite: false }),
      ).rejects.toMatchObject({ kind: "conflict" });
      await expect(
        storage.move("/absent.txt", "/original.txt", { overwrite: false }),
      ).rejects.toMatchObject({ kind: "conflict" });
      throw new Error("client failed");
    }),
  ).rejects.toThrow("client failed");
  expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  expect(f.calls.at(-1)?.method).toBe("DELETE");
});

it.each([404, 403, 409, 500, 302])("does no work when acquire returns %s", async (status) => {
  const f = await fixture(() => new Response("unavailable", { status }));
  const action = vi.fn();
  await expect(withSftpgoWriteLease(f.options, action)).rejects.toThrow();
  expect(action).not.toHaveBeenCalled();
  expect(f.calls).toHaveLength(1);
});

it.each([
  null,
  {},
  { ...grant, protocol: "optimistic" },
  { ...grant, token: "bad" },
  { ...grant, timeoutSeconds: 5 },
  { ...grant, timeoutSeconds: 3600 },
])("rejects an invalid grant %j", async (value) => {
  const f = await fixture((init) =>
    init.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(value),
  );
  const action = vi.fn();
  await expect(withSftpgoWriteLease(f.options, action)).rejects.toMatchObject({
    kind: "upstream_unavailable",
  });
  expect(action).not.toHaveBeenCalled();
  if (value && "token" in value && value.token === token)
    expect(f.calls.at(-1)?.method).toBe("DELETE");
});

it.each(["{broken", "x".repeat(4097), null])(
  "rejects malformed, oversized and missing response bodies",
  async (body) => {
    const f = await fixture(() => new Response(body));
    await expect(withSftpgoWriteLease(f.options, vi.fn())).rejects.toMatchObject({
      kind: "upstream_unavailable",
    });
  },
);

it("renews, fences requests on lease loss, and releases using an independent signal", async () => {
  const f = await fixture((init) =>
    init.method === "PATCH"
      ? new Response("lost", { status: 409 })
      : init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json(grant),
  );
  vi.useFakeTimers();
  await withSftpgoWriteLease({ ...f.options, renewIntervalMs: 20 }, async (storage) => {
    await vi.advanceTimersByTimeAsync(20);
    await expect(storage.deleteFile("/original.txt")).rejects.toMatchObject({
      kind: "upstream_unavailable",
    });
  });
  expect(f.calls.map((c) => c.method)).toEqual(["POST", "PATCH", "DELETE"]);
  expect(f.calls.at(-1)?.signal?.aborted).toBe(false);
});

it.each([false, true])(
  "fences scoped lease loss even if body cancellation fails (%s)",
  async (cancelFails) => {
    const f = await fixture();
    const cancel = vi.fn(async () => {
      if (cancelFails) throw new Error("body already aborted");
    });
    let fileSignal: AbortSignal | null | undefined;
    let fileCalls = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (String(input) === leaseUrl) return f.options.fetch(input, init);
      fileCalls++;
      fileSignal = init?.signal;
      return new Response(new ReadableStream({ cancel }), {
        status: 409,
        headers: { [SFTPGO_LEASE_ERROR_HEADER]: "invalid-or-expired" },
      });
    };
    vi.useFakeTimers();
    await withSftpgoWriteLease({ ...f.options, fetch }, async (storage) => {
      await expect(storage.list("/")).rejects.toMatchObject({ kind: "upstream_unavailable" });
      expect(fileSignal?.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
      await expect(storage.upload("/later.txt", new Uint8Array())).rejects.toMatchObject({
        kind: "upstream_unavailable",
      });
      expect(fileCalls).toBe(1);
    });
    expect(f.calls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
    expect(f.calls.at(-1)?.signal?.aborted).toBe(false);
  },
);

it.each([
  [409, undefined, "conflict"],
  [409, "unknown", "conflict"],
  [403, "invalid-or-expired", "forbidden"],
] as const)("preserves ordinary storage errors (%s, %s)", async (status, marker, kind) => {
  const f = await fixture();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input) === leaseUrl) return f.options.fetch(input, init);
    return Response.json(
      { message: "ordinary failure" },
      { status, headers: marker ? { [SFTPGO_LEASE_ERROR_HEADER]: marker } : {} },
    );
  };
  await withSftpgoWriteLease({ ...f.options, fetch }, async (storage) => {
    await expect(storage.list("/")).rejects.toMatchObject({ kind });
    // An ordinary conflict/permission failure must not abort the lease scope.
    await expect(storage.list("/")).rejects.toMatchObject({ kind });
  });
});

it("rejects a changed renewal token and never renews after scope completion", async () => {
  const f = await fixture((init) =>
    Response.json(init.method === "PATCH" ? { ...grant, token: "b".repeat(64) } : grant),
  );
  vi.useFakeTimers();
  await withSftpgoWriteLease({ ...f.options, renewIntervalMs: 20 }, async (storage) => {
    await vi.advanceTimersByTimeAsync(20);
    await expect(storage.list("/")).rejects.toMatchObject({ kind: "upstream_unavailable" });
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(f.calls.map((c) => c.method)).toEqual(["POST", "PATCH", "DELETE"]);
  expect(f.calls.at(-1)?.headers.get(SFTPGO_LEASE_HEADER)).toBe(token);
});

it("cancels caller work without preventing release and never replays when release fails", async () => {
  const f = await fixture((init) =>
    init.method === "DELETE" ? Promise.reject(new Error("offline")) : Response.json(grant),
  );
  const controller = new AbortController();
  const result = await withSftpgoWriteLease(
    { ...f.options, signal: controller.signal },
    async (storage) => {
      controller.abort(new Error("cancelled"));
      await expect(storage.list("/")).rejects.toThrow("cancelled");
      return "completed";
    },
  );
  expect(result).toBe("completed");
  expect(f.calls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
  await expect(
    withSftpgoWriteLease({ ...f.options, signal: controller.signal }, vi.fn()),
  ).rejects.toThrow("cancelled");
});

it("offers optimistic publication for stock SFTPGo without ever issuing a lease", async () => {
  const f = await fixture();
  const stock = sftpgoModule.createStorage(
    { id: "p", baseUrl, config: { desktopWriteMode: SFTPGO_OPTIMISTIC_MODE } },
    f.session,
    { fetch: f.options.fetch },
  );
  expect(stock.withWriteLease).toBeUndefined();
  expect(stock.optimisticPublish).toBe(true);
  // A blank, unknown or near-miss mode stays read-only rather than degrading to it.
  for (const mode of [undefined, "", "optimistic", "fdrive-local-v2"]) {
    expect(
      sftpgoModule.createStorage(
        { id: "p", baseUrl, config: { desktopWriteMode: mode } },
        f.session,
        {
          fetch: f.options.fetch,
        },
      ).optimisticPublish,
    ).toBeUndefined();
  }
  expect(f.calls).toEqual([]);
});
