import { createHash } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { addAbortSignal, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { Encrypter } from "age-encryption";
import type { PoolClient } from "pg";
import tar from "tar-stream";
import { HeaderSchema, ManifestSchema } from "./format.js";
import {
  assertCoverage,
  BACKUP_GATE,
  DURABLE_TABLES,
  quoteIdentifier,
  quoteTable,
} from "./registry.js";
import { digest, fileStream, ignoreCleanupError, limitBytes, syncFile } from "./streams.js";
import type {
  BackupSource,
  BlobRecord,
  Column,
  SnapshotHeader,
  SnapshotManifest,
} from "./types.js";

export async function describeSchema(client: PoolClient): Promise<Record<string, Column[]>> {
  const { rows } = await client.query<{
    table: string;
    name: string;
    type: string;
    generated: boolean;
  }>(`
    select n.nspname || '.' || c.relname as "table", a.attname as name,
      format_type(a.atttypid, a.atttypmod) as type, a.attgenerated <> '' as generated
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
    where n.nspname in ('app','idx') and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped
    order by n.nspname, c.relname, a.attnum`);
  const schema: Record<string, Column[]> = {};
  for (const row of rows) {
    const columns = schema[row.table] ?? [];
    columns.push({ name: row.name, type: row.type, generated: row.generated });
    schema[row.table] = columns;
  }
  assertCoverage(Object.keys(schema));
  return schema;
}
export async function migrationHashes(client: PoolClient): Promise<string[]> {
  return (
    await client.query<{ hash: string }>(
      "select hash from drizzle.__drizzle_migrations order by created_at,id",
    )
  ).rows.map((row) => row.hash);
}
export function schemaFingerprint(schema: Record<string, Column[]>): string {
  return createHash("sha256").update(JSON.stringify(schema)).digest("hex");
}
export async function writeArchiveEntry(
  pack: tar.Pack,
  name: string,
  bytes: Buffer,
): Promise<void> {
  if (bytes.length > (name === "manifest.json" ? 64 : 4) * 1024 * 1024)
    throw Error("Backup entry exceeds restore limit");
  if (pack.destroyed) throw Error("Backup archive stream is closed");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      pack.off("error", failed);
      pack.off("close", closed);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const closed = () => failed(Error("Backup archive stream closed"));
    pack.once("error", failed);
    pack.once("close", closed);
    const output = pack.entry(
      { name, size: bytes.length, mode: 0o600, mtime: new Date(0) },
      bytes,
      (error) => {
        cleanup();
        if (error) reject(error);
        else resolve();
      },
    );
    if (!output) failed(Error("Backup archive stream is closed"));
  });
}

