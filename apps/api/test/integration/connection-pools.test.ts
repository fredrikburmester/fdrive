import { sign } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SNAPSHOT_GATE } from "@fdrive/backup";
import { OfficeOpenResponse, PUBLIC_URL_SETTINGS_KEY, ROUTES } from "@fdrive/contracts";
import { createDb, createRepos } from "@fdrive/db";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { composeApp } from "../../src/composition.ts";
import { loadConfig } from "../../src/config.ts";
import { buildExpectedProof } from "../../src/office/protocol/proof.ts";
import { API_POOLS, type ApiPoolName } from "../../src/pools.ts";
import { proofKey, proofPair } from "../fixtures/office/harness.ts";
import { seedLocalUsers, silentLogger } from "./helpers/local-storage.ts";

const WOPI_URL = "http://fixture-callback/wopi";

/**
 * The API composed as deployed, backups on, with every pool's connections
 * held at once by work that waits: Office saves queued behind one document,
 * file operations behind a held path, and writes behind a backup taking its
 * snapshot. Each pool fills to its size, the rest of the API keeps
 * answering, and once the wait ends every request completes.
 */
describe("the API's pools when full", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let storage: Awaited<ReturnType<typeof startLocalStorage>>;
  let composed: Awaited<ReturnType<typeof composeApp>>;
  let editor: Server;
  let backups: string;
  let observer: Client;
  let cookie = "";

  beforeAll(async () => {
    // A stand-in Document Server: only its discovery, which names the editor
    // pages and the key that signs its callbacks.
    editor = createServer((request, response) => {
      const origin = `http://127.0.0.1:${(editor.address() as AddressInfo).port}`;
      const key = proofKey();
      response.writeHead(request.url === "/hosting/discovery" ? 200 : 404, {
        "content-type": "text/xml",
      });
      response.end(
        `<wopi-discovery><net-zone name="external-http"><app name="Word"><action ext="docx" name="edit" urlsrc="${origin}/editor?&lt;ui=UI_LLCC&amp;&gt;"/></app></net-zone><proof-key modulus="${key.modulus}" exponent="${key.exponent}"/></wopi-discovery>`,
      );
    });
    await new Promise<void>((resolve) => editor.listen(0, "127.0.0.1", resolve));
    const editorUrl = `http://127.0.0.1:${(editor.address() as AddressInfo).port}`;
    [postgres, storage] = await Promise.all([
      startPostgres(),
      startLocalStorage({
        users: [{ username: "alice", password: "alice-pass" }],
        files: {
          alice: { "/Docs/keep.txt": "", "/Busy/keep.txt": "", "/Gate/keep.txt": "" },
        },
      }),
    ]);
    await seedLocalUsers(postgres.connectionString, storage, ["alice"]);
    const database = createDb(postgres.connectionString);
    try {
      await createRepos(database.db).settings.set(PUBLIC_URL_SETTINGS_KEY, {
        revision: 1,
        url: "http://fixture-app",
      });
    } finally {
      await database.close();
    }
    backups = await mkdtemp(join(tmpdir(), "fdrive-pools-backups-"));
    composed = await composeApp(
      loadConfig({
        DATABASE_URL: postgres.connectionString,
        FDRIVE_STORAGE_ROOT: storage.root,
        FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
        // Backups configured: every write holds the snapshot gate.
        FDRIVE_BACKUP_STATE_DIR: backups,
        FDRIVE_OFFICE_PRODUCT: "onlyoffice",
        FDRIVE_OFFICE_URL: editorUrl,
        FDRIVE_OFFICE_PUBLIC_URL: editorUrl,
        FDRIVE_WOPI_URL: WOPI_URL,
      }),
      silentLogger(),
    );
    observer = new Client({ connectionString: postgres.connectionString });
    await observer.connect();
    const login = await call(ROUTES.auth.login, {
      body: { username: "alice", password: "alice-pass" },
    });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  }, 180_000);

  afterAll(async () => {
    await observer?.end();
    await composed?.close();
    await storage?.stop();
    await postgres?.stop();
    await rm(backups, { recursive: true, force: true });
    await new Promise((resolve) => editor?.close(resolve));
  }, 180_000);

  function call(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<Response> {
    return Promise.resolve(
      composed.app.request(path, {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers: { "x-requested-with": "fdrive", "content-type": "application/json", cookie },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    );
  }

  async function ok(response: Promise<Response>): Promise<unknown> {
    const resolved = await response;
    expect(resolved.status, await resolved.clone().text()).toBeLessThan(300);
    return resolved.json();
  }

  /** Connections each API pool holds right now, as Postgres counts them. */
  async function held(): Promise<Partial<Record<ApiPoolName, number>>> {
    const { rows } = await observer.query<{ name: string; count: number }>(
      `select substr(application_name, 12) as name, count(*)::int as count
       from pg_stat_activity where application_name like 'fdrive api %' group by 1`,
    );
    return Object.fromEntries(rows.map((row) => [row.name, row.count]));
  }

  /** Waits until `count` sessions wait for an advisory lock. */
  async function waiting(count: number): Promise<void> {
    await vi.waitFor(
      async () => {
        const { rows } = await observer.query<{ count: number }>(
          "select count(*)::int as count from pg_locks where locktype = 'advisory' and not granted",
        );
        expect(rows[0]?.count).toBe(count);
      },
      { timeout: 15_000, interval: 50 },
    );
  }

  /**
   * The rest of the API still answers, a listing on the main pool, while
   * `pool` holds every connection it may open.
   */
  async function answersWhileFull(pool: ApiPoolName, path: string): Promise<void> {
    const response = await call(`${ROUTES.fs.list}?path=${encodeURIComponent(path)}`);
    expect(response.status).toBe(200);
    expect((await held())[pool]).toBe(API_POOLS[pool]);
  }

  /** A WOPI callback as the editor makes it, with the session's token and a signed proof. */
  function wopi(
    session: OfficeOpenResponse,
    headers: Record<string, string>,
    body?: ReadableStream<Uint8Array> | string,
  ): Promise<Response> {
    const token = session.formFields.access_token ?? "";
    const suffix = `/files/${session.fileId}${body === undefined ? "" : "/contents"}?access_token=${encodeURIComponent(token)}`;
    const timestamp = BigInt(Date.now()) * 10000n + 621355968000000000n;
    const proof = sign(
      "RSA-SHA256",
      buildExpectedProof(token, `${WOPI_URL}${suffix}`, timestamp),
      proofPair.privateKey,
    ).toString("base64");
    return Promise.resolve(
      composed.app.request(
        new Request(`http://untrusted-host/wopi${suffix}`, {
          method: "POST",
          headers: { "X-WOPI-TimeStamp": String(timestamp), "X-WOPI-Proof": proof, ...headers },
          ...(body === undefined ? {} : { body, duplex: "half" }),
        } as RequestInit),
      ),
    );
  }

  it("lets Office saves queue behind one document while the rest of the API answers", async () => {
    const current = (await ok(call(ROUTES.system.office))) as {
      configuration: { revision: number };
    };
    await ok(
      call(ROUTES.system.office, {
        method: "PUT",
        body: {
          revision: current.configuration.revision,
          enabled: true,
          editingEnabled: true,
          editorUsernames: ["alice"],
        },
      }),
    );
    await ok(call(ROUTES.office.documents, { body: { parent: "/Docs", name: "plan.docx" } }));
    const session = OfficeOpenResponse.parse(
      await ok(call(ROUTES.office.open, { body: { path: "/Docs/plan.docx", mode: "edit" } })),
    );
    const lock = { "X-WOPI-Lock": "editor" };
    expect((await wopi(session, { "X-WOPI-Override": "LOCK", ...lock })).status).toBe(200);
    const save = { "X-WOPI-Override": "PUT", ...lock };

    // One save holds the document's lock while its body has not arrived yet.
    let arrive!: () => void;
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    let reading = false;
    const stalled = wopi(
      session,
      save,
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("slow "));
        },
        async pull(controller) {
          reading = true;
          await arrived;
          controller.enqueue(new TextEncoder().encode("save"));
          controller.close();
        },
      }),
    );
    const answered = stalled.then(
      async (response) => `${response.status} ${await response.text()}`,
    );
    try {
      await vi.waitFor(
        async () =>
          expect(reading, await Promise.race([answered, Promise.resolve("no answer")])).toBe(true),
        { timeout: 15_000 },
      );
      // More saves of the same document than the pool has connections: those
      // that get one wait for the document's lock with it, the rest for one.
      const queued = Array.from({ length: API_POOLS.office + 2 }, (_, index) =>
        wopi(session, save, `queued ${index}`),
      );
      await waiting(API_POOLS.office - 1);
      await answersWhileFull("office", "/Docs");
      // A write that is not an Office save still goes through.
      await ok(call(ROUTES.fs.mkdir, { body: { path: "/Docs/meanwhile" } }));

      arrive();
      expect(await answered).toMatch(/^200 /);
      expect((await Promise.all(queued)).map((response) => response.status)).toEqual(
        queued.map(() => 200),
      );
    } finally {
      arrive();
    }
    expect(await readFile(storage.path("alice", "/Docs/plan.docx"), "utf8")).toMatch(/^queued /);
  });

  it("lets file operations wait for a held path while the rest of the API answers", async () => {
    const identity = await observer.query<{ id: string }>(
      "select id from app.identities where username = 'alice'",
    );
    const key = JSON.stringify(["file-path", identity.rows[0]?.id, "/Busy"]);
    // A move out of /Busy, as far as everything that changes inside it can tell.
    await observer.query("select pg_advisory_lock(hashtextextended($1, 0))", [key]);
    let released = false;
    try {
      const made = Array.from({ length: API_POOLS.fileOperations + 3 }, (_, index) =>
        call(ROUTES.fs.mkdir, { body: { path: `/Busy/made-${index}` } }),
      );
      await waiting(API_POOLS.fileOperations);
      await answersWhileFull("fileOperations", "/Busy");
      expect(await readdir(storage.path("alice", "/Busy"))).toEqual(["keep.txt"]);

      await observer.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      released = true;
      expect((await Promise.all(made)).map((response) => response.status)).toEqual(
        made.map(() => 201),
      );
      expect(await readdir(storage.path("alice", "/Busy"))).toHaveLength(made.length + 1);
    } finally {
      if (!released)
        await observer.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
    }
  });

  it("lets writes wait for a backup's snapshot while reads go on", async () => {
    // What a capture holds while it takes its snapshot.
    await observer.query("select pg_advisory_lock($1)", [SNAPSHOT_GATE]);
    let released = false;
    try {
      const made = Array.from({ length: API_POOLS.writeGate + 4 }, (_, index) =>
        call(ROUTES.fs.mkdir, { body: { path: `/Gate/made-${index}` } }),
      );
      await waiting(API_POOLS.writeGate);
      await answersWhileFull("writeGate", "/Gate");
      expect(await readdir(storage.path("alice", "/Gate"))).toEqual(["keep.txt"]);

      await observer.query("select pg_advisory_unlock($1)", [SNAPSHOT_GATE]);
      released = true;
      expect((await Promise.all(made)).map((response) => response.status)).toEqual(
        made.map(() => 201),
      );
      expect(await readdir(storage.path("alice", "/Gate"))).toHaveLength(made.length + 1);
    } finally {
      if (!released) await observer.query("select pg_advisory_unlock($1)", [SNAPSHOT_GATE]);
    }
  });
});
