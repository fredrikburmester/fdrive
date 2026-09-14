import { afterEach, expect, it, vi } from "vitest";
import { createFakeWebdavServer } from "./fake/server.js";
import { createWebdavModule } from "./module.js";
import type { WebdavUserApi } from "./types.js";
import { withWebdavWriteLease } from "./write-lease.js";

const token = "<opaquelocktoken:lease-test>";
const credential = { username: "alice", password: "test" };
const xml = (timeout = "Second-60", scope = "exclusive") =>
  `<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:lockscope><D:${scope}/></D:lockscope><D:locktype><D:write/></D:locktype><D:depth>infinity</D:depth><D:timeout>${timeout}</D:timeout></D:activelock></D:lockdiscovery></D:prop>`;
function fixture() {
  const server = createFakeWebdavServer({
    origin: "http://dav.test",
    users: [credential],
    prefix: "/dav",
    files: { "/existing": "old" },
  });
  const requests: Array<{ url: string; method: string; headers: Headers }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const method = init?.method ?? "GET";
    requests.push({ url: String(url), method, headers: new Headers(init?.headers) });
    return method === "LOCK"
      ? new Response(xml(), { status: 200, headers: { Server: "Apache/2.4", "Lock-Token": token } })
      : method === "UNLOCK"
        ? new Response(null, { status: 204 })
        : server.fetch(url, init);
  });
  return { requests, fetch, options: { baseUrl: "http://dav.test/dav/", credential, fetch } };
}
afterEach(() => {
  vi.useRealTimers();
});

it("fences existing sources/destinations, uses exclusive creation and refuses escaped clients", async () => {
  const f = fixture();
  let escaped: WebdavUserApi | undefined;
  await withWebdavWriteLease(f.options, async (client) => {
    const api = client.user(credential);
    escaped = api;
    await api.upload("/stage", new Uint8Array(), { overwrite: false });
    await api.upload("/existing", new Uint8Array());
    await api.move("/stage", "/existing", { overwrite: true });
    await api.move("/existing", "/new", { overwrite: false });
    await api.mkcol("/folder");
  });
  const put = f.requests.find((r) => r.url.endsWith("/stage") && r.method === "PUT");
  expect(put?.headers.get("If-None-Match")).toBe("*");
  expect(put?.headers.get("If")).toBe(`<http://dav.test/dav/> (${token})`);
  const move = f.requests.find((r) => r.method === "MOVE");
  expect(move?.headers.get("If")).toContain(`<http://dav.test/dav/stage> (${token})`);
  expect(move?.headers.get("If")).toContain(`<http://dav.test/dav/existing> (${token})`);
  expect(f.requests.at(-1)?.method).toBe("UNLOCK");
  await expect(escaped?.upload("/existing", new Uint8Array())).rejects.toThrow("lease has ended");
});

it("renews a lease, stops after renewal failure and releases even when the action throws", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await withWebdavWriteLease(f.options, async (client) => {
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.requests.filter((r) => r.method === "LOCK")).toHaveLength(2);
    expect(f.requests.at(-1)?.headers.get("If")).toBe(`(${token})`);
    f.fetch.mockResolvedValueOnce(new Response(null, { status: 423 }));
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(client.user(credential).upload("/file", new Uint8Array())).rejects.toThrow();
  });
  expect(f.requests.at(-1)?.method).toBe("UNLOCK");
  await expect(
    withWebdavWriteLease(f.options, async () => {
      throw Error("action failed");
    }),
  ).rejects.toThrow("action failed");
  expect(f.requests.at(-1)?.method).toBe("UNLOCK");
});

it("rejects missing, short, shared and unsupported locks before any mutation", async () => {
  for (const response of [
    new Response(null, { status: 423 }),
    new Response(null, { status: 500 }),
    new Response(xml(), { headers: { Server: "Apache/2.4" } }),
    ...[xml("Second-30"), xml("Infinite"), xml("Second-300"), xml("Second-60", "shared"), ""].map(
      (value) => new Response(value, { headers: { Server: "Apache/2.4", "Lock-Token": token } }),
    ),
    new Response(xml(), { headers: { Server: "SFTPGo", "Lock-Token": token } }),
  ]) {
    const f = fixture();
    const action = vi.fn();
    f.fetch.mockResolvedValueOnce(response);
    await expect(withWebdavWriteLease(f.options, action)).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
  }
  const f = fixture();
  await expect(
    withWebdavWriteLease({ ...f.options, signal: AbortSignal.abort() }, vi.fn()),
  ).rejects.toThrow();
  expect(f.fetch).not.toHaveBeenCalled();
});

it("does not turn failed lock release into a replayed mutation", async () => {
  const f = fixture();
  expect(
    await withWebdavWriteLease(f.options, async () => {
      f.fetch.mockRejectedValueOnce(Error("offline"));
      return "committed";
    }),
  ).toBe("committed");
});

it("only exposes the lease for explicitly qualified provider configuration", async () => {
  const f = fixture();
  const module = createWebdavModule();
  const session = {
    externalUsername: "alice",
    getCredential: async () => credential,
    getToken: async () => null,
    invalidateToken: async () => {},
  };
  const plain = module.createStorage(
    { id: "test", baseUrl: f.options.baseUrl, config: {} },
    session,
    { fetch: f.fetch },
  );
  expect(plain.withWriteLease).toBeUndefined();
  const storage = module.createStorage(
    {
      id: "test",
      baseUrl: f.options.baseUrl,
      config: { desktopWriteMode: "apache-webdav-exclusive" },
    },
    session,
    { fetch: f.fetch },
  );
  await storage.withWriteLease?.(async (leased) => {
    await leased.upload("/new", new Uint8Array(), { overwrite: false });
  }, new AbortController().signal);
  expect(f.requests.some((r) => r.method === "LOCK")).toBe(true);
});
