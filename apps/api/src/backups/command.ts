import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  AttachmentStore,
  BackupStore,
  discoverBackups,
  extractAttachment,
  fetchBackup,
  inspectArchive,
  providerDestination,
  restoreArchive,
  s3Destination,
} from "@fdrive/backup";
import { stripTransientFields } from "@fdrive/core";
import { createDb, migrate } from "@fdrive/db";
import { z } from "zod";
import { open, parseMasterKey, seal } from "../auth/crypto.js";
import type { AppConfig } from "../config.js";
import { moduleFor } from "../providers/registry.js";
import { createBackupModule, masterSecrets, rawBackupStorage } from "./module.js";
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
        desktop: config.fdriveDesktopStateDir,
        sources: config.fdriveBackupSources,
      }),
    )
    .digest("hex");
}
const Review = z
  .object({
    snapshotId: z.uuid(),
    environmentFingerprint: z.string().length(64),
    providers: z.array(z.object({ id: z.uuid(), baseUrl: z.url() }).strict()).min(1),
    ownerIdentityId: z.uuid(),
    credential: z.record(z.string(), z.string()),
    oldDeploymentStopped: z.literal(true),
    pathBindingsReviewed: z.literal(true),
  })
  .strict();
export async function resumeRecovery(config: AppConfig, review: unknown): Promise<void> {
  const input = Review.parse(review);
  if (input.environmentFingerprint !== environmentFingerprint(config))
    throw Error("Destination environment changed since review");
  const database = createDb(config.databaseUrl);
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
      throw Error("Reauthenticate the original installation owner");
    for (const expected of input.providers) {
      const provider = (
        await database.pool.query<{
          id: string;
          type: string;
          base_url: string;
          config: Record<string, unknown>;
        }>("select * from app.providers where id=$1", [expected.id])
      ).rows[0];
      if (!provider || provider.base_url !== expected.baseUrl)
        throw Error("Provider binding changed; review source and destination before resuming");
      const module = moduleFor(provider.type);
      if (!module) throw Error("Unsupported restored provider");
      if (provider.id === owner.provider_id) {
        const verified = await module.authenticate(
          { id: provider.id, baseUrl: provider.base_url, config: provider.config },
          input.credential,
          { fetch: globalThis.fetch, expectedUsername: owner.external_username },
        );
        if (verified.externalUsername !== owner.external_username)
          throw Error("Restored owner identity mismatch");
      }
      const identities = (
        await database.pool.query<{ id: string; external_username: string; ciphertext: Buffer }>(
          "select i.id,i.external_username,c.ciphertext from app.identities i join app.credentials c on c.identity_id=i.id where i.provider_id=$1",
          [provider.id],
        )
      ).rows;
      for (const identity of identities) {
        if (identity.id === owner.id) continue;
        const credential = JSON.parse(
          Buffer.from(
            open(parseMasterKey(config.fdriveMasterKey), identity.ciphertext, identity.id),
          ).toString(),
        ) as Record<string, string>;
        const verified = await module.authenticate(
          { id: provider.id, baseUrl: provider.base_url, config: provider.config },
          credential,
          { fetch: globalThis.fetch, expectedUsername: identity.external_username },
        );
        if (verified.externalUsername !== identity.external_username)
          throw Error("Restored credential identity mismatch");
      }
    }
    // Publish only opaque ZIPs into normal app storage. Native/OCR/provider recovery stays
    // quarantined in the recorded staging directory for explicit operator reconciliation.
    if (!config.fdriveBackupStateDir) throw Error("Persistent backup directory is required");
    const attachmentDir = join(config.fdriveBackupStateDir, "attachments");
    await mkdir(attachmentDir, { recursive: true, mode: 0o700 });
    const master = parseMasterKey(config.fdriveMasterKey);
    const attachmentStore = new AttachmentStore(store, attachmentDir, masterSecrets(master));
    for (const row of await store.attachments()) {
      const target = join(attachmentDir, `${row.version_id}.age`);
      const source = join(saved.stateDirectory, "attachments", `${row.version_id}.age`);
      const exists = await lstat(target).catch(() => null);
      if (exists && (!exists.isFile() || exists.isSymbolicLink()))
        throw Error("Attachment destination is not a regular file");
      if (!exists) await rename(source, target);
      for await (const _chunk of await attachmentStore.download(row)) {
        /* verify prior publish before retry */
      }
    }
    const client = await database.pool.connect();
    try {
      await client.query("begin");
      const locked = (
        await client.query<{ value: { snapshotId: string } }>(
          "select value from app.settings where key='backup.restore.v1' for update",
        )
      ).rows[0];
      if (locked?.value.snapshotId !== saved.snapshotId) throw Error("Restore state changed");
      const ownerProvider = (
        await client.query<{ type: string }>("select type from app.providers where id=$1", [
          owner.provider_id,
        ])
      ).rows[0];
      const ownerModule = ownerProvider && moduleFor(ownerProvider.type);
      if (!ownerModule) throw Error("Restored owner provider is unavailable");
      const ownerSecret = seal(
        master,
        Buffer.from(
          JSON.stringify(stripTransientFields(ownerModule.credentialFields, input.credential)),
        ),
        owner.id,
      );
      await client.query(
        "insert into app.credentials(identity_id,key_id,ciphertext) values($1,'master-v1',$2) on conflict(identity_id) do update set ciphertext=excluded.ciphertext,cached_token=null",
        [owner.id, Buffer.from(ownerSecret)],
      );
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
      attachment: { type: "string" },
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
    const raw = JSON.parse(await privateText(values["destination-file"]));
    const s3 = z
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
      .strict();
    const provider = z
      .object({
        type: z.enum(["sftpgo", "webdav"]),
        id: z.uuid(),
        baseUrl: z.url(),
        config: z.record(z.string(), z.unknown()),
        username: z.string(),
        prefix: z.string(),
        credential: z.record(z.string(), z.string()),
      })
      .strict();
    const input = z.union([s3, provider]).parse(raw);
    const providerModule = input.type === "s3" ? null : moduleFor(input.type);
    if (input.type !== "s3" && !providerModule) throw Error("Unsupported destination provider");
    const destination =
      input.type === "s3"
        ? s3Destination(input)
        : providerDestination(
            await rawBackupStorage(
              providerModule as NonNullable<typeof providerModule>,
              { id: input.id, baseUrl: input.baseUrl, config: input.config },
              input.credential,
              input.username,
            ),
            input.prefix,
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
  if (command === "inspect" || command === "extract") {
    const { file, identity, inspection } = await inspectInput();
    if (command === "inspect") output(JSON.stringify(recoveryPreview(inspection), null, 2));
    else {
      const record = inspection.manifest.blobs.find(
        (blob) => blob.kind === "attachment" && blob.path === values.attachment,
      );
      if (!record || !values.output)
        throw Error("Choose --attachment VERSION_ID from inspect and --output NEW_ZIP_PATH");
      await extractAttachment(file, identity, record, resolve(values.output));
      output("Configuration ZIP extracted and verified.");
    }
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
          const identity = (
            await client.query<{ base_url: string }>(
              "select p.base_url from app.identities i join app.providers p on p.id=i.provider_id where i.account_id=$1 order by i.id limit 1",
              [account],
            )
          ).rows[0];
          if (!identity) throw Error("Account has no storage identity");
          await client.query("insert into app.settings(key,value) values('setup.owner.v1',$1)", [
            JSON.stringify({
              version: 1,
              state: "complete",
              accountId: account,
              baseUrl: identity.base_url,
            }),
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
        "Supply --review-file with snapshot, bindings, environment fingerprint and fresh owner credential",
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
