import { rename } from "node:fs/promises";
import { GrantsResponse, ManagedShare, ROUTES } from "@fdrive/contracts";
import {
  createChangeJournal,
  createDb,
  createOfficeFileRepo,
  createRepos,
  type Repos,
} from "@fdrive/db";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { seedLocalUsers, silentLogger } from "./helpers/local-storage.ts";

const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";
const q = encodeURIComponent;
const SHARED = "/Shared with me/Project";

interface Frame {
  readonly event: string;
  readonly id: string | undefined;
  readonly data: { type: string; op?: string; paths?: string[]; targetPaths?: string[] };
}

/**
 * Live updates come from the change journal alone: the API records each
 * change it makes and reads the journal back, so a change reaches every
 * person who can see it once, the people a folder is shared with included,
 * with no indexer configured and every processing feature off. A browser that
 * reconnects resumes from its last event, or is told to resync. A change made
 * outside fdrive, which only the indexer's watcher journals, brings what is
 * kept by path along; fdrive's own changes bring it along in the request.
 */
describe("live updates from the change journal", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let storage: Awaited<ReturnType<typeof startLocalStorage>>;
  let composed: Awaited<ReturnType<typeof composeApp>>;
  let database: ReturnType<typeof createDb>;
  let repos: Repos;
  let alice: string;
  let bob: string;
  let carol: string;
  const streams: AbortController[] = [];

  beforeAll(async () => {
    [postgres, storage] = await Promise.all([
      startPostgres(),
      startLocalStorage({
        users: ["alice", "bob", "carol"].map((username) => ({
          username,
          password: `${username}-pass`,
        })),
        files: {
          alice: {
            "/Project/brief.txt": "brief",
            "/Team/doc.docx": "doc",
            "/Once/a.txt": "a",
            "/notes.txt": "notes",
          },
          bob: { "/mine.txt": "mine" },
          carol: { "/hers.txt": "hers" },
        },
        grants: [
          { owner: "alice", path: "/Project", grantee: "bob", access: "write" },
          { owner: "alice", path: "/Team", grantee: "bob", access: "read" },
        ],
      }),
    ]);
    await seedLocalUsers(postgres.connectionString, storage);
    database = createDb(postgres.connectionString);
    repos = createRepos(database.db);
    composed = await composeApp(
      loadConfig({
        DATABASE_URL: postgres.connectionString,
        FDRIVE_STORAGE_ROOT: storage.root,
        FDRIVE_MASTER_KEY: Buffer.alloc(32, 53).toString("base64"),
      }),
      silentLogger(),
    );
    alice = await login("alice");
    bob = await login("bob");
    carol = await login("carol");
  }, 180_000);

  afterAll(async () => {
    for (const stream of streams) stream.abort();
    await composed?.close();
    await database?.close();
    await storage?.stop();
    await postgres?.stop();
  }, 180_000);

  async function call(
    path: string,
    options: { method?: string; cookie?: string; body?: unknown } = {},
  ): Promise<Response> {
    return composed.app.request(path, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: {
        "x-requested-with": "fdrive",
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  async function ok(response: Promise<Response>): Promise<unknown> {
    const answered = await response;
    const body = await answered.text();
    expect(answered.status, body).toBeLessThan(300);
    return body === "" ? null : JSON.parse(body);
  }

  async function login(username: string): Promise<string> {
    const response = await call(ROUTES.auth.login, {
      body: { username, password: `${username}-pass` },
    });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }

  async function put(cookie: string, path: string, content: string, parents = false) {
    const parentsQuery = parents ? "&mkdirParents=true" : "";
    const response = await composed.app.request(
      `${ROUTES.fs.upload}?path=${q(path)}${parentsQuery}`,
      {
        method: "PUT",
        headers: { "x-requested-with": "fdrive", cookie },
        body: content,
      },
    );
    expect(response.status, await response.clone().text()).toBe(201);
  }

  /** A browser's event stream: every frame it has received so far, as it arrives. */
  async function watch(cookie: string, lastEventId?: string) {
    const controller = new AbortController();
    streams.push(controller);
    const response = await composed.app.request(ROUTES.events, {
      headers: {
        "x-requested-with": "fdrive",
        cookie,
        ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
      },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const frames: Frame[] = [];
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
          const field = (name: string) =>
            lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
          frames.push({
            event: field("event") ?? "",
            id: field("id"),
            data: JSON.parse(field("data") ?? "null"),
          });
        }
      }
    })().catch(() => undefined);
    // The first ping says the stream is open and where it stands.
    await expect.poll(() => frames.length, { timeout: 5_000 }).toBeGreaterThan(0);
    return {
      frames,
      /** Each `fs` event, as `op path [-> target]`. */
      changes: () =>
        frames
          .filter((frame) => frame.event === "fs")
          .map(
            ({ data }) =>
              `${data.op} ${data.paths?.[0]}${data.targetPaths ? ` -> ${data.targetPaths[0]}` : ""}`,
          ),
      lastId: () => frames.findLast((frame) => frame.id !== undefined)?.id,
      close: () => controller.abort(),
    };
  }

  /** Waits until the API's reader has read every row journaled so far. */
  async function caughtUp(): Promise<void> {
    await expect
      .poll(async () => {
        const result = await database.db.execute(
          sql`select (select coalesce(max(id), 0) from idx.changes) <= coalesce((
                select position from idx.change_cursors where consumer = 'api'), 0) as read`,
        );
        return result.rows[0]?.read;
      })
      .toBe(true);
  }

  const identityOf = async (username: string) => {
    const login = await repos.identities.findByUsername(username);
    if (login === null) throw new Error(`no login for ${username}`);
    return { identityId: login.id, accountId: login.accountId };
  };

  it("tells everyone a change reaches exactly once, with indexing off", async () => {
    const aliceTab = await watch(alice);
    const bobTab = await watch(bob);
    const carolTab = await watch(carol);

    await put(alice, "/Project/plan.md", "the plan");
    // Each stream delivers in order: once the marker arrived, so did any duplicate.
    await put(alice, "/Project/marker.txt", "marker");
    await expect.poll(bobTab.changes, { timeout: 10_000 }).toContain(`change ${SHARED}/marker.txt`);
    await expect
      .poll(aliceTab.changes, { timeout: 10_000 })
      .toContain("change /Project/marker.txt");

    expect(aliceTab.changes()).toEqual(["change /Project/plan.md", "change /Project/marker.txt"]);
    expect(bobTab.changes()).toEqual([`change ${SHARED}/plan.md`, `change ${SHARED}/marker.txt`]);
    expect(carolTab.changes()).toEqual([]);

    // What the person it is shared with does reaches the owner the same way.
    await ok(
      call(ROUTES.fs.rename, {
        cookie: bob,
        body: { path: `${SHARED}/plan.md`, newName: "v2.md" },
      }),
    );
    await expect
      .poll(aliceTab.changes, { timeout: 10_000 })
      .toContain("move /Project/plan.md -> /Project/v2.md");
    await expect
      .poll(bobTab.changes, { timeout: 10_000 })
      .toContain(`move ${SHARED}/plan.md -> ${SHARED}/v2.md`);
    for (const tab of [aliceTab, bobTab, carolTab]) tab.close();
  });

  it("gives a browser that reconnects what it missed", async () => {
    const first = await watch(bob);
    const resumeFrom = first.lastId();
    expect(resumeFrom).toMatch(/^[0-9a-f-]{36}\.\d+$/);
    first.close();

    await put(alice, "/Project/while-away.txt", "missed");
    await ok(call(ROUTES.fs.mkdir, { cookie: alice, body: { path: "/Private" } }));
    await caughtUp();

    const again = await watch(bob, resumeFrom);
    await expect
      .poll(again.changes, { timeout: 10_000 })
      .toEqual([`change ${SHARED}/while-away.txt`]);
    // It goes on live from there.
    await put(alice, "/Project/live.txt", "live");
    await expect
      .poll(again.changes, { timeout: 10_000 })
      .toEqual([`change ${SHARED}/while-away.txt`, `change ${SHARED}/live.txt`]);
    again.close();
  });

  it("tells a browser to resync when what it missed is gone", async () => {
    const first = await watch(alice);
    const resumeFrom = first.lastId() as string;
    first.close();
    await put(alice, "/Project/pruned-1.txt", "1");
    await put(alice, "/Project/pruned-2.txt", "2");
    await caughtUp();
    // Retention dropped everything after the browser's position but the newest row.
    await database.db.execute(
      sql`delete from idx.changes where id < (select max(id) from idx.changes)`,
    );

    const again = await watch(alice, resumeFrom);
    expect(again.frames[0]?.event).toBe("resync");
    expect(again.changes()).toEqual([]);
    // A position from before a restore, under another epoch, is a resync too.
    const restored = await watch(
      alice,
      `00000000-0000-4000-8000-000000000000.${resumeFrom.split(".")[1]}`,
    );
    expect(restored.frames[0]?.event).toBe("resync");
    again.close();
    restored.close();
  });

  it("brings tags, shares with people, links and Office files along with a move made over SMB", async () => {
    const owner = await identityOf("alice");
    const tag = await repos.tags.create(owner.accountId, { name: "Work", color: null });
    await repos.fileTags.setTags(owner.identityId, "/Team/doc.docx", [tag.id]);
    const link = ManagedShare.parse(
      await ok(
        call(ROUTES.shares, {
          cookie: alice,
          body: { name: "Doc", paths: ["/Team/doc.docx"], scope: "read" },
        }),
      ),
    ).id;
    const office = await createOfficeFileRepo(database.db).ensure({
      identityId: owner.identityId,
      path: "/Team/doc.docx",
    });

    // Renamed on the disk, as over SMB; the indexer's watcher journals it.
    await rename(storage.path("alice", "/Team"), storage.path("alice", "/Squad"));
    await createChangeJournal(database.db).append("watcher", [
      { path: "alice/Team", targetPath: "alice/Squad" },
    ]);
    await caughtUp();

    expect(await repos.fileTags.pathsForTag(owner.identityId, tag.id)).toEqual(["/Squad/doc.docx"]);
    const grants = GrantsResponse.parse(await ok(call(ROUTES.grants.list, { cookie: alice })));
    expect(grants.owned.map((grant) => grant.path).sort()).toEqual(["/Project", "/Squad"]);
    const shared = ManagedShare.parse(
      await ok(call(`${ROUTES.shares}/${link}`, { cookie: alice })),
    );
    expect(shared.paths).toEqual(["/Squad/doc.docx"]);
    expect((await createOfficeFileRepo(database.db).get(office.id))?.path).toBe("/Squad/doc.docx");
  });

  it("brings metadata along with fdrive's own move once, in the request", async () => {
    const owner = await identityOf("alice");
    const moved = await repos.tags.create(owner.accountId, { name: "Moved", color: null });
    const fresh = await repos.tags.create(owner.accountId, { name: "Fresh", color: null });
    await repos.fileTags.setTags(owner.identityId, "/Once/a.txt", [moved.id]);

    await ok(call(ROUTES.fs.move, { cookie: alice, body: { path: "/Once", target: "/Twice" } }));
    expect(await repos.fileTags.pathsForTag(owner.identityId, moved.id)).toEqual(["/Twice/a.txt"]);
    // Something new at the old path before the journal is read keeps its own tags.
    await put(alice, "/Once/a.txt", "new", true);
    await repos.fileTags.setTags(owner.identityId, "/Once/a.txt", [fresh.id]);
    await caughtUp();

    expect(await repos.fileTags.pathsForTag(owner.identityId, moved.id)).toEqual(["/Twice/a.txt"]);
    expect(await repos.fileTags.pathsForTag(owner.identityId, fresh.id)).toEqual(["/Once/a.txt"]);
  });
});
