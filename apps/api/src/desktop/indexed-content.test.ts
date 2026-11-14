import { createHash, randomUUID } from "node:crypto";
import type { ContentStamp, Scope, StorageProvider } from "@fdrive/core";
import type { Identity, IndexedContent, IndexRef } from "@fdrive/db";
import { createMemoryStorage } from "@fdrive/testkit";
import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../auth/principal.js";
import type { VerifiedIndexScopesResult } from "../scoping/types.js";
import { createDesktopFiles } from "./files.js";
import { createIndexedContentLookup, indexedVersion } from "./indexed-content.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** A digest no file here has: answering with it proves the file was not read. */
const CLAIMED = "b".repeat(64);
const STAMP: ContentStamp = {
  size: 5,
  mtimeNs: 1_700_000_000_123_456_789n,
  ino: 42n,
  ctimeNs: 1_700_000_100_000_000_001n,
};
/** The row the indexer records after reading the file `STAMP` describes. */
function rowFor(path: string, stamp = STAMP, sha256: string | null = CLAIMED): IndexedContent {
  return {
    rootName: "files",
    path,
    size: stamp.size,
    mtimeNs: stamp.mtimeNs,
    sha256,
    inode: BigInt.asIntN(64, stamp.ino),
    ctimeNs: stamp.ctimeNs,
  };
}

describe("indexedVersion", () => {
  const row = rowFor("alice/a.txt");

  it("answers with the digest while the file still has the row's stamp", () => {
    expect(indexedVersion(row, STAMP)).toBe(CLAIMED);
  });

  it("matches an inode above 2^63, stored as the signed bigint with the same bits", () => {
    const stamp = { ...STAMP, ino: 2n ** 64n - 5n };
    expect(indexedVersion(rowFor("alice/a.txt", stamp), stamp)).toBe(CLAIMED);
    expect(rowFor("alice/a.txt", stamp).inode).toBe(-5n);
  });

  it.each([
    ["another size", { ...STAMP, size: 6 }],
    ["another modification time", { ...STAMP, mtimeNs: STAMP.mtimeNs + 1n }],
    [
      "a newer change time (rewritten with its old time put back)",
      { ...STAMP, ctimeNs: STAMP.ctimeNs + 1n },
    ],
    ["another inode (replaced by another file)", { ...STAMP, ino: 43n }],
  ])("refuses a file with %s", (_, stamp) => {
    expect(indexedVersion(row, stamp)).toBeNull();
  });

  it.each([
    ["no row", undefined],
    ["no stamp from the indexer's own read", { ...row, inode: null, ctimeNs: null }],
    ["no change time", { ...row, ctimeNs: null }],
    ["no digest", { ...row, sha256: null }],
    ["a digest that is not lowercase hex sha256", { ...row, sha256: CLAIMED.toUpperCase() }],
  ])("refuses %s", (_, candidate) => {
    expect(indexedVersion(candidate, STAMP)).toBeNull();
  });
});

const HOME: Scope = { rootName: "files", fsPrefix: "/alice", virtualPrefix: "/" };
const SHARED: Scope = {
  rootName: "files",
  fsPrefix: "/bob/Photos",
  virtualPrefix: "/Shared with me/Photos",
};
/** A second share inside the first: its files have one place, under its own name. */
const NESTED: Scope = {
  rootName: "files",
  fsPrefix: "/bob/Photos/2024",
  virtualPrefix: "/Shared with me/2024",
};

function lookup(
  rows: readonly IndexedContent[],
  scopes: VerifiedIndexScopesResult = { available: true, scopes: [HOME, SHARED, NESTED] },
  identity: Identity | null = {
    id: "identity",
    accountId: "account",
    providerId: "provider",
    externalUsername: "alice",
    createdAt: new Date(0),
    lastLoginAt: null,
  },
) {
  const contentAt = vi.fn(async (refs: readonly IndexRef[]) =>
    rows.filter((row) =>
      refs.some((ref) => ref.rootName === row.rootName && ref.path === row.path),
    ),
  );
  const verifiedIndexScopes = vi.fn(async () => scopes);
  const get = vi.fn(async () => identity);
  return {
    contentAt,
    verifiedIndexScopes,
    get,
    find: createIndexedContentLookup({
      identities: { get },
      resolver: { verifiedIndexScopes },
      index: { contentAt },
    }),
  };
}

const PRINCIPAL = { identityId: "identity" } as Principal;

