import { rm } from "node:fs/promises";
import {
  type FsEvent,
  GrantsResponse,
  ListResponse,
  OwnedGrant,
  ROUTES,
  TrashListResponse,
} from "@fdrive/contracts";
import { createChangeWriter, createDb, createRepos } from "@fdrive/db";
import type { IndexChange } from "@fdrive/local";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { type ChangeQueue, createChangeQueue } from "../../src/local/change-queue.js";
import { LocalIndexerStack } from "./helpers/local-indexer-stack.js";
import { seedLocalUsers, silentLogger } from "./helpers/local-storage.ts";

const PASSWORD = "disposable-test-password";
const SHELF = "/Shared with me";

type Moved = Extract<IndexChange, { kind: "moved" }>;

const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";

/**
 * Folders alice shares with alice-other, then moves to Trash through fdrive,
 * with the real indexer reading each move (into `<trash>/<id>/<name>` too)
 * from the change journal, as in a deployment. A share follows its
 * folder into Trash, where the person it is shared with cannot reach it, and
 * never stays at a path a new folder can take; a restore brings it back, and
 * a purge or a delete outside fdrive ends it.
 */
describe("shared folders in their owner's Trash, through the real indexer", () => {
  const stack = new LocalIndexerStack();
  let database: ReturnType<typeof createDb>;
  let composed: Awaited<ReturnType<typeof composeApp>>;
  let index: ChangeQueue;
  const failures: unknown[] = [];

  beforeAll(async () => {
    await stack.startDatabaseAndStorage();
    await seedLocalUsers(stack.connectionString, stack.folder, ["alice"]);
    database = createDb(stack.connectionString);
    const repos = createRepos(database.db);
    await repos.settings.set("features.configuration", {
      version: 1,
      revision: 1,
      walkthroughComplete: true,
      values: {
        thumbnails: false,
        // The indexer indexes nothing with every feature off; plain text needs no ml service.
        textSearch: true,
        searchOcr: false,
        semanticSearch: false,
        imageSearch: false,
        pdfOcr: false,
      },
    });
    // Only the change journal tells the indexer about a change, as for every change fdrive makes.
    await stack.startIndexer({ watch: false });
    composed = await composeApp(
      loadConfig({
        DATABASE_URL: stack.connectionString,
        FDRIVE_STORAGE_ROOT: stack.folder.root,
        FDRIVE_MASTER_KEY: Buffer.alloc(32, 41).toString("base64"),
        FDRIVE_INDEXER_URL: await stack.indexerUrl(),
      }),
      silentLogger(),
    );
    index = createChangeQueue({
      write: createChangeWriter(database.db, "api"),
      onError: (error) => failures.push(error),
    });
  }, 720_000);

  afterAll(async () => {
    try {
      await composed?.close();
      await database?.close();
    } finally {
      await stack.stop();
    }
  }, 180_000);

  async function call(
    path: string,
    options: { method?: string; cookie?: string; body?: unknown } = {},
  ): Promise<Response> {
    return composed.app.request(path, {
      method: options.method ?? "GET",
      headers: {
        "x-requested-with": "fdrive",
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  async function ok(response: Promise<Response>): Promise<void> {
    const settled = await response;
    expect(settled.status, await settled.clone().text()).toBeLessThan(300);
  }

  async function login(username: string): Promise<string> {
    const response = await call(ROUTES.auth.login, {
      method: "POST",
      body: { username, password: PASSWORD },
    });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }

  async function names(cookie: string, path: string): Promise<string[]> {
    const response = await call(`${ROUTES.fs.list}?path=${encodeURIComponent(path)}`, { cookie });
    expect(response.status, path).toBe(200);
    return ListResponse.parse(await response.json())
      .entries.map((entry) => entry.name)
      .sort();
  }

  /** What `cookie`'s login finds in `Shared with me`, which is not there while nothing is. */
  async function shelf(cookie: string): Promise<string[]> {
    return (await names(cookie, "/")).includes("Shared with me") ? names(cookie, SHELF) : [];
  }

  /**
   * Where the folders `cookie`'s login shares are in its files, for those
   * with `name` on the way: each test keeps to its own folders.
   */
  async function shared(cookie: string, name: string): Promise<string[]> {
    const response = await call(ROUTES.grants.list, { cookie });
    expect(response.status).toBe(200);
    return GrantsResponse.parse(await response.json())
      .owned.map((grant) => grant.path)
      .filter((path) => path.split("/").includes(name))
      .sort();
  }

  async function share(cookie: string, path: string): Promise<void> {
    const response = await call(ROUTES.grants.list, {
      method: "POST",
      cookie,
      body: { path, username: "alice-other", access: "write" },
    });
    expect(response.status, path).toBe(201);
    OwnedGrant.parse(await response.json());
  }

  /** Moves `path` to Trash through fdrive and returns where it went, root-relative. */
  async function trash(cookie: string, path: string): Promise<Moved> {
    const before = await trashIds(cookie);
    await ok(
      call(ROUTES.fs.delete, { method: "POST", cookie, body: { items: [{ path, kind: "dir" }] } }),
    );
    const [id] = (await trashIds(cookie)).filter((candidate) => !before.includes(candidate));
    const name = path.split("/").at(-1);
    return { kind: "moved", path: `alice${path}`, target: `alice/.trash/${id}/${name}` };
  }

  async function trashIds(cookie: string): Promise<string[]> {
    const response = await call(ROUTES.trash.list, { cookie });
    expect(response.status).toBe(200);
    return TrashListResponse.parse(await response.json()).entries.map((entry) => entry.id);
  }

  /** Every `fs` event the API streams to `cookie`'s browser from now on. */
  async function stream(cookie: string): Promise<{ events: FsEvent[]; close: () => void }> {
    const controller = new AbortController();
    const response = await composed.app.request(ROUTES.events, {
      headers: { "x-requested-with": "fdrive", cookie },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const events: FsEvent[] = [];
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const lines = buffer.slice(0, end).split("\n");
          buffer = buffer.slice(end + 2);
          const data = lines.find((line) => line.startsWith("data:"));
          if (lines.includes("event: fs") && data !== undefined) {
            events.push(JSON.parse(data.slice("data:".length)) as FsEvent);
          }
        }
      }
    })().catch(() => undefined);
    return { events, close: () => controller.abort() };
  }

  /**
   * Runs `action`, a move in alice's files through fdrive, then queues that
   * move once more after the indexer's container sees it (see
   * `local-index-work.test.ts`): Docker Desktop can show the container the
   * folder as it was a moment ago. Then waits until alice's browser heard of
   * the move from the journal and the indexer has read every change.
   */
  async function indexed(events: readonly FsEvent[], action: () => Promise<Moved>): Promise<void> {
    const mark = events.length;
    const change = await action();
    await stack.seen(change.path, false);
    await stack.seen(change.target, true);
    index.record(change);
    await index.flush();
    const from = change.path.slice("alice".length);
    await expect
      .poll(() => events.slice(mark).filter((event) => event.paths[0] === from).length, {
        timeout: 30_000,
        interval: 100,
      })
      .toBeGreaterThanOrEqual(1);
    await settled();
  }

  /** Waits until the indexer has read every change journaled so far, the repeats included. */
  async function settled(): Promise<void> {
    await expect
      .poll(
        async () =>
          (
            await database.db.execute(sql`
              select coalesce((select position from idx.change_cursors where consumer = 'indexer'), 0)
                >= (select coalesce(max(id), 0) from idx.changes) as read`)
          ).rows[0]?.read,
        { timeout: 30_000, interval: 100 },
      )
      .toBe(true);
  }

  /** Runs `test` with alice's browser listening, and prints the indexer's logs when it fails. */
  async function watched(
    test: (alice: string, events: readonly FsEvent[]) => Promise<void>,
  ): Promise<void> {
    const alice = await login("alice");
    const watching = await stream(alice);
    try {
      await test(alice, watching.events);
      expect(failures).toEqual([]);
    } catch (error) {
      console.error(await stack.logs());
      const reported = await database.db.execute(
        sql`select source, path, target_path from idx.changes order by id`,
      );
      console.error(reported.rows);
      throw error;
    } finally {
      watching.close();
    }
  }

  const restore = (cookie: string, id: string, target?: string) =>
    ok(
      call(ROUTES.trash.restore, {
        method: "POST",
        cookie,
        body: { ids: [id], ...(target === undefined ? {} : { target }) },
      }),
    );
  const mkdir = (cookie: string, path: string) =>
    ok(call(ROUTES.fs.mkdir, { method: "POST", cookie, body: { path } }));
  /** A trashed item's id, from where it went (`Moved.target`, `alice/.trash/<id>/<name>`). */
  const idOf = (moved: Moved) => moved.target.split("/")[2] as string;
  const virtual = (rootPath: string) => rootPath.slice("alice".length);

  it("takes shares into Trash with their folder, back on restore, and ends them on purge", async () => {
    const other = await login("alice-other");
    await watched(async (alice, events) => {
      await share(alice, "/docs");
      await share(alice, "/docs/nested");
      expect(await shelf(other)).toEqual(["docs", "nested"]);

      let trashed = {} as Moved;
      await indexed(events, async () => {
        trashed = await trash(alice, "/docs");
        return trashed;
      });
      expect(trashed.target).toMatch(/^alice\/\.trash\/[0-9a-f-]{36}\/docs$/);
      expect(await shelf(other)).toEqual([]);
      const leaf = virtual(trashed.target);
      expect(await shared(alice, "docs")).toEqual([leaf, `${leaf}/nested`]);

      // A new folder where the shared one was is not shared.
      await mkdir(alice, "/docs");
      await mkdir(alice, "/docs/nested");
      expect(await shelf(other)).toEqual([]);

      // "Restore to" brings the shares back with the folder.
      await indexed(events, async () => {
        await restore(alice, idOf(trashed), "/docs-back");
        return { kind: "moved", path: trashed.target, target: "alice/docs-back" };
      });
      expect(await shared(alice, "docs-back")).toEqual(["/docs-back", "/docs-back/nested"]);
      expect(await shelf(other)).toEqual(["docs-back", "nested"]);
      expect(await names(other, `${SHELF}/nested`)).toEqual(["child.dat"]);

      // So does a restore to the same place.
      await indexed(events, async () => {
        trashed = await trash(alice, "/docs-back");
        return trashed;
      });
      expect(await shelf(other)).toEqual([]);
      await indexed(events, async () => {
        await restore(alice, idOf(trashed));
        return { kind: "moved", path: trashed.target, target: "alice/docs-back" };
      });
      expect(await shelf(other)).toEqual(["docs-back", "nested"]);

      // A purge ends them, with a new folder of the same name where the old one was.
      await indexed(events, async () => {
        trashed = await trash(alice, "/docs-back");
        return trashed;
      });
      await mkdir(alice, "/docs-back");
      expect(await shelf(other)).toEqual([]);
      await ok(
        call(ROUTES.trash.purge, {
          method: "POST",
          cookie: alice,
          body: { ids: [idOf(trashed)] },
        }),
      );
      expect(await shared(alice, "docs-back")).toEqual([]);
      expect(await names(other, "/")).toEqual(["docs"]);
    });
  });

  it("ends a share deleted from Trash outside fdrive once the watcher journals it", async () => {
    const other = await login("alice-other");
    await watched(async (alice, events) => {
      await share(alice, "/docs-other");
      let trashed = {} as Moved;
      await indexed(events, async () => {
        trashed = await trash(alice, "/docs-other");
        return trashed;
      });
      expect(trashed.target).toMatch(/^alice\/\.trash\/[0-9a-f-]{36}\/docs-other$/);
      expect(await shared(alice, "docs-other")).toEqual([virtual(trashed.target)]);
      expect(await shelf(other)).toEqual([]);

      // Deleted from Trash outside fdrive: until the watcher journals it the share
      // still names the deleted folder, which no new folder can take.
      await rm(stack.folder.path("alice", virtual(trashed.target)), { recursive: true });
      await mkdir(alice, "/docs-other");
      expect(await shelf(other)).toEqual([]);
      expect(await shared(alice, "docs-other")).toEqual([virtual(trashed.target)]);
      await createChangeWriter(database.db, "watcher")([{ path: trashed.target }]);
      await expect
        .poll(() => shared(alice, "docs-other"), { timeout: 30_000, interval: 100 })
        .toEqual([]);
      expect(await names(other, "/")).toEqual(["docs"]);
    });
  });
});
