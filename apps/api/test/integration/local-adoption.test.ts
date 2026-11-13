import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AdminUser, ListResponse, MeResponse, ROUTES } from "@fdrive/contracts";
import { createDb, migrate } from "@fdrive/db";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEY_ID, seal } from "../../src/auth/crypto.js";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { silentLogger } from "./helpers/local-storage.ts";

const MIGRATIONS = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
/** The last migration of the SFTPGo era; 0017 brings the local folder. */
const LAST_SFTPGO_MIGRATION = "0016_personal_activity";

interface Journal {
  readonly entries: readonly { readonly idx: number; readonly tag: string }[];
}

/**
 * A copy of the migrations folder that ends at `last`, so a database can be
 * left exactly as an SFTPGo-era fdrive left it.
 */
async function migrationsUpTo(last: string): Promise<string> {
  const journal = JSON.parse(
    await readFile(join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
  ) as Journal;
  const end = journal.entries.findIndex((entry) => entry.tag === last);
  if (end < 0) throw new Error(`no migration ${last}`);
  const entries = journal.entries.slice(0, end + 1);
  const folder = await mkdtemp(join(tmpdir(), "fdrive-migrations-"));
  await mkdir(join(folder, "meta"));
  await writeFile(join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) {
    await copyFile(join(MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  return folder;
}

const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";

/**
 * The first start of fdrive with a local folder on a database SFTPGo-era
 * fdrive left behind: migration 0017 turns the pinned SFTPGo row into the
 * local row in place, and the API carries each login's password over from
 * its sealed credential. Administrators sign in at once with their old
 * password; everyone else waits, disabled, for an administrator.
 */
describe("adopting an SFTPGo-era installation", () => {
  const master = randomBytes(32);
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let storage: Awaited<ReturnType<typeof startLocalStorage>>;
  let database: ReturnType<typeof createDb>;
  let migrations: string;
  const ids = {
    pinned: randomUUID(),
    other: randomUUID(),
    adminAccount: randomUUID(),
    bobAccount: randomUUID(),
    carolAccount: randomUUID(),
    daveAccount: randomUUID(),
    alice: randomUUID(),
    bob: randomUUID(),
    carol: randomUUID(),
    dave: randomUUID(),
  };

  beforeAll(async () => {
    [postgres, storage] = await Promise.all([
      startPostgres(),
      // SFTPGo's data folder: one home per user, kept as is.
      startLocalStorage({
        users: [],
        files: {
          alice: { "/report.txt": "alice's report" },
          bob: { "/notes.txt": "bob's notes" },
          carol: { "/carol.txt": "carol's file" },
        },
      }),
    ]);
    database = createDb(postgres.connectionString);
    migrations = await migrationsUpTo(LAST_SFTPGO_MIGRATION);
    await runMigrations(database.db, { migrationsFolder: migrations });

    const query = (text: string, values: unknown[] = []) => database.pool.query(text, values);
    await query(
      `insert into app.providers(id, type, label, base_url, config, enabled, managed_by_env)
       values ($1, 'sftpgo', '', 'http://sftpgo:8080', '{"homeTemplate":"sftpgo:/{username}"}', true, true),
              ($2, 'sftpgo', 'Old server', 'http://old-sftpgo:8080', '{}', true, false)`,
      [ids.pinned, ids.other],
    );
    await query(
      `insert into app.accounts(id, display_name, is_admin)
       values ($1, 'alice', true), ($2, 'bob', false), ($3, 'carol', false), ($4, 'dave', false)`,
      [ids.adminAccount, ids.bobAccount, ids.carolAccount, ids.daveAccount],
    );
    const login = async (
      identity: string,
      account: string,
      provider: string,
      username: string,
      key: Uint8Array,
    ) => {
      await query(
        "insert into app.identities(id, account_id, provider_id, external_username) values ($1, $2, $3, $4)",
        [identity, account, provider, username],
      );
      const sealed = seal(
        key,
        new TextEncoder().encode(
          JSON.stringify({ username, password: `${username}-old-password` }),
        ),
        identity,
      );
      await query(
        "insert into app.credentials(identity_id, key_id, ciphertext) values ($1, $2, $3)",
        [identity, KEY_ID, Buffer.from(sealed)],
      );
    };
    await login(ids.alice, ids.adminAccount, ids.pinned, "alice", master);
    await login(ids.bob, ids.bobAccount, ids.pinned, "bob", master);
    // Sealed under a master key this installation no longer has: unreadable.
    await login(ids.carol, ids.carolAccount, ids.pinned, "carol", randomBytes(32));
    // A login on the other SFTPGo server, which does not become the local folder.
    await login(ids.dave, ids.daveAccount, ids.other, "dave", master);
    await query("insert into app.settings(key, value) values ('setup.owner.v1', $1)", [
      JSON.stringify({
        version: 1,
        state: "complete",
        accountId: ids.adminAccount,
        baseUrl: "http://sftpgo:8080",
      }),
    ]);
    await query("insert into idx.roots(name) values ('sftpgo')");

    // The upgrade itself: the remaining migrations, as the API runs them on start.
    await migrate(database.db);
  }, 180_000);

  afterAll(async () => {
    await database?.close();
    await storage?.stop();
    await postgres?.stop();
    if (migrations !== undefined) await rm(migrations, { recursive: true, force: true });
  }, 180_000);

  function compose() {
    return composeApp(
      loadConfig({
        DATABASE_URL: postgres.connectionString,
        FDRIVE_STORAGE_ROOT: storage.root,
        FDRIVE_MASTER_KEY: master.toString("base64"),
      }),
      silentLogger(),
    );
  }

  it("keeps the pinned row, its logins and their passwords, enabling only administrators", async () => {
    const rows = async (text: string) => (await database.pool.query(text)).rows;
    // Migration 0017 alone: the pinned row is now the local folder; the other is off.
    expect(
      await rows("select id, type, base_url, enabled from app.providers order by created_at, id"),
    ).toEqual(
      expect.arrayContaining([
        { id: ids.pinned, type: "local", base_url: "local", enabled: true },
        { id: ids.other, type: "sftpgo", base_url: "http://old-sftpgo:8080", enabled: false },
      ]),
    );
    expect(await rows("select name from idx.roots")).toEqual([{ name: "files" }]);
    expect(await rows("select count(*)::int as users from app.local_users")).toEqual([
      { users: 0 },
    ]);

    let composed = await compose();
    try {
      // The first start pins the row to FDRIVE_STORAGE_ROOT and carries the passwords over.
      expect(
        await rows(`select managed_by_env, enabled from app.providers where type = 'local'`),
      ).toEqual([{ managed_by_env: true, enabled: true }]);
      expect(
        await rows("select username, disabled from app.local_users order by username"),
      ).toEqual([
        { username: "alice", disabled: false },
        { username: "bob", disabled: true },
      ]);

      const call = (
        path: string,
        options: { method?: string; cookie?: string; body?: unknown } = {},
      ) =>
        composed.app.request(path, {
          method: options.method ?? "GET",
          headers: {
            "x-requested-with": "fdrive",
            ...(options.cookie ? { cookie: options.cookie } : {}),
            ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        });
      const signIn = (username: string) =>
        call(ROUTES.auth.login, {
          method: "POST",
          body: { credential: { username, password: `${username}-old-password` } },
        });

      // The administrator signs in with the password SFTPGo had, as the same login.
      const aliceLogin = await signIn("alice");
      expect(aliceLogin.status).toBe(200);
      const alice = cookieFrom(aliceLogin);
      const aliceMe = MeResponse.parse(await aliceLogin.json());
      expect(aliceMe).toMatchObject({
        activeIdentityId: ids.alice,
        account: { id: ids.adminAccount },
        isAdmin: true,
      });
      expect(aliceMe.identities.find((identity) => identity.id === ids.alice)).toMatchObject({
        providerId: ids.pinned,
        providerType: "local",
      });
      const listing = await call(`${ROUTES.fs.list}?path=/`, { cookie: alice });
      expect(ListResponse.parse(await listing.json()).entries.map((entry) => entry.name)).toEqual([
        "report.txt",
      ]);

      // Everyone else waits for an administrator; an unreadable credential carries nothing over.
      expect((await signIn("bob")).status).toBe(403);
      expect((await signIn("carol")).status).toBe(401);
      expect((await signIn("dave")).status).toBe(401);

      // One click lets bob back in, as the login he always had.
      const enabled = await call(`${ROUTES.admin.users}/bob`, {
        method: "PATCH",
        cookie: alice,
        body: { disabled: false },
      });
      expect(AdminUser.parse(await enabled.json())).toMatchObject({ disabled: false });
      const bobLogin = await signIn("bob");
      expect(bobLogin.status).toBe(200);
      expect(MeResponse.parse(await bobLogin.json()).activeIdentityId).toBe(ids.bob);

      // carol gets a new password from the administrator and keeps her login too.
      const carol = await call(ROUTES.admin.users, {
        method: "POST",
        cookie: alice,
        body: { username: "carol", password: "carol-new-password" },
      });
      expect(carol.status).toBe(201);
      const carolLogin = await call(ROUTES.auth.login, {
        method: "POST",
        body: { credential: { username: "carol", password: "carol-new-password" } },
      });
      expect(carolLogin.status).toBe(200);
      expect(MeResponse.parse(await carolLogin.json()).activeIdentityId).toBe(ids.carol);

      // A user removed after the adoption stays removed on the next start.
      expect(
        (await call(`${ROUTES.admin.users}/bob`, { method: "DELETE", cookie: alice })).status,
      ).toBe(200);
    } finally {
      await composed.close();
    }

    composed = await compose();
    try {
      expect(await rows("select username from app.local_users order by username")).toEqual([
        { username: "alice" },
        { username: "carol" },
      ]);
    } finally {
      await composed.close();
    }
  });
});