describe("createIndexedContentLookup", () => {
  it("maps each path through the verified scopes, shared folders included, in one query", async () => {
    const l = lookup([
      rowFor("alice/docs/a.txt"),
      rowFor("bob/Photos/cat.jpg"),
      rowFor("bob/Photos/2024/x.jpg"),
      // A row nobody asked for is never answered with.
      rowFor("alice/docs/other.txt"),
    ]);
    const found = await l.find(PRINCIPAL, [
      "/docs/a.txt",
      "/Shared with me/Photos/cat.jpg",
      "/Shared with me/2024/x.jpg",
      // Reaches bob's 2024 folder through the outer share, but that folder's files are
      // only ever at `/Shared with me/2024`: the round trip refuses this spelling.
      "/Shared with me/Photos/2024/x.jpg",
      "/docs/missing.txt",
    ]);
    expect(l.contentAt).toHaveBeenCalledTimes(1);
    expect(l.contentAt.mock.calls[0]?.[0]).toEqual([
      { rootName: "files", path: "alice/docs/a.txt" },
      { rootName: "files", path: "bob/Photos/cat.jpg" },
      { rootName: "files", path: "bob/Photos/2024/x.jpg" },
      { rootName: "files", path: "alice/docs/missing.txt" },
    ]);
    expect([...found.keys()].sort()).toEqual([
      "/Shared with me/2024/x.jpg",
      "/Shared with me/Photos/cat.jpg",
      "/docs/a.txt",
    ]);
    expect(found.get("/Shared with me/Photos/cat.jpg")?.path).toBe("bob/Photos/cat.jpg");
  });

  it("never reaches a row outside the identity's own scopes", async () => {
    const l = lookup([rowFor("bob/secret.txt")], { available: true, scopes: [HOME] });
    // Every path lands in alice's home; `..` cannot climb out of a normalized path.
    const found = await l.find(PRINCIPAL, ["/secret.txt", "/Shared with me/Photos/cat.jpg"]);
    expect(found.size).toBe(0);
    expect(l.contentAt.mock.calls[0]?.[0]).toEqual([
      { rootName: "files", path: "alice/secret.txt" },
      { rootName: "files", path: "alice/Shared with me/Photos/cat.jpg" },
    ]);
  });

  it("asks nothing when the identity has no indexed scope, is gone, or asks for nothing", async () => {
    const unindexed = lookup([], { available: false, reason: "no_roots" });
    expect((await unindexed.find(PRINCIPAL, ["/docs/a.txt"])).size).toBe(0);
    expect(unindexed.contentAt).not.toHaveBeenCalled();

    const gone = lookup([], undefined, null);
    expect((await gone.find(PRINCIPAL, ["/docs/a.txt"])).size).toBe(0);
    expect(gone.verifiedIndexScopes).not.toHaveBeenCalled();

    const idle = lookup([]);
    expect((await idle.find(PRINCIPAL, [])).size).toBe(0);
    expect(idle.get).not.toHaveBeenCalled();

    const shadowedOnly = lookup([]);
    await shadowedOnly.find(PRINCIPAL, ["/Shared with me/Photos/2024/x.jpg"]);
    expect(shadowedOnly.contentAt).not.toHaveBeenCalled();

    // Only a shared folder's root is indexed: the home's files map nowhere.
    const sharedOnly = lookup([], { available: true, scopes: [SHARED] });
    await sharedOnly.find(PRINCIPAL, ["/docs/a.txt"]);
    expect(sharedOnly.contentAt).not.toHaveBeenCalled();
  });
});

