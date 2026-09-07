import {
  AccountFavoritesResponse,
  AccountSearchResponse,
  MeResponse,
  ROUTES,
  type SearchHit,
} from "@fdrive/contracts";
import { StorageError } from "@fdrive/core";
import type { Identity } from "@fdrive/db";
import { expect, it, vi } from "vitest";
import { createMemoryStorage } from "../../test/fixtures/memory-storage.js";
import { ApiHttpError } from "../errors.js";
import { accountsHarness, cookieFrom } from "./test-fixtures/index.ts";
import { mapAccountIdentities } from "./views.ts";

function hit(path = "/report.txt", score = 1): SearchHit {
  return {
    path,
    name: path.slice(1),
    kind: "file",
    ext: ".txt",
    mime: "text/plain",
    size: 1,
    modifiedAt: "2026-09-07T00:00:00Z",
    score,
    snippets: [],
    hasThumbnail: false,
  };
}
async function linkedHarness() {
  const h = accountsHarness();
  const a = await h.login();
  const response = await h.call(ROUTES.account.identities, {
    method: "POST",
    cookie: a.cookie,
    body: { username: "bob", password: "bob-pass" },
  });
  const me = MeResponse.parse(await response.json());
  return {
    ...h,
    cookie: cookieFrom(response),
    a: a.me.activeIdentityId,
    b: me.activeIdentityId,
    accountId: me.account.id,
  };
}
it("keeps same-path favorites and search hits separate by identity", async () => {
  const h = await linkedHarness();
  await h.repos.favorites.add(h.a, "/report.txt", "file");
  await h.repos.favorites.add(h.b, "/report.txt", "file");
  const favorites = AccountFavoritesResponse.parse(
    await (await h.call(ROUTES.account.favorites, { cookie: h.cookie })).json(),
  );
  expect(favorites.items.map((item) => item.identityId).sort()).toEqual([h.a, h.b].sort());
  expect(favorites.unavailableIdentityIds).toEqual([]);
  const search = vi.spyOn(h.deps, "searchForIdentity").mockImplementation(async (identity) => ({
    query: "report",
    sections: { folders: [], files: [hit()], content: [hit()] },
    degraded: identity.id === h.a,
    unavailable: false,
    tookMs: 1,
  }));
  const result = AccountSearchResponse.parse(
    await (await h.call(`${ROUTES.account.search}?q=report`, { cookie: h.cookie })).json(),
  );
  expect(result.sections.files.map((item) => item.identityId).sort()).toEqual([h.a, h.b].sort());
  expect(result.sections.content).toHaveLength(2);
  expect(result.degraded).toBe(true);
  expect(result.unavailable).toBe(false);
  expect(search.mock.calls.every(([identity]) => identity.accountId === h.accountId)).toBe(true);
});
it("reports unavailable identities and omits their cached content on permission failure", async () => {
  const h = await linkedHarness();
  await h.repos.favorites.add(h.a, "/report.txt", "file");
  await h.repos.favorites.add(h.b, "/report.txt", "file");
  vi.spyOn(h.deps, "storageForIdentity").mockImplementation(async (identity) => {
    if (identity.id === h.b) throw new StorageError("forbidden", "denied");
    return h.storageFactory(identity.id);
  });
  vi.spyOn(h.deps, "searchForIdentity").mockResolvedValue({
    query: "report",
    sections: { folders: [], files: [hit()], content: [hit()] },
    degraded: false,
    unavailable: false,
    tookMs: 0,
  });
  const favorites = AccountFavoritesResponse.parse(
    await (await h.call(ROUTES.account.favorites, { cookie: h.cookie })).json(),
  );
  expect(favorites.items).toHaveLength(1);
  expect(favorites.unavailableIdentityIds).toEqual([h.b]);
  const search = AccountSearchResponse.parse(
    await (await h.call(`${ROUTES.account.search}?q=report`, { cookie: h.cookie })).json(),
  );
  expect(search.sections.files).toHaveLength(1);
  expect(search.unavailableIdentityIds).toEqual([h.b]);
  expect(search.degraded).toBe(true);
});
it("requires permission to enter a directory, rejects changed kinds, and propagates unknown failures safely", async () => {
  const h = await linkedHarness();
  const storage = createMemoryStorage({ "/docs/a": "a", "/report.txt": "a" });
  vi.spyOn(h.deps, "storageForIdentity").mockResolvedValue(storage);
  await h.repos.favorites.add(h.a, "/docs", "dir");
  await h.repos.favorites.add(h.b, "/report.txt", "dir");
  const favorites = AccountFavoritesResponse.parse(
    await (await h.call(ROUTES.account.favorites, { cookie: h.cookie })).json(),
  );
  expect(favorites.items.map((item) => item.path)).toEqual(["/docs"]);
  expect(favorites.unavailableIdentityIds).toEqual([h.b]);
  const list = vi.spyOn(storage, "list");
  list.mockRejectedValue(new StorageError("forbidden", "directory denied"));
  const denied = AccountFavoritesResponse.parse(
    await (await h.call(ROUTES.account.favorites, { cookie: h.cookie })).json(),
  );
  expect(denied.items).toEqual([]);
  vi.spyOn(h.deps, "storageForIdentity").mockRejectedValue(new Error("private SQL error"));
  const failed = await h.call(ROUTES.account.favorites, { cookie: h.cookie });
  expect(failed.status).toBe(500);
  expect(await failed.text()).not.toContain("private SQL");
  expect((await h.call(`${ROUTES.account.search}?q=report`, { cookie: h.cookie })).status).toBe(
    500,
  );
});
it("caps and deduplicates sections, sorts deterministically, and bounds favorites", async () => {
  const h = await linkedHarness();
  const storage = createMemoryStorage(
    Object.fromEntries(Array.from({ length: 1002 }, (_, n) => [`/d/f${n}.txt`, "x"])),
  );
  vi.spyOn(h.deps, "storageForIdentity").mockResolvedValue(storage);
  const favoriteRows = Array.from({ length: 1002 }, (_, n) => ({
    identityId: h.a,
    path: `/d/f${n}.txt`,
    kind: "file" as const,
    createdAt: new Date(2026, 0, 1),
  }));
  vi.spyOn(h.repos.favorites, "list").mockImplementation(async (identityId) => [
    {
      ...favoriteRows[0],
      identityId,
      path: "/d/f0.txt",
      kind: "file",
      createdAt: new Date(2026, 0, 2),
    },
    ...favoriteRows.map((row) => ({ ...row, identityId })),
  ]);
  const favorites = AccountFavoritesResponse.parse(
    await (await h.call(ROUTES.account.favorites, { cookie: h.cookie })).json(),
  );
  expect(favorites.items).toHaveLength(1000);
  expect(new Set(favorites.items.map((item) => `${item.identityId}:${item.path}`)).size).toBe(1000);
  const files = Array.from({ length: 60 }, (_, n) => hit(`/d/f${n}.txt`, n % 3));
  vi.spyOn(h.deps, "searchForIdentity").mockResolvedValue({
    query: "f",
    sections: { folders: [], files: [files[0] ?? hit(), ...files], content: files },
    degraded: false,
    unavailable: false,
    tookMs: 0,
  });
  const result = AccountSearchResponse.parse(
    await (await h.call(`${ROUTES.account.search}?q=f&limit=50`, { cookie: h.cookie })).json(),
  );
  expect(result.sections.files).toHaveLength(50);
  expect(result.sections.content).toHaveLength(50);
  expect(result.sections.files[0]?.score).toBe(2);
  expect(new Set(result.sections.files.map((item) => `${item.identityId}:${item.path}`)).size).toBe(
    50,
  );
});
it("sorts and authorizes folder results and reports no usable search scope", async () => {
  const h = await linkedHarness();
  const storage = createMemoryStorage({ "/z/a": "x", "/a/a": "x" });
  vi.spyOn(h.deps, "storageForIdentity").mockResolvedValue(storage);
  const folder = (path: string) => ({ ...hit(path), kind: "dir" as const });
  vi.spyOn(h.deps, "searchForIdentity").mockResolvedValue({
    query: "a",
    sections: { folders: [folder("/z"), folder("/a")], files: [], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 0,
  });
  const response = AccountSearchResponse.parse(
    await (await h.call(`${ROUTES.account.search}?q=a`, { cookie: h.cookie })).json(),
  );
  expect(response.sections.folders.map((item) => item.path)).toEqual(["/a", "/a", "/z", "/z"]);
  vi.spyOn(h.deps, "searchForIdentity").mockResolvedValue({
    query: "a",
    sections: { folders: [], files: [hit()], content: [hit()] },
    degraded: false,
    unavailable: true,
    tookMs: 0,
  });
  const missing = AccountSearchResponse.parse(
    await (await h.call(`${ROUTES.account.search}?q=a`, { cookie: h.cookie })).json(),
  );
  expect(missing.unavailable).toBe(true);
  expect(missing.sections.files).toEqual([]);
  expect(missing.sections.content).toEqual([]);
  expect(missing.unavailableIdentityIds.sort()).toEqual([h.a, h.b].sort());
});
it("rechecks ownership after search before releasing results", async () => {
  const h = await linkedHarness();
  vi.spyOn(h.deps, "searchForIdentity").mockImplementation(async (identity) => {
    if (identity.id === h.b)
      vi.spyOn(h.repos.identities, "get").mockImplementation(async (id) =>
        id === h.b
          ? null
          : ((await h.repos.identities.listAll()).find((row) => row.id === id) ?? null),
      );
    return {
      query: "report",
      sections: { folders: [], files: [hit()], content: [] },
      degraded: false,
      unavailable: false,
      tookMs: 0,
    };
  });
  const result = AccountSearchResponse.parse(
    await (await h.call(`${ROUTES.account.search}?q=report`, { cookie: h.cookie })).json(),
  );
  expect(result.sections.files.map((item) => item.identityId)).toEqual([h.a]);
  expect(result.unavailableIdentityIds).toEqual([h.b]);
});
it("does not call search for injected foreign identities and treats storage API failures as partial", async () => {
  const h = await linkedHarness();
  const own = await h.repos.identities.listByAccount(h.accountId);
  const foreign = await h.login("carol");
  const identity = await h.repos.identities.get(foreign.me.activeIdentityId);
  if (!identity) throw new Error("Missing identity");
  vi.spyOn(h.repos.identities, "listByAccount").mockResolvedValue([...own, identity]);
  const search = vi
    .spyOn(h.deps, "searchForIdentity")
    .mockRejectedValue(new ApiHttpError("reauth_required", "expired"));
  const result = AccountSearchResponse.parse(
    await (await h.call(`${ROUTES.account.search}?q=report`, { cookie: h.cookie })).json(),
  );
  expect(result.unavailable).toBe(true);
  expect(search.mock.calls.every(([row]) => row.accountId === h.accountId)).toBe(true);
});
it("limits fanout to four and preserves input order even with asynchronous work", async () => {
  const identities = Array.from({ length: 12 }, (_, n) => ({ id: String(n) }) as Identity);
  let active = 0,
    max = 0;
  const result = await mapAccountIdentities(identities, async (identity) => {
    active++;
    max = Math.max(max, active);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    active--;
    return identity.id;
  });
  expect(max).toBe(4);
  expect(result).toEqual(identities.map((row) => row.id));
  expect(await mapAccountIdentities([], async () => "unused")).toEqual([]);
});
it("does not expose cached file content to an identity that can stat but cannot download", async () => {
  const h = await linkedHarness();
  const storage = createMemoryStorage({ "/report.txt": "secret" });
  vi.spyOn(storage, "download").mockRejectedValue(new StorageError("forbidden", "read denied"));
  vi.spyOn(h.deps, "storageForIdentity").mockResolvedValue(storage);
  vi.spyOn(h.deps, "searchForIdentity").mockResolvedValue({
    query: "secret",
    sections: {
      folders: [],
      files: [hit()],
      content: [{ ...hit(), snippets: [{ text: "private", ranges: [] }] }],
    },
    degraded: false,
    unavailable: false,
    tookMs: 0,
  });
  const result = AccountSearchResponse.parse(
    await (await h.call(`${ROUTES.account.search}?q=secret`, { cookie: h.cookie })).json(),
  );
  expect(result.sections.content).toEqual([]);
  expect(result.sections.files).toEqual([]);
  expect(result.unavailableIdentityIds.sort()).toEqual([h.a, h.b].sort());
});

it.each([false, true])(
  "validates a search root with its own listing, preserving allowed root files: denied=%s",
  async (denied) => {
    const h = await linkedHarness();
    vi.spyOn(h.deps, "searchForIdentity").mockResolvedValue({
      query: "report",
      sections: {
        folders: [{ ...hit("/"), name: "", kind: "dir", size: 0, ext: "", mime: null }],
        files: [hit()],
        content: [],
      },
      degraded: false,
      unavailable: false,
      tookMs: 0,
    });
    const storageA = await h.storageFactory(h.a);
    const storageB = await h.storageFactory(h.b);
    const listA = vi.spyOn(storageA, "list");
    const statA = vi.spyOn(storageA, "statFile");
    if (denied) listA.mockRejectedValue(new StorageError("forbidden", "root listing denied"));
    vi.spyOn(h.deps, "storageForIdentity").mockImplementation(async (identity) =>
      identity.id === h.a ? storageA : storageB,
    );
    const result = AccountSearchResponse.parse(
      await (await h.call(`${ROUTES.account.search}?q=report`, { cookie: h.cookie })).json(),
    );
    expect(listA).toHaveBeenCalledWith("/");
    expect(statA).not.toHaveBeenCalledWith("/");
    expect(result.sections.folders.map((item) => item.path)).toEqual(denied ? ["/"] : ["/", "/"]);
    expect(result.sections.files.map((item) => item.identityId).sort()).toEqual(
      denied ? [h.b] : [h.a, h.b].sort(),
    );
    expect(result.unavailableIdentityIds).toEqual(denied ? [h.a] : []);
    expect(result.unavailable).toBe(false);
  },
);
