import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DesktopChangesResponse,
  DesktopPairing,
  DesktopWriteLocation,
  DesktopWritePairResult,
  MeResponse,
} from "@fdrive/contracts";
import { createChangeJournal, createDb } from "@fdrive/db";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import { sql } from "drizzle-orm";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { seedLocalUsers } from "./helpers/local-storage.ts";

/**
 * The Mac change feed over the deployment's files folder, a migrated Postgres
 * and the API's own journal writer: no indexer runs, so the `files` root is
 * created by hand, as the indexer would at its start. Alice shares `/docs`
 * with bob (the seed's grant), so both see her changes, each in their own
 * paths.
 */
it("answers which folders an upload, a move and a delete changed, and detects a restore", {
  timeout: 300_000,
}, async () => {
  const postgres = await startPostgres();
  const storage = await startLocalStorage({
    files: {
      alice: { "/docs/2026/plan.txt": "plan", "/archive/old.txt": "old", "/photo.jpg": "jpg" },
      bob: { "/own.txt": "bob" },
      carol: {},
    },
  });
  await seedLocalUsers(postgres.connectionString, storage);
  const database = createDb(postgres.connectionString);
  // What the indexer does when it starts: the API journals nothing for a root without a row.
  await database.db.execute(sql`insert into idx.roots (name) values ('files')`);
  const stateDir = await mkdtemp(join(tmpdir(), "fdrive-changes-"));
  const config = loadConfig({
    DATABASE_URL: postgres.connectionString,
    FDRIVE_STORAGE_ROOT: storage.root,
    FDRIVE_INDEX_ROOTS: JSON.stringify([
      { name: "files", storagePath: storage.root, indexerPath: "/srv/files" },
    ]),
    FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    FDRIVE_ADMIN_USERS: "alice",
    FDRIVE_DESKTOP_STATE_DIR: stateDir,
  });
  const composed = await composeApp(config, pino({ level: "silent" }), () => new Date());
  const send = (route: string, init: { cookie?: string; bearer?: string; body?: unknown } = {}) =>
    composed.app.request(route, {
      method: init.body === undefined ? "GET" : "POST",
      headers: {
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        "x-requested-with": "fdrive",
        "content-type": "application/json",
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const ok = async (response: Response) => {
    const text = await response.text();
    expect(response.status, text).toBeLessThan(300);
    return text === "" ? null : JSON.parse(text);
  };
  /** Signs `username` in on the web and pairs a read-and-write Mac location for them. */
  async function connect(username: string) {
    const login = await send("/api/v1/auth/login", {
      body: { credential: { username, password: `${username}-password` } },
    });
    const me = MeResponse.parse(await ok(login));
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const identityId = me.activeIdentityId ?? "";
    const pairing = DesktopPairing.parse(
      await ok(
        await send("/api/v2/desktop/pairings", { body: { deviceName: `${username}'s Mac` } }),
      ),
    );
    await ok(
      await send(`/api/v1/desktop/pairings/${pairing.id}/approve`, {
        cookie,
        body: { identityIds: [identityId], access: { [identityId]: "full" } },
      }),
    );
    const result = DesktopWritePairResult.parse(
      await ok(
        await send(`/api/v2/desktop/pairings/${pairing.id}/poll`, {
          body: { secret: pairing.secret },
        }),
      ),
    );
    if (result.status !== "connected") throw new Error("Expected a connected location");
    const bearer = result.credentials[0]?.token ?? "";
    return {
      cookie,
      location: async () =>
        DesktopWriteLocation.parse(await ok(await send("/api/v2/desktop/location", { bearer }))),
      changes: async (since?: string) =>
        DesktopChangesResponse.parse(
          await ok(
            await send(
              `/api/v2/desktop/changes${since === undefined ? "" : `?since=${encodeURIComponent(since)}`}`,
              { bearer },
            ),
          ),
        ),
    };
  }
  type Mac = Awaited<ReturnType<typeof connect>>;
  /** Waits for the journal writer, then answers `mac`'s changes since `since` and their anchor. */
  async function changed(
    mac: Mac,
    since: string,
    expected: { paths: string[]; folders: string[] },
  ) {
    let anchor = "";
    await vi.waitFor(
      async () => {
        const answer = await mac.changes(since);
        if (answer.status !== "changes") throw new Error(`expected changes, got ${answer.status}`);
        expect({ paths: answer.paths, folders: answer.folders }).toEqual(expected);
        expect(answer.more).toBe(false);
        anchor = answer.anchor;
      },
      { timeout: 10_000, interval: 50 },
    );
    return anchor;
  }
  try {
    const alice = await connect("alice");
    const bob = await connect("bob");
    expect(await alice.location()).toMatchObject({ listingChecks: true, changeFeed: true });
    // A new app starts from now: a resync, after which it checks its folders once.
    const aliceStart = await alice.changes();
    const bobStart = await bob.changes();
    expect(aliceStart.status).toBe("resync");
    expect(bobStart.status).toBe("resync");

    // An upload through the web: the file, its folder and the folder holding that.
    await ok(
      await composed.app.request("/api/v1/fs/upload?path=/docs/2026/new.txt", {
        method: "PUT",
        headers: { cookie: alice.cookie, "x-requested-with": "fdrive" },
        body: "new",
      }),
    );
    const aliceUploaded = await changed(alice, aliceStart.anchor, {
      paths: ["/docs/2026/new.txt"],
      folders: ["/docs", "/docs/2026"],
    });
    // Bob sees it where alice's shared folder shows for him.
    const bobUploaded = await changed(bob, bobStart.anchor, {
      paths: ["/Shared with me/docs/2026/new.txt"],
      folders: ["/Shared with me/docs", "/Shared with me/docs/2026"],
    });

    // A move out of the shared folder: both ends for alice, only the source for bob.
    await ok(
      await send("/api/v1/fs/move", {
        cookie: alice.cookie,
        body: { path: "/docs/2026/new.txt", target: "/archive/new.txt" },
      }),
    );
    const aliceMoved = await changed(alice, aliceUploaded, {
      paths: ["/archive/new.txt", "/docs/2026/new.txt"],
      folders: ["/", "/archive", "/docs", "/docs/2026"],
    });
    await changed(bob, bobUploaded, {
      paths: ["/Shared with me/docs/2026/new.txt"],
      folders: ["/Shared with me/docs", "/Shared with me/docs/2026"],
    });

    // A delete.
    await ok(
      await send("/api/v1/fs/delete", {
        cookie: alice.cookie,
        body: { items: [{ path: "/archive/new.txt", kind: "file" }] },
      }),
    );
    const aliceDeleted = await changed(alice, aliceMoved, {
      paths: ["/archive/new.txt"],
      folders: ["/", "/archive"],
    });

    // A change made on the disk reaches the feed once the indexer's watcher
    // journals it, which this suite does in its place.
    await writeFile(storage.path("alice", "/photo.jpg"), "edited on the host");
    expect(await alice.changes(aliceDeleted)).toMatchObject({ paths: [], folders: [] });
    await createChangeJournal(database.db).append("files", "watcher", [
      { path: "alice/photo.jpg" },
    ]);
    const aliceWatched = await changed(alice, aliceDeleted, {
      paths: ["/photo.jpg"],
      folders: ["/"],
    });

    // A restore: the journal starts again at 1 under a new epoch, and reaches
    // past the old anchor's position before the app asks again.
    await database.db.execute(sql`truncate idx.changes restart identity`);
    await database.db.execute(sql`delete from idx.change_epoch`);
    for (const name of ["a", "b", "c", "d", "e", "f"])
      await ok(
        await composed.app.request(`/api/v1/fs/upload?path=/docs/${name}.txt`, {
          method: "PUT",
          headers: { cookie: alice.cookie, "x-requested-with": "fdrive" },
          body: name,
        }),
      );
    await vi.waitFor(
      async () => expect(await createChangeJournal(database.db).end()).toBeGreaterThanOrEqual(6),
      { timeout: 10_000, interval: 50 },
    );
    const restored = await alice.changes(aliceWatched);
    expect(restored.status).toBe("resync");

    // A gap: rows after the anchor were dropped before the app read them.
    if (restored.status !== "resync") throw new Error("Expected a resync");
    const journal = createChangeJournal(database.db);
    const before = await journal.end();
    for (const name of ["g", "h"])
      await ok(
        await composed.app.request(`/api/v1/fs/upload?path=/docs/${name}.txt`, {
          method: "PUT",
          headers: { cookie: alice.cookie, "x-requested-with": "fdrive" },
          body: name,
        }),
      );
    await vi.waitFor(async () => expect(await journal.end()).toBe(before + 2), {
      timeout: 10_000,
      interval: 50,
    });
    expect((await alice.changes(restored.anchor)).status).toBe("changes");
    // Pruning keeps the newest row: everything else is gone.
    await database.db.execute(
      sql`delete from idx.changes where id < (select max(id) from idx.changes)`,
    );
    expect((await alice.changes(restored.anchor)).status).toBe("resync");
  } finally {
    await composed.close?.();
    await database.close();
    await rm(stateDir, { recursive: true, force: true });
    await storage.stop();
    await postgres.stop();
  }
});
