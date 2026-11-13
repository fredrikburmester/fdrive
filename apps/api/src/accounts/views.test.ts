import { AccountFavoritesResponse, MeResponse, ROUTES } from "@fdrive/contracts";
import { StorageError } from "@fdrive/core";
import type { Identity } from "@fdrive/db";
import { createMemoryStorage } from "@fdrive/testkit";
import { expect, it, vi } from "vitest";
import { ApiHttpError } from "../errors.js";
import { accountsHarness, cookieFrom } from "./test-fixtures/index.ts";
import { mapAccountIdentities } from "./views.ts";

async function linkedHarness() {
  const h = accountsHarness();
  const a = await h.login();
  const response = await h.call(ROUTES.account.identities, {
    method: "POST",
    cookie: a.cookie,
    body: {
      credential: { username: "bob", password: "bob-pass" },
      currentCredential: { password: "alice-pass" },
    },
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
it("keeps same-path favorites separate by identity", async () => {
  const h = await linkedHarness();
  await h.repos.favorites.add(h.a, "/report.txt", "file");
  await h.repos.favorites.add(h.b, "/report.txt", "file");
  const favorites = AccountFavoritesResponse.parse(
    await (await h.call(ROUTES.account.favorites, { cookie: h.cookie })).json(),
  );
  expect(favorites.items.map((item) => item.identityId).sort()).toEqual([h.a, h.b].sort());
  expect(favorites.unavailableIdentityIds).toEqual([]);
});
it("reports unavailable identities and omits their favorites on permission failure", async () => {
  const h = await linkedHarness();
  await h.repos.favorites.add(h.a, "/report.txt", "file");
  await h.repos.favorites.add(h.b, "/report.txt", "file");
  vi.spyOn(h.deps, "storageForIdentity").mockImplementation(async (identity) => {
    if (identity.id === h.b) throw new StorageError("forbidden", "denied");
    return h.storageFactory(identity.id);
  });
  const favorites = AccountFavoritesResponse.parse(
    await (await h.call(ROUTES.account.favorites, { cookie: h.cookie })).json(),
  );
  expect(favorites.items).toHaveLength(1);
  expect(favorites.unavailableIdentityIds).toEqual([h.b]);
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
});
it("deduplicates and bounds favorites", async () => {
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
});
it("rechecks ownership after reading favorites before releasing them", async () => {
  const h = await linkedHarness();
  await h.repos.favorites.add(h.a, "/report.txt", "file");
  await h.repos.favorites.add(h.b, "/report.txt", "file");
  const list = h.repos.favorites.list.bind(h.repos.favorites);
  vi.spyOn(h.repos.favorites, "list").mockImplementation(async (identityId) => {
    if (identityId === h.b)
      vi.spyOn(h.repos.identities, "get").mockImplementation(async (id) =>
        id === h.b
          ? null
          : ((await h.repos.identities.listAll()).find((row) => row.id === id) ?? null),
      );
    return list(identityId);
  });
  const result = AccountFavoritesResponse.parse(
    await (await h.call(ROUTES.account.favorites, { cookie: h.cookie })).json(),
  );
  expect(result.items.map((item) => item.identityId)).toEqual([h.a]);
  expect(result.unavailableIdentityIds).toEqual([h.b]);
});
it("does not open storage for injected foreign identities and treats storage API failures as partial", async () => {
  const h = await linkedHarness();
  const own = await h.repos.identities.listByAccount(h.accountId);
  const foreign = await h.login("carol");
  const identity = await h.repos.identities.get(foreign.me.activeIdentityId);
  if (!identity) throw new Error("Missing identity");
  vi.spyOn(h.repos.identities, "listByAccount").mockResolvedValue([...own, identity]);
  const storage = vi
    .spyOn(h.deps, "storageForIdentity")
    .mockRejectedValue(new ApiHttpError("reauth_required", "expired"));
  const result = AccountFavoritesResponse.parse(
    await (await h.call(ROUTES.account.favorites, { cookie: h.cookie })).json(),
  );
  expect(result.unavailableIdentityIds).toHaveLength(3);
  expect(storage.mock.calls.every(([row]) => row.accountId === h.accountId)).toBe(true);
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

it.each([false, true])(
  "validates a root favorite with its own listing: denied=%s",
  async (denied) => {
    const h = await linkedHarness();
    await h.repos.favorites.add(h.a, "/", "dir");
    await h.repos.favorites.add(h.b, "/", "dir");
    const storageA = await h.storageFactory(h.a);
    const storageB = await h.storageFactory(h.b);
    const listA = vi.spyOn(storageA, "list");
    const statA = vi.spyOn(storageA, "statFile");
    if (denied) listA.mockRejectedValue(new StorageError("forbidden", "root listing denied"));
    vi.spyOn(h.deps, "storageForIdentity").mockImplementation(async (identity) =>
      identity.id === h.a ? storageA : storageB,
    );
    const result = AccountFavoritesResponse.parse(
      await (await h.call(ROUTES.account.favorites, { cookie: h.cookie })).json(),
    );
    expect(listA).toHaveBeenCalledWith("/");
    expect(statA).not.toHaveBeenCalledWith("/");
    expect(result.items.map((item) => item.identityId).sort()).toEqual(
      denied ? [h.b] : [h.a, h.b].sort(),
    );
    expect(result.unavailableIdentityIds).toEqual(denied ? [h.a] : []);
  },
);