export async function captureSnapshot(
  source: BackupSource,
  options: {
    id: string;
    installationId: string;
    recipient: string;
    output: string;
    metadataOnly?: boolean;
    signal?: AbortSignal;
  },
): Promise<{ manifest: SnapshotManifest; bytes: number; sha256: string }> {
  const client = await source.pool.connect();
  const pack = tar.pack();
  pack.on("error", () => undefined);
  const partial = `${options.output}.partial`;
  let transfer: Promise<void> | undefined;
  let locked = false;
  let created = false;
  let published = false;
  const interrupted = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, interrupted.signal])
    : interrupted.signal;
  const fail = (error: Error) => {
    interrupted.abort(error);
    pack.destroy(error);
  };
  client.on("error", fail);
  try {
    signal.throwIfAborted();
    const encrypted = new Encrypter();
    encrypted.addRecipient(options.recipient);
    await client.query("set lock_timeout = '30s'");
    await client.query("select pg_advisory_lock($1)", [BACKUP_GATE]);
    locked = true;
    await client.query("begin isolation level repeatable read read only");
    await client.query("set local statement_timeout = '120s'");
    const schema = await describeSchema(client);
    const header: SnapshotHeader = {
      format: 1,
      id: options.id,
      installationId: options.installationId,
      createdAt: new Date().toISOString(),
      masterKey: source.masterKey,
      migrations: await migrationHashes(client),
      schema,
      fingerprint: schemaFingerprint(schema),
      environment: source.environment,
    };
    const capture = await source.blobs(client, options.metadataOnly);
    signal.throwIfAborted();
    const selected = options.metadataOnly
      ? capture.sources.filter((blob) => blob.kind === "attachment")
      : capture.sources;
    HeaderSchema.parse(header);
    if (selected.length > 100_000) throw Error("Backup source inventory exceeds restore limit");
    let entryCount = selected.length + 2;
    const manifest: SnapshotManifest = {
      format: 1,
      id: options.id,
      tables: {},
      blobs: [],
      coverage: [
        ...capture.coverage,
        ...(options.metadataOnly ? ["Recovery files excluded by metadata-only request"] : []),
      ],
    };
    const gzip = createGzip();
    pack.on("error", (error) => gzip.destroy(error));
    const compression = pipeline(pack, limitBytes(1024 ** 4), gzip);
    void compression.catch((error: Error) => gzip.destroy(error));
    const stream = await encrypted.encrypt(Readable.toWeb(gzip) as ReadableStream<Uint8Array>);
    const output = await open(partial, "wx", 0o600);
    created = true;
    transfer = pipeline(Readable.fromWeb(stream), output.createWriteStream(), { signal });
    // Observe immediately: a disk/network failure may occur while a SQL fetch is pending.
    void transfer.catch(fail);
    await writeArchiveEntry(pack, "header.json", Buffer.from(JSON.stringify(header)));
    for (const table of DURABLE_TABLES) {
      const columns = schema[table];
      if (!columns) throw Error("Missing backup table");
      const projection = columns.map((column) =>
        table === "app.credentials" &&
        ["cached_token", "cached_token_expires_at"].includes(column.name)
          ? "null::text"
          : `${quoteIdentifier(column.name)}::text`,
      );
      await client.query(
        `declare backup_rows no scroll cursor for select array[${projection.join(",")}]::text[] as values from ${quoteTable(table)}`,
      );
      let count = 0;
      const hash = createHash("sha256");
      try {
        while (true) {
          signal.throwIfAborted();
          const rows = await client.query<{ values: (string | null)[] }>(
            "fetch forward 100 from backup_rows",
          );
          if (!rows.rows.length) break;
          for (const row of rows.rows) {
            if (++entryCount > 10_000_000) throw Error("Backup entry count exceeds restore limit");
            const bytes = Buffer.from(JSON.stringify(row.values));
            if (bytes.length > 4 * 1024 * 1024) throw Error("Database row exceeds backup limit");
            hash.update(bytes);
            await writeArchiveEntry(pack, `rows/${table}/${count++}.json`, bytes);
          }
        }
      } finally {
        await client.query("close backup_rows");
      }
      manifest.tables[table] = { rows: count, sha256: hash.digest("hex") };
    }
    for (const [index, blob] of selected.entries()) {
      signal.throwIfAborted();
      const name = `blobs/${index}`;
      const hash = createHash("sha256");
      let size = 0;
      const body = addAbortSignal(signal, await blob.open());
      const output = pack.entry({ name, size: blob.size, mode: 0o600, mtime: new Date(0) });
      async function* chunks() {
        for await (const chunk of body) {
          size += chunk.length;
          if (size > blob.size) throw Error("Backup source grew");
          hash.update(chunk);
          yield chunk;
        }
        if (size !== blob.size) throw Error("Backup source was truncated");
      }
      await pipeline(Readable.from(chunks()), output, { signal });
      const record: BlobRecord = {
        entry: name,
        kind: blob.kind,
        path: blob.path,
        size: blob.size,
        sha256: hash.digest("hex"),
        ...(blob.identityId ? { identityId: blob.identityId } : {}),
        ...(blob.sourceId ? { sourceId: blob.sourceId } : {}),
      };
      manifest.blobs.push(record);
    }
    ManifestSchema.parse(manifest);
    await writeArchiveEntry(pack, "manifest.json", Buffer.from(JSON.stringify(manifest)));
    pack.finalize();
    await transfer;
    await syncFile(partial);
    await link(partial, options.output);
    published = true;
    await rm(partial);
    await syncFile(dirname(options.output));
    await client.query("commit");
    return { manifest, ...(await digest(fileStream(options.output))) };
  } catch (error) {
    pack.destroy(error instanceof Error ? error : Error("Backup failed"));
    await transfer?.catch(ignoreCleanupError);
    await client.query("rollback").catch(ignoreCleanupError);
    if (created) await rm(partial, { force: true });
    if (published) await rm(options.output, { force: true });
    throw error;
  } finally {
    client.off("error", fail);
    if (locked)
      await client.query("select pg_advisory_unlock($1)", [BACKUP_GATE]).catch(ignoreCleanupError);
    await client.query("reset lock_timeout").catch(ignoreCleanupError);
    client.release();
  }
}
