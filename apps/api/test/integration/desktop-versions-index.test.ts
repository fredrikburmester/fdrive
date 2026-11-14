import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { joinPath, type Scope, type StorageProvider } from "@fdrive/core";
import { createDb, createIndexQueries, createRepos, migrate, schema } from "@fdrive/db";
import {
  createLocalModule,
  type LocalUsers,
  SHARED_WITH_ME,
  type SharedGrant,
  sharedFolderNames,
} from "@fdrive/local";
import { startPostgres } from "@fdrive/testkit";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "../../src/auth/principal.ts";
import { createIdentityStorageFactory } from "../../src/auth/storage-factory.ts";
import { createDesktopFiles } from "../../src/desktop/files.ts";
import { createIndexedContentLookup } from "../../src/desktop/indexed-content.ts";
import { memoryProviderService } from "../../src/providers/test-fixtures/index.ts";
import { createScopeResolver } from "../../src/scoping/resolver.ts";

const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
/** A digest neither file has: a version check that answers with it read nothing. */
const CLAIMED = "c".repeat(64);
/** A whole millisecond, which `utimes` can put back exactly. */
const MODIFIED = new Date("2026-03-04T05:06:07.890Z");

/**
 * Desktop version checks over a real local folder and a migrated Postgres:
 * an index row stamped the way the indexer stamps it answers without the
 * file being read, in the login's own files and in a folder shared with it,
 * and a file rewritten in place with its old modification time put back is
 * hashed again.
 */
describe("desktop version checks answered from the index", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let database: ReturnType<typeof createDb>;
  let root: string;

  async function put(path: string, contents: string): Promise<void> {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
    await utimes(target, MODIFIED, MODIFIED);
  }

  beforeAll(async () => {
    postgres = await startPostgres();
    database = createDb(postgres.connectionString);
    await migrate(database.db);
    root = await mkdtemp(join(tmpdir(), "fdrive-desktop-versions-"));
    await put("alice/report.txt", "the report");
    await put("bob/Photos/cat.txt", "meow");
  }, 180_000);

  afterAll(async () => {
    await database?.close();
    await postgres?.stop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }, 180_000);

  it("answers stamped files without reading them and hashes what changed", async () => {
    const { db } = database;
    const repos = createRepos(db);
    const grants: Record<string, readonly SharedGrant[]> = {
      alice: [{ owner: "bob", path: "/Photos", writable: false }],
    };
    const users: LocalUsers = {
      verify: async () => ({ result: "invalid" }),
      status: async () => "active",
      shared: async (username) => grants[username] ?? [],
    };
    const module = createLocalModule({ root, users, indexRoot: "files" });
    const providers = memoryProviderService(repos, { modules: { local: module } });
    const provider = await repos.providers.ensure({ type: "local", baseUrl: "local" });
    await repos.providers.update(provider.id, { enabled: true, managedByEnv: true });
    const account = await repos.accounts.create({ displayName: "alice" });
    const alice = await repos.identities.create({
      accountId: account.id,
      providerId: provider.id,
      externalUsername: "alice",
    });
    const resolver = createScopeResolver({
      providers,
      indexRootNames: ["files"],
      extraScopes: async (identity, home) => {
        const shared = await users.shared(identity.externalUsername);
        const names = sharedFolderNames(shared);
        return shared.map(
          (grant, index): Scope => ({
            rootName: home.rootName,
            fsPrefix: joinPath("/", grant.owner, grant.path),
            virtualPrefix: joinPath("/", SHARED_WITH_ME, names[index] ?? grant.owner),
          }),
        );
      },
    });
    const storageFactory = createIdentityStorageFactory({
      providers,
      fetch: globalThis.fetch,
      clock: () => new Date(),
    });
    const storage: StorageProvider = { ...(await storageFactory(alice.id)) };
    const download = vi.spyOn(storage, "download");

    // What the indexer records after reading each file once it had settled.
    const [indexRoot] = await db.insert(schema.roots).values({ name: "files" }).returning();
    if (indexRoot === undefined) throw new Error("expected the root insert to return a row");
    const rootId = indexRoot.id;
    async function indexed(path: string) {
      const info = await stat(join(root, path), { bigint: true });
      const [row] = await db
        .insert(schema.files)
        .values({
          rootId,
          path,
          name: path.slice(path.lastIndexOf("/") + 1),
          ext: ".txt",
          size: Number(info.size),
          mtimeNs: info.mtimeNs,
          sha256: CLAIMED,
          textStatus: "indexed",
          inode: BigInt.asIntN(64, info.ino),
          ctimeNs: info.ctimeNs,
        })
        .returning();
      if (row === undefined) throw new Error("expected the file insert to return a row");
      return row.id;
    }
    await indexed("alice/report.txt");
    const cat = await indexed("bob/Photos/cat.txt");

    const files = createDesktopFiles({
      clock: () => new Date(),
      trashPathForStorage: () => null,
      indexedContent: createIndexedContentLookup({
        identities: repos.identities,
        resolver,
        index: createIndexQueries(db),
      }),
    });
    const principal: Principal = {
      accountId: account.id,
      identityId: alice.id,
      username: "alice",
      isAdmin: false,
      storage,
      tokenAccess: { mode: "read", paths: ["/"] },
    };
    const versions = async (paths: string[]) =>
      (await files.versions(principal, paths, new AbortController().signal)).items;
    const shared = `/${SHARED_WITH_ME}/Photos/cat.txt`;

    expect(await versions(["/report.txt", shared])).toEqual([
      { path: "/report.txt", size: 10, version: CLAIMED },
      { path: shared, size: 4, version: CLAIMED },
    ]);
    expect(download).not.toHaveBeenCalled();

    // Other bytes of the same length, with the old modification time put back: only the
    // change time tells, and the file is read.
    await writeFile(join(root, "alice/report.txt"), "the ripost");
    await utimes(join(root, "alice/report.txt"), MODIFIED, MODIFIED);
    expect(await versions(["/report.txt", shared])).toEqual([
      { path: "/report.txt", size: 10, version: sha("the ripost") },
      { path: shared, size: 4, version: CLAIMED },
    ]);
    expect(download).toHaveBeenCalledTimes(1);

    // A row the indexer marked deleted proves nothing.
    await db.update(schema.files).set({ deletedAt: new Date() }).where(eq(schema.files.id, cat));
    expect(await versions([shared])).toEqual([{ path: shared, size: 4, version: sha("meow") }]);
    expect(download).toHaveBeenCalledTimes(2);
  });
});