describe("version checks answered from the index", () => {
  const signal = new AbortController().signal;

  function fixture(options: { stamps?: boolean; grant?: string[] } = {}) {
    const raw = createMemoryStorage({
      "/docs/a.txt": "alpha",
      "/docs/b.txt": "bravo",
      "/hidden/c.txt": "carol",
      "/Shared with me/Photos/cat.jpg": "meows",
    });
    // What a stat of each file shows now; a test changes one to change the file.
    const stamps = new Map<string, ContentStamp>(
      ["/docs/a.txt", "/docs/b.txt", "/hidden/c.txt", "/Shared with me/Photos/cat.jpg"].map(
        (path, index) => [path, { ...STAMP, ino: BigInt(index + 1) }],
      ),
    );
    const { contentStamp: _unstamped, ...withoutStamps } = raw;
    const storage: StorageProvider =
      options.stamps === false
        ? withoutStamps
        : {
            ...raw,
            contentStamp: async (path) => {
              const stamp = stamps.get(path);
              if (stamp === undefined) throw new Error(`no stamp for ${path}`);
              return stamp;
            },
          };
    const download = vi.spyOn(storage, "download");
    const rows = new Map<string, IndexedContent>([
      ["/docs/a.txt", rowFor("alice/docs/a.txt", stamps.get("/docs/a.txt"))],
      ["/docs/b.txt", rowFor("alice/docs/b.txt", stamps.get("/docs/b.txt"))],
      ["/hidden/c.txt", rowFor("alice/hidden/c.txt", stamps.get("/hidden/c.txt"))],
      [
        "/Shared with me/Photos/cat.jpg",
        rowFor("bob/Photos/cat.jpg", stamps.get("/Shared with me/Photos/cat.jpg")),
      ],
    ]);
    const l = lookup([...rows.values()]);
    const files = createDesktopFiles({
      clock: () => new Date(),
      trashPathForStorage: () => null,
      indexedContent: l.find,
    });
    const principal: Principal = {
      accountId: randomUUID(),
      identityId: "identity",
      username: "alice",
      isAdmin: false,
      storage,
      tokenAccess: { mode: "read", paths: options.grant ?? ["/"] },
    };
    const versions = async (paths: string[]) =>
      (await files.versions(principal, paths, signal)).items;
    return { stamps, download, rows, l, versions };
  }

  it("answers an indexed file from its row without reading it", async () => {
    const f = fixture();
    expect(await f.versions(["/docs/a.txt", "/Shared with me/Photos/cat.jpg"])).toEqual([
      { path: "/docs/a.txt", size: 5, version: CLAIMED },
      { path: "/Shared with me/Photos/cat.jpg", size: 5, version: CLAIMED },
    ]);
    expect(f.download).not.toHaveBeenCalled();
    expect(f.l.contentAt).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["size", (s: ContentStamp) => ({ ...s, size: s.size + 1 })],
    ["modification time", (s: ContentStamp) => ({ ...s, mtimeNs: s.mtimeNs + 1n })],
    ["change time", (s: ContentStamp) => ({ ...s, ctimeNs: s.ctimeNs + 1n })],
    ["inode", (s: ContentStamp) => ({ ...s, ino: s.ino + 100n })],
  ])("hashes a file whose %s no longer matches its row", async (_, change) => {
    const f = fixture();
    f.stamps.set("/docs/b.txt", change(f.stamps.get("/docs/b.txt") as ContentStamp));
    expect(await f.versions(["/docs/a.txt", "/docs/b.txt"])).toEqual([
      { path: "/docs/a.txt", size: 5, version: CLAIMED },
      { path: "/docs/b.txt", size: 5, version: sha("bravo") },
    ]);
    expect(f.download).toHaveBeenCalledTimes(1);
  });

  it("hashes a file without a live row, or whose row no read of the indexer stamped", async () => {
    const f = fixture();
    f.rows.clear();
    const unstamped = lookup([{ ...rowFor("alice/docs/a.txt"), inode: null, ctimeNs: null }]);
    const files = createDesktopFiles({
      clock: () => new Date(),
      trashPathForStorage: () => null,
      indexedContent: unstamped.find,
    });
    const storage: StorageProvider = {
      ...createMemoryStorage({ "/docs/a.txt": "alpha" }),
      contentStamp: async () => STAMP,
    };
    const principal = { ...PRINCIPAL, storage, tokenAccess: { mode: "read", paths: ["/"] } };
    expect((await files.versions(principal as Principal, ["/docs/a.txt"], signal)).items).toEqual([
      { path: "/docs/a.txt", size: 5, version: sha("alpha") },
    ]);
    const empty = lookup([]);
    const none = createDesktopFiles({
      clock: () => new Date(),
      trashPathForStorage: () => null,
      indexedContent: empty.find,
    });
    expect((await none.versions(principal as Principal, ["/docs/a.txt"], signal)).items).toEqual([
      { path: "/docs/a.txt", size: 5, version: sha("alpha") },
    ]);
  });

  it("hashes everything, asking the index nothing, where storage has no stamps", async () => {
    const f = fixture({ stamps: false });
    expect(await f.versions(["/docs/a.txt"])).toEqual([
      { path: "/docs/a.txt", size: 5, version: sha("alpha") },
    ]);
    expect(f.l.get).not.toHaveBeenCalled();
  });

  it("looks up only paths the connection may read, and still refuses the others in turn", async () => {
    const f = fixture({ grant: ["/docs"] });
    await expect(f.versions(["/docs/a.txt", "/hidden/c.txt", "\0"])).rejects.toMatchObject({
      kind: "forbidden",
    });
    expect(f.l.contentAt.mock.calls[0]?.[0]).toEqual([
      { rootName: "files", path: "alice/docs/a.txt" },
    ]);
    expect(f.download).not.toHaveBeenCalled();
  });

  it("still refuses what is not a file before consulting its row", async () => {
    const f = fixture();
    await expect(f.versions(["/docs"])).rejects.toMatchObject({ kind: "bad_request" });
  });
});
