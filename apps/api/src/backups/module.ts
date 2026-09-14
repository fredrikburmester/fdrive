import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
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
import type {
  ProviderCredential,
  ProviderInstance,
  ProviderModule,
  StorageProvider,
} from "@fdrive/core";
import { isStorageError, stripTransientFields } from "@fdrive/core";
import { Pool } from "pg";
import { open, parseMasterKey, seal } from "../auth/crypto.js";
import type { AppConfig } from "../config.js";
import { moduleFor } from "../providers/registry.js";

/** Envelope codec for backup secrets and attachments under the installation master key. */
export function masterSecrets(master: Uint8Array): SecretCodec {
  return {
    seal: (bytes, context) => seal(master, bytes, context),
    open: (bytes, context) => open(master, bytes, context),
  };
}
export async function rawBackupStorage(
  module: ProviderModule,
  instance: ProviderInstance,
  credential: ProviderCredential,
  expectedUsername?: string,
): Promise<StorageProvider> {
  const context = { fetch: globalThis.fetch, ...(expectedUsername ? { expectedUsername } : {}) };
  const verified = await module.authenticate(instance, credential, context);
  if (expectedUsername && verified.externalUsername !== expectedUsername)
    throw Error("Backup credential identity changed");
  let token = verified.token;
  return module.createStorage(
    instance,
    {
      externalUsername: verified.externalUsername,
      getCredential: async () => credential,
      async getToken() {
        if (!token || token.expiresAt.getTime() < Date.now() + 10_000)
          token = await module.mint?.(
            instance,
            { externalUsername: verified.externalUsername, credential },
            context,
          );
        return token?.token ?? null;
      },
      async invalidateToken() {
        token = undefined;
      },
    },
    context,
  );
}
export function createBackupModule(config: AppConfig) {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 6 });
  pool.on("error", () => undefined);
  const gatePool = new Pool({ connectionString: config.databaseUrl, max: 16 });
  gatePool.on("error", () => undefined);
  const store = new BackupStore(pool);
  const secrets = masterSecrets(parseMasterKey(config.fdriveMasterKey));
  const directory = config.fdriveBackupStateDir ?? join(config.fdriveTmpDir, "backups-disabled");
  const attachments = new AttachmentStore(store, join(directory, "attachments"), secrets);
  async function destination(record: DestinationRecord): Promise<BackupDestination> {
    const secret = JSON.parse(
      Buffer.from(secrets.open(record.secret, `backup-destination:${record.id}`)).toString(),
    ) as Record<string, string>;
    if (record.type === "s3") {
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
    const current = (
      await pool.query<{
        id: string;
        type: string;
        base_url: string;
        config: Record<string, unknown>;
        enabled: boolean;
      }>("select * from app.providers where id=$1", [record.config.providerId])
    ).rows[0];
    if (
      !current?.enabled ||
      current.type !== record.config.providerType ||
      current.base_url !== record.config.baseUrl ||
      JSON.stringify(current.config) !== JSON.stringify(record.config.providerConfig)
    )
      throw Error("Backup provider changed");
    const module = moduleFor(current.type);
    if (!module || typeof record.config.prefix !== "string")
      throw Error("Unsupported backup provider");
    const storage = await rawBackupStorage(
      module,
      { id: current.id, baseUrl: current.base_url, config: current.config },
      secret,
      String(record.config.username),
    );
    const root = `/${record.config.prefix.replace(/^\/+|\/+$/g, "")}`;
    const existing = await storage.stat(root);
    if (existing.kind !== "dir") throw Error("Choose an existing private backup directory");
    return providerDestination(storage, record.config.prefix);
  }
  async function destinationRecord(
    input: BackupDestinationInput,
    id: string = randomUUID(),
  ): Promise<DestinationRecord> {
    let settings: Record<string, unknown>;
    let credential: Record<string, string>;
    const installation = (await store.configuration()).installation_id;
    if (input.type === "s3") {
      const { accessKeyId, secretAccessKey, name: _, type: __, ...rest } = input;
      settings = { ...rest, prefix: `${input.prefix.replace(/\/+$/g, "")}/${installation}` };
      credential = { accessKeyId, secretAccessKey };
    } else {
      const provider = (
        await pool.query<{
          id: string;
          type: string;
          base_url: string;
          config: Record<string, unknown>;
          enabled: boolean;
        }>("select * from app.providers where id=$1", [input.providerId])
      ).rows[0];
      const module = provider && moduleFor(provider.type);
      if (!module || !provider?.enabled) throw Error("Storage provider is unavailable");
      const instance = { id: provider.id, baseUrl: provider.base_url, config: provider.config };
      // Scheduled backups sign in unattended, so verify exactly the credential that will be
      // saved: one-time codes and other transient fields are dropped before the first login.
      credential = stripTransientFields(module.credentialFields, input.credential);
      const verified = await module.authenticate(instance, credential, {
        fetch: globalThis.fetch,
      });
      const storage = await rawBackupStorage(
        module,
        instance,
        credential,
        verified.externalUsername,
      );
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
        providerId: provider.id,
        providerType: provider.type,
        baseUrl: provider.base_url,
        providerConfig: provider.config,
        username: verified.externalUsername,
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
  const mounts = [
    ...(config.fdriveBackupSources ?? []),
    ...(config.fdriveDesktopStateDir
      ? [{ kind: "desktop" as const, path: config.fdriveDesktopStateDir }]
      : []),
  ].map((mount) => ({
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
              identityId?: string;
              sourceId?: string;
            }[];
          }
        | undefined;
      if (recovered?.stateDirectory && recovered.blobs) {
        const entries = await localBlobs(recovered.stateDirectory, "desktop").catch(() => null);
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
                identityId: blob.identityId,
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
      const operations = await client.query<{
        identity_id: string;
        id: string;
        result: Record<string, unknown> | null;
      }>("select identity_id,id,result from app.desktop_operations");
      for (const identityId of new Set(operations.rows.map((op) => op.identity_id))) {
        try {
          const identity = (
            await client.query<{
              external_username: string;
              ciphertext: Buffer;
              provider_id: string;
              type: string;
              base_url: string;
              config: Record<string, unknown>;
            }>(
              "select i.external_username,i.provider_id,c.ciphertext,p.type,p.base_url,p.config from app.identities i join app.credentials c on c.identity_id=i.id join app.providers p on p.id=i.provider_id where i.id=$1",
              [identityId],
            )
          ).rows[0];
          const module = identity && moduleFor(identity.type);
          if (!identity || !module) throw Error("Missing source credential");
          const credential = JSON.parse(
            Buffer.from(secrets.open(identity.ciphertext, identityId)).toString(),
          ) as ProviderCredential;
          const storage = await rawBackupStorage(
            module,
            { id: identity.provider_id, baseUrl: identity.base_url, config: identity.config },
            credential,
            identity.external_username,
          );
          async function walk(path: string, depth = 0) {
            if (depth > 128) throw Error("Recovery directory is too deep");
            for (const item of await storage.list(path)) {
              if (sources.length >= 100_000) throw Error("Recovery inventory is too large");
              if (
                !item.path.startsWith(`${path}/`) ||
                item.path.slice(path.length + 1).includes("/")
              )
                throw Error("Invalid recovery entry");
              if (item.kind === "dir") await walk(item.path, depth + 1);
              else if (item.kind === "file")
                sources.push({
                  kind: "remote",
                  path: item.path,
                  identityId,
                  size: item.size,
                  open: async () =>
                    Readable.fromWeb(
                      (await storage.download(item.path))
                        .body as import("node:stream/web").ReadableStream<Uint8Array>,
                    ),
                });
              else throw Error("Unsupported recovery entry");
            }
          }
          const root = `/.fdrive-desktop/${identityId}`;
          const required = operations.rows.some(
            (op) => op.identity_id === identityId && typeof op.result?.remoteAttempt === "string",
          );
          try {
            await walk(root);
          } catch (error) {
            if (required || !isStorageError(error) || error.kind !== "not_found") throw error;
          }
        } catch {
          coverage.push(`Native remote recovery is unavailable for identity ${identityId}`);
        }
      }
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
