import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  BackupStore,
  discoverBackups,
  fetchBackup,
  inspectArchive,
  restoreArchive,
  s3Destination,
} from "@fdrive/backup";
import { createDb, createRepos, migrate } from "@fdrive/db";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { createLocalUserStore } from "../local/users.js";
import { createScryptSharePasswords } from "../shares/passwords.js";
import { createBackupModule } from "./module.js";
import { recoveryIdentity, recoveryPreview, restoreOptions } from "./recovery.js";

async function privateText(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size > 65_536
  )
    throw Error("Secret files must be regular private files (chmod 600), at most 64 KiB");
  return readFile(path, "utf8");
}
export function environmentFingerprint(config: AppConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        roots: config.fdriveIndexRoots,
        publicUrl: config.fdriveOfficePublicUrl,
        sources: config.fdriveBackupSources,
      }),
    )
    .digest("hex");
}
const Review = z
  .object({
    snapshotId: z.uuid(),
    environmentFingerprint: z.string().length(64),
    // The local folder's row has no URL; it is stored as its type name.
    providers: z.array(z.object({ id: z.uuid(), baseUrl: z.string().min(1) }).strict()).min(1),
    ownerIdentityId: z.uuid(),
    /** The owner's password, checked against their restored user. */
    password: z.string().min(1).max(1024),
    oldDeploymentStopped: z.literal(true),
    pathBindingsReviewed: z.literal(true),
  })
  .strict();
