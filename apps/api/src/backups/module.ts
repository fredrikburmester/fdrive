import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  type BackupDestination,
  BackupEngine,
  type BackupSource,
  BackupStore,
  type BlobSource,
  type DestinationRecord,
  legacyOcrMappings,
  localBlobs,
  type SecretCodec,
  s3Destination,
} from "@fdrive/backup";
import type { BackupDestinationInput } from "@fdrive/contracts";
import { Pool } from "pg";
import { open, parseMasterKey, seal } from "../auth/crypto.js";
import type { AppConfig } from "../config.js";

/** Envelope codec for backup destination secrets under the installation master key. */
export function masterSecrets(master: Uint8Array): SecretCodec {
  return {
    seal: (bytes, context) => seal(master, bytes, context),
    open: (bytes, context) => open(master, bytes, context),
  };
}
export function createBackupModule(config: AppConfig) {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 6 });
  pool.on("error", () => undefined);
  const gatePool = new Pool({ connectionString: config.databaseUrl, max: 16 });
  gatePool.on("error", () => undefined);
  const store = new BackupStore(pool);
  const secrets = masterSecrets(parseMasterKey(config.fdriveMasterKey));
  const directory = config.fdriveBackupStateDir ?? join(config.fdriveTmpDir, "backups-disabled");
  /** A saved bucket's transport, with its keys opened from their sealed record. */
  async function destination(record: DestinationRecord): Promise<BackupDestination> {
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
  /** A bucket as it is saved: its keys sealed, its prefix narrowed to this installation. */
  async function destinationRecord(
    input: BackupDestinationInput,
    id: string = randomUUID(),
  ): Promise<DestinationRecord> {
    const installation = (await store.configuration()).installation_id;
    const { accessKeyId, secretAccessKey, name: _, type: __, ...rest } = input;
    const settings = { ...rest, prefix: `${input.prefix.replace(/\/+$/g, "")}/${installation}` };
    const credential = { accessKeyId, secretAccessKey };
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
    async blobs(client) {
      const sources: BlobSource[] = [];
      const coverage: string[] = [];
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
          "Office proof keys and configuration are not mounted for backups; back them up with the Office server's own tools",
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
