import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  AttachmentStore,
  type BackupDestination,
  BackupEngine,
  type BackupSource,
  BackupStore,
  type BlobSource,
  type DestinationRecord,
  legacyOcrMappings,
  localBlobs,
  providerDestination,
  type SecretCodec,
  s3Destination,
} from "@fdrive/backup";
import type { BackupDestinationInput } from "@fdrive/contracts";
import { isStorageError, type StorageProvider } from "@fdrive/core";
import { Pool } from "pg";
import { open, parseMasterKey, seal } from "../auth/crypto.js";
import type { StorageSource } from "../auth/storage-factory.js";
import type { AppConfig } from "../config.js";

/** Envelope codec for backup secrets and attachments under the installation master key. */
export function masterSecrets(master: Uint8Array): SecretCodec {
  return {
    seal: (bytes, context) => seal(master, bytes, context),
    open: (bytes, context) => open(master, bytes, context),
  };
}
/**
 * The files folder backups read and write: users' files, built directly,
 * since fdrive keeps no password to sign in with. Its guard still refuses a
 * folder that is not this installation's. `storageId` is its provider row,
 * which a destination in it names.
 */
export interface BackupFiles {
  readonly storageId: string;
  readonly folder: StorageSource;
}
export function createBackupModule(config: AppConfig, files: BackupFiles) {
  /** A destination's storage: only while its user may still use their files. */
  async function destinationStorage(username: string): Promise<StorageProvider> {
    await files.folder.admit(username);
    return files.folder.storage(username);
  }
  const pool = new Pool({ connectionString: config.databaseUrl, max: 6 });
  pool.on("error", () => undefined);
  const gatePool = new Pool({ connectionString: config.databaseUrl, max: 16 });
  gatePool.on("error", () => undefined);
  const store = new BackupStore(pool);
  const secrets = masterSecrets(parseMasterKey(config.fdriveMasterKey));
  const directory = config.fdriveBackupStateDir ?? join(config.fdriveTmpDir, "backups-disabled");
  const attachments = new AttachmentStore(store, join(directory, "attachments"), secrets);
  async function destination(record: DestinationRecord): Promise<BackupDestination> {
    if (record.type === "s3") {
      const secret = JSON.parse(
        Buffer.from(secrets.open(record.secret, `backup-destination:${record.id}`)).toString(),
      ) as Record<string, string>;
      const { endpoint, region, bucket, prefix, pathStyle } = record.config;
      if (
        typeof endpoint !== "string" ||
        typeof region !== "string" ||
        typeof bucket !== "string" ||
        typeof prefix !== "string" ||
        typeof secret.accessKeyId !== "string" ||
        typeof secret.secretAccessKey !== "string"
      )
        throw Error("Invalid bucket configuration");
      return s3Destination({
        endpoint,
        region,
        bucket,
        prefix,
        pathStyle: pathStyle === true,
        accessKeyId: secret.accessKeyId,
        secretAccessKey: secret.secretAccessKey,
      });
    }
    if (record.config.providerId !== files.storageId) throw Error("Backup provider changed");
    if (typeof record.config.prefix !== "string") throw Error("Unsupported backup provider");
    const storage = await destinationStorage(String(record.config.username));
    const root = `/${record.config.prefix.replace(/^\/+|\/+$/g, "")}`;
    const existing = await storage.stat(root);
    if (existing.kind !== "dir") throw Error("Choose an existing private backup directory");
    return providerDestination(storage, record.config.prefix);
  }
  /**
   * A destination as it is saved. A folder in the files folder is in the
   * files of `username`, the owner adding it, and keeps no password.
   */
  async function destinationRecord(
    input: BackupDestinationInput,
    username: string,
    id: string = randomUUID(),
  ): Promise<DestinationRecord> {
    let settings: Record<string, unknown>;
    let credential: Record<string, string> = {};
    const installation = (await store.configuration()).installation_id;
    if (input.type === "s3") {
      const { accessKeyId, secretAccessKey, name: _, type: __, ...rest } = input;
      settings = { ...rest, prefix: `${input.prefix.replace(/\/+$/g, "")}/${installation}` };
      credential = { accessKeyId, secretAccessKey };
    } else {
      if (input.providerId !== files.storageId) throw Error("Storage provider is unavailable");
      const storage = await destinationStorage(username);
      const parent = `/${input.prefix.replace(/^\/+|\/+$/g, "")}`;
      if ((await storage.stat(parent)).kind !== "dir")
        throw Error("Choose an existing private directory");
      for (const path of [
        `${parent.replace(/\/$/, "")}/.fdrive-backups`,
        `${parent.replace(/\/$/, "")}/.fdrive-backups/${installation}`,
      ]) {
        const existing = await storage.stat(path).catch((error) => {
          if (isStorageError(error) && error.kind === "not_found") return null;
          throw error;
        });
        if (!existing) await storage.mkdir(path);
        else if (existing.kind !== "dir") throw Error("Backup namespace is not a directory");
      }
      settings = {
        providerId: files.storageId,
        username,
        prefix: `${input.prefix.replace(/\/+$/, "")}/.fdrive-backups/${installation}`,
      };
    }
    return {
      id,
      revision: randomUUID(),
      name: input.name,
      type: input.type,
      config: settings,
      secret: Buffer.from(
        secrets.seal(Buffer.from(JSON.stringify(credential)), `backup-destination:${id}`),
      ),
      enabled: false,
      tested_at: null,
    };
  }
  const mounts = (config.fdriveBackupSources ?? []).map((mount) => ({
    ...mount,
    sourceId: createHash("sha256").update(`${mount.kind}:${mount.path}`).digest("hex"),
  }));
  const source: BackupSource = {
    pool,
    masterKey: config.fdriveMasterKey,
    environment: {
      ...config,
      backupSourceRoots: mounts,
      databaseUrl: "[configure on destination]",
      fdriveSetupToken: "[rotate on restore]",
      fdriveWorkerToken: "[rotate on restore]",
    },
    async blobs(client, metadataOnly) {
      const sources: BlobSource[] = [];
      const coverage: string[] = [];
      await attachments.collect();
      for (const record of await store.attachments(client)) {
        try {
          await access(attachments.path(record.version_id));
          sources.push(attachments.source(record));
        } catch {
          coverage.push(`Configuration attachment missing: ${record.label}`);
        }
      }
      if (metadataOnly) return { sources, coverage };
      for (const mount of mounts) {
        if (directory === mount.path || directory.startsWith(`${mount.path.replace(/\/$/, "")}/`))
          throw Error("Backup output cannot be inside a backup source");
        try {
          const root = await realpath(mount.path);
          const output = await realpath(directory);
          if (output === root || output.startsWith(`${root}/`))
            throw Error("Backup output overlaps a source");
          const local = (await localBlobs(mount.path, mount.kind)).map((blob) => ({
            ...blob,
            sourceId: mount.sourceId,
          }));
          sources.push(...local);
          if (mount.kind === "ocr") {
            const mappings = await legacyOcrMappings(client, mount.path, local);
            sources.push(...mappings.sources);
            coverage.push(...mappings.coverage);
          }
        } catch {
          coverage.push(`Required ${mount.kind} source is unavailable`);
        }
      }
      const settings = (
        await client.query<{ key: string; value: unknown }>("select key,value from app.settings")
      ).rows;
      const recovered = settings.find((row) => row.key === "backup.recovery.v1")?.value as
        | {
            stateDirectory?: string;
            blobs?: {
              kind: BlobSource["kind"];
              entry: string;
              path: string;
              size: number;
              sourceId?: string;
            }[];
          }
        | undefined;
      if (recovered?.stateDirectory && recovered.blobs) {
        // Read as plain files; each takes the kind it was captured as below.
        const entries = await localBlobs(recovered.stateDirectory, "office").catch(() => null);
        if (!entries)
          coverage.push("Staged recovery files from the previous restore are unavailable");
        else
          for (const blob of recovered.blobs) {
            if (blob.kind === "attachment") continue;
            const entry = entries.find((item) => item.path === blob.entry.replace("/", "-"));
            if (entry)
              sources.push({
                ...entry,
                kind: blob.kind,
                path: blob.path,
                sourceId: blob.sourceId,
              });
            else coverage.push(`Previous recovery file is missing: ${blob.path}`);
          }
      }
      const enabledKinds = new Set(mounts.map((mount) => mount.kind));
      if (
        !settings.some((row) => row.key === "ocr.keep_originals" && row.value === false) &&
        config.fdriveOcrUrl &&
        !enabledKinds.has("ocr")
      )
        coverage.push("OCR original storage is not mounted for backups");
      if (config.fdriveIndexerUrl && !enabledKinds.has("logs"))
        coverage.push("Retained indexer logs are not mounted for backups");
      if (config.fdriveOfficeUrl && !enabledKinds.has("office"))
        coverage.push(
          "Office persistent proof keys/configuration are external or unmounted; include an exported configuration bundle",
        );
      return { sources, coverage };
    },
  };
  const engine = new BackupEngine({
    store,
    source,
    directory: join(directory, "archives"),
    destination,
  });
  return {
    pool,
    gatePool,
    store,
    attachments,
    engine,
    destination,
    destinationRecord,
    directory,
    enabled: !!config.fdriveBackupStateDir,
    async start() {
      if (config.fdriveBackupStateDir) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await store.configuration();
        if (config.fdriveBackupWorker) engine.start();
      }
    },
    async close() {
      await engine.stop();
      await gatePool.end();
      await pool.end();
    },
  };
}
export type BackupModule = ReturnType<typeof createBackupModule>;