export async function resumeRecovery(config: AppConfig, review: unknown): Promise<void> {
  const input = Review.parse(review);
  if (input.environmentFingerprint !== environmentFingerprint(config))
    throw Error("Destination environment changed since review");
  const database = createDb(config.databaseUrl);
  const repos = createRepos(database.db);
  try {
    const store = new BackupStore(database.pool);
    const saved = (
      await database.pool.query<{
        value: { snapshotId: string; stateDirectory: string; mode?: string };
      }>("select value from app.settings where key='backup.restore.v1'")
    ).rows[0]?.value;
    if (!saved || saved.snapshotId !== input.snapshotId) throw Error("No matching staged restore");
    if (saved.mode === "rehearsal")
      throw Error("Rehearsal installations cannot resume the source installation");
    const owner = (
      await database.pool.query<{
        id: string;
        account_id: string;
        external_username: string;
        provider_id: string;
      }>("select * from app.identities where id=$1", [input.ownerIdentityId])
    ).rows[0];
    if (
      !owner ||
      !(await store.owner(owner.account_id)) ||
      !input.providers.some((provider) => provider.id === owner.provider_id)
    )
      throw Error("Confirm the original installation owner");
    const users = createLocalUserStore({
      repo: repos.localUsers,
      grants: repos.localGrants,
      passwords: createScryptSharePasswords(),
    });
    if ((await users.verify(owner.external_username, input.password)).result !== "ok")
      throw Error("The original owner's password is not right");
    for (const expected of input.providers) {
      const provider = (
        await database.pool.query<{ base_url: string }>(
          "select base_url from app.providers where id=$1",
          [expected.id],
        )
      ).rows[0];
      if (!provider || provider.base_url !== expected.baseUrl)
        throw Error("Provider binding changed; review source and destination before resuming");
    }
    // Recovery files (OCR, Office, logs) stay quarantined in the recorded staging directory
    // for explicit operator reconciliation; nothing is published into normal app storage.
    const client = await database.pool.connect();
    try {
      await client.query("begin");
      const locked = (
        await client.query<{ value: { snapshotId: string } }>(
          "select value from app.settings where key='backup.restore.v1' for update",
        )
      ).rows[0];
      if (locked?.value.snapshotId !== saved.snapshotId) throw Error("Restore state changed");
      await client.query("update app.providers set enabled=true where id=any($1::uuid[])", [
        input.providers.map((provider) => provider.id),
      ]);
      await client.query(
        "update app.backup_configuration set restored=false,confirmed=false,next_run_at=null where id=1",
      );
      await client.query(
        "insert into app.settings(key,value) select 'backup.recovery.v1',value from app.settings where key='backup.restore.v1' on conflict(key) do update set value=excluded.value",
      );
      await client.query("delete from app.settings where key='backup.restore.v1'");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await database.close();
  }
}
export async function runBackupCommand(
  configuration: AppConfig | (() => AppConfig),
  args: string[],
  output: (value: string) => void = console.log,
): Promise<void> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      file: { type: "string" },
      "key-file": { type: "string" },
      output: { type: "string" },
      account: { type: "string" },
      snapshot: { type: "string" },
      "review-file": { type: "string" },
      "state-dir": { type: "string" },
      "destination-file": { type: "string" },
    },
  });
  const command = parsed.positionals[0];
  const values = parsed.values;
  if (command === "list" || command === "fetch") {
    if (!values["destination-file"])
      throw Error("Supply a private destination JSON file; no application database is required");
    const destination = s3Destination(
      z
        .object({
          type: z.literal("s3"),
          endpoint: z.url(),
          region: z.string(),
          bucket: z.string(),
          prefix: z.string(),
          pathStyle: z.boolean(),
          accessKeyId: z.string(),
          secretAccessKey: z.string(),
        })
        .strict()
        .parse(JSON.parse(await privateText(values["destination-file"]))),
    );
    if (command === "list") output(JSON.stringify(await discoverBackups(destination), null, 2));
    else {
      if (!values.snapshot || !values.output)
        throw Error("Supply --snapshot ID and --output NEW_ARCHIVE_PATH");
      await fetchBackup(destination, values.snapshot, resolve(values.output));
      output(
        "Encrypted archive downloaded and its stored checksum verified. Inspect it with the recovery key before restoring.",
      );
    }
    return;
  }
  async function inspectInput() {
    if (!values.file || !values["key-file"])
      throw Error("Supply --file ARCHIVE and --key-file PRIVATE_KEY_FILE");
    const file = resolve(values.file);
    const identity = recoveryIdentity(await privateText(values["key-file"]));
    return { file, identity, inspection: await inspectArchive(file, identity) };
  }
  if (command === "inspect") {
    const { inspection } = await inspectInput();
    output(JSON.stringify(recoveryPreview(inspection), null, 2));
    return;
  }
  const config = typeof configuration === "function" ? configuration() : configuration;
  if (command === "accounts" || command === "claim-owner") {
    const database = createDb(config.databaseUrl);
    try {
      if (command === "accounts")
        output(
          JSON.stringify(
            (
              await database.pool.query(
                "select a.id,i.external_username,i.provider_id from app.accounts a join app.identities i on i.account_id=a.id order by a.id",
              )
            ).rows,
            null,
            2,
          ),
        );
      else {
        const account = z.uuid().parse(values.account);
        const client = await database.pool.connect();
        try {
          await client.query("begin");
          await client.query("lock table app.settings in share row exclusive mode");
          if (
            (await client.query("select 1 from app.settings where key='setup.owner.v1'")).rows
              .length
          )
            throw Error("Installation ownership already exists");
          const login = (
            await client.query("select 1 from app.identities where account_id=$1", [account])
          ).rows[0];
          if (!login) throw Error("Account has no login");
          await client.query("insert into app.settings(key,value) values('setup.owner.v1',$1)", [
            JSON.stringify({ state: "complete", accountId: account }),
          ]);
          await client.query("update app.accounts set is_admin=true where id=$1", [account]);
          await client.query("commit");
          output("Installation owner set. Sign in again to use System → Backups.");
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
      }
    } finally {
      await database.close();
    }
    return;
  }
  if (command === "worker") {
    const waitForStop = () =>
      new Promise<void>((resolve) => {
        const stop = () => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          resolve();
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    if (config.fdriveRestoreMode) {
      await waitForStop();
      return;
    }
    const module = createBackupModule({ ...config, fdriveBackupWorker: false });
    try {
      await module.start();
      if (!module.enabled) throw Error("FDRIVE_BACKUP_STATE_DIR is required");
      module.engine.start();
      await waitForStop();
    } finally {
      await module.close();
    }
    return;
  }
  if (command === "resume") {
    if (!values["review-file"])
      throw Error(
        "Supply --review-file with snapshot, bindings, environment fingerprint and the owner's password",
      );
    await resumeRecovery(config, JSON.parse(await privateText(values["review-file"])));
    output(
      "Recovery reviewed. Restart API with FDRIVE_RESTORE_MODE=false. Features, schedules and old native effects remain paused; re-enable reviewed features in System.",
    );
    return;
  }
  if (command === "environment") {
    output(environmentFingerprint(config));
    return;
  }
  if (command !== "restore" && command !== "rehearse") throw Error("Unknown backup command");
  const { file, identity, inspection } = await inspectInput();
  if (values.snapshot !== inspection.header.id || !values["state-dir"])
    throw Error("Inspect first, then confirm --snapshot ID and --state-dir NEW_PRIVATE_DIRECTORY");
  const directory = resolve(values["state-dir"]);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const database = createDb(config.databaseUrl);
  try {
    const existing = await database.pool.query("select 1 from pg_namespace where nspname='app'");
    if (existing.rows.length) {
      const count = await database.pool.query("select 1 from app.accounts limit 1");
      if (count.rows.length) throw Error("Choose a new empty database for restore");
    }
    await migrate(database.db);
    await restoreArchive({
      ...restoreOptions(config, database.pool, file, identity, directory),
      rehearsal: command === "rehearse",
    });
    if (command === "rehearse") {
      output(
        JSON.stringify(
          {
            sourceInstallationId: inspection.header.installationId,
            snapshotId: inspection.header.id,
            completedAt: new Date().toISOString(),
            migrations: inspection.header.migrations,
            tableCount: Object.keys(inspection.manifest.tables).length,
            blobCount: inspection.manifest.blobs.length,
            result: "passed",
          },
          null,
          2,
        ),
      );
      return;
    }
    output(
      "Restore staged and verified. All services remain paused. Run backup environment, review endpoints and mounts, then backup resume with a private review file.",
    );
  } finally {
    await database.close();
  }
}
