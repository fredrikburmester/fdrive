import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Decrypter, Encrypter, identityToRecipient } from "age-encryption";
import type { Pool } from "pg";
import tar from "tar-stream";
import { z } from "zod";
import { HeaderSchema, ManifestSchema } from "./format.js";
import { DURABLE_TABLES, quoteIdentifier, quoteTable } from "./registry.js";
import { describeSchema, migrationHashes, schemaFingerprint } from "./snapshot.js";
import {
  digest,
  fileStream,
  ignoreCleanupError,
  limitBytes,
  readBounded,
  syncFile,
} from "./streams.js";
import type { BlobRecord, Column, SecretCodec, SnapshotHeader, SnapshotManifest } from "./types.js";

export interface Inspection {
  header: SnapshotHeader;
  manifest: SnapshotManifest;
}
export interface ArchiveVisitor {
  header?(header: SnapshotHeader): Promise<void>;
  row?(table: string, columns: Column[], values: (string | null)[]): Promise<void>;
  blob?(entry: string, stream: Readable): Promise<void>;
}
/** Validates every byte and every entry. No archive entry is ever extracted by path. */
export async function inspectArchive(
  file: string,
  identity: string,
  visitor: ArchiveVisitor = {},
  maxBytes = 1024 ** 4,
): Promise<Inspection> {
  const decrypt = new Decrypter();
  decrypt.addIdentity(identity);
  const source = fileStream(file);
  const deciphered = await decrypt.decrypt(Readable.toWeb(source) as ReadableStream<Uint8Array>);
  const extract = tar.extract();
  let header: SnapshotHeader | undefined;
  let manifest: SnapshotManifest | undefined;
  let count = 0;
  const rows = new Map<string, { count: number; hash: ReturnType<typeof createHash> }>();
  const blobs = new Map<string, { sha256: string; bytes: number }>();
  extract.on("entry", (entry, stream, next) => {
    async function consume() {
      if (
        ++count > 10_000_000 ||
        manifest ||
        entry.type !== "file" ||
        entry.linkname ||
        !Number.isSafeInteger(entry.size) ||
        (entry.size ?? 0) < 0
      )
        throw Error("Invalid backup archive entry");
      if (entry.name === "header.json") {
        if (header || count !== 1) throw Error("Duplicate backup header");
        header = HeaderSchema.parse(JSON.parse((await readBounded(stream)).toString()));
        if (schemaFingerprint(header.schema) !== header.fingerprint)
          throw Error("Backup schema fingerprint mismatch");
        await visitor.header?.(header);
        return;
      }
      if (!header) throw Error("Backup header must be first");
      if (entry.name === "manifest.json") {
        manifest = ManifestSchema.parse(
          JSON.parse((await readBounded(stream, 64 * 1024 * 1024)).toString()),
        );
        return;
      }
      const row = /^rows\/(app\.[a-z_]+|idx\.[a-z_]+)\/(0|[1-9][0-9]*)\.json$/.exec(entry.name);
      if (row) {
        const table = row[1] as string;
        quoteTable(table);
        const state = rows.get(table) ?? { count: 0, hash: createHash("sha256") };
        if (String(state.count) !== row[2]) throw Error("Duplicate or out-of-order backup row");
        const bytes = await readBounded(stream);
        const values = z.array(z.string().nullable()).max(200).parse(JSON.parse(bytes.toString()));
        const columns = header.schema[table];
        if (!columns || values.length !== columns.length)
          throw Error("Backup column count mismatch");
        state.hash.update(bytes);
        state.count++;
        rows.set(table, state);
        await visitor.row?.(table, columns, values);
        return;
      }
      if (/^blobs\/(0|[1-9][0-9]*)$/.test(entry.name) && !blobs.has(entry.name)) {
        const hash = createHash("sha256");
        let size = 0;
        const measured = Readable.from(
          (async function* () {
            for await (const chunk of stream) {
              hash.update(chunk);
              size += chunk.length;
              yield chunk;
            }
          })(),
        );
        if (visitor.blob) await visitor.blob(entry.name, measured);
        else
          for await (const _chunk of measured) {
            /* drain */
          }
        if (size !== entry.size) throw Error("Incomplete backup blob consumption");
        blobs.set(entry.name, { bytes: size, sha256: hash.digest("hex") });
        return;
      }
      throw Error("Unknown or duplicate backup entry");
    }
    void consume()
      .then(() => next())
      .catch((error: Error) => extract.destroy(error));
  });
  await pipeline(Readable.fromWeb(deciphered), createGunzip(), limitBytes(maxBytes), extract);
  if (!header || !manifest || manifest.id !== header.id) throw Error("Incomplete backup archive");
  const complete = manifest as SnapshotManifest;
  if (Object.keys(complete.tables).length !== DURABLE_TABLES.length)
    throw Error("Incomplete backup table inventory");
  for (const table of DURABLE_TABLES) {
    const actual = rows.get(table);
    const expected = complete.tables[table];
    const hash = actual?.hash.digest("hex") ?? createHash("sha256").digest("hex");
    if (!expected || expected.rows !== (actual?.count ?? 0) || expected.sha256 !== hash)
      throw Error(`Backup checksum mismatch: ${table}`);
  }
  if (
    complete.blobs.length !== blobs.size ||
    new Set(complete.blobs.map((blob) => blob.entry)).size !== blobs.size
  )
    throw Error("Backup blob inventory mismatch");
  for (const blob of complete.blobs) {
    const actual = blobs.get(blob.entry);
    if (!actual || actual.bytes !== blob.size || actual.sha256 !== blob.sha256)
      throw Error("Backup blob checksum mismatch");
  }
  return { header, manifest: complete };
}

export interface RestoreOptions {
  rehearsal?: boolean;
  pool: Pool;
  file: string;
  identity: string;
  stateDirectory: string;
  reseal(bytes: Uint8Array, context: string, sourceMaster: string): Uint8Array;
  secrets: SecretCodec;
}
/** Target must be a freshly migrated, unused database. Cutover is an operator action. */
export async function restoreArchive(options: RestoreOptions): Promise<Inspection> {
  const inspected = await inspectArchive(options.file, options.identity);
  const available = await statfs(options.stateDirectory);
  const required = inspected.manifest.blobs.reduce((sum, blob) => sum + blob.size, 0);
  if (required > available.bavail * available.bsize - 128 * 1024 * 1024)
    throw Error("Insufficient storage for staged recovery files");
  const client = await options.pool.connect();
  const stage = join(options.stateDirectory, `restore-${randomUUID()}`);
  let created = false;
  try {
    const schema = await describeSchema(client);
    if (
      JSON.stringify(await migrationHashes(client)) !== JSON.stringify(inspected.header.migrations)
    )
      throw Error("Restore requires the same trusted fdrive migration release");
    if (schemaFingerprint(schema) !== inspected.header.fingerprint)
      throw Error(
        "Restore requires the matching database schema; migrate a fresh database with the matching fdrive release",
      );
    await client.query("begin");
    await client.query("set local lock_timeout = '10s'");
    for (const table of DURABLE_TABLES)
      await client.query(`lock table ${quoteTable(table)} in access exclusive mode`);
    for (const table of DURABLE_TABLES) {
      const { rows } = await client.query(`select 1 from ${quoteTable(table)} limit 1`);
      if (rows.length) throw Error("Restore destination database is not empty");
    }
    await mkdir(stage, { recursive: false, mode: 0o700 });
    created = true;
    await inspectArchive(options.file, options.identity, {
      async row(table, columns, values) {
        const row = [...values];
        const position = (name: string) => columns.findIndex((column) => column.name === name);
        if (
          ["app.credentials", "app.backup_destinations", "app.backup_attachments"].includes(table)
        ) {
          const field = table === "app.credentials" ? "ciphertext" : "secret";
          const index = position(field);
          const id =
            row[
              position(
                table === "app.credentials"
                  ? "identity_id"
                  : table === "app.backup_attachments"
                    ? "version_id"
                    : "id",
              )
            ];
          if (index < 0 || !id || !row[index]?.startsWith("\\x"))
            throw Error("Invalid encrypted credential in backup");
          const context =
            table === "app.credentials"
              ? id
              : `${table === "app.backup_destinations" ? "backup-destination" : "backup-attachment"}:${id}`;
          row[index] =
            `\\x${Buffer.from(options.reseal(Buffer.from(row[index].slice(2), "hex"), context, inspected.header.masterKey)).toString("hex")}`;
        }
        const indices = columns
          .map((column, index) => ({ column, index }))
          .filter(({ column }) => !column.generated);
        await client.query(
          `insert into ${quoteTable(table)} (${indices.map(({ column }) => quoteIdentifier(column.name)).join(",")}) values (${indices.map((_, index) => `$${index + 1}`).join(",")})`,
          indices.map(({ index }) => row[index]),
        );
      },
      async blob(entry, stream) {
        const record = inspected.manifest.blobs.find((blob) => blob.entry === entry);
        if (!record) throw Error("Unexpected backup blob");
        if (record.kind === "attachment") {
          const attachment = (
            await client.query<{ secret: Buffer; sha256: string; bytes: string }>(
              "select secret,sha256,bytes from app.backup_attachments where version_id=$1",
              [record.path],
            )
          ).rows[0];
          if (
            !attachment ||
            attachment.sha256 !== record.sha256 ||
            attachment.bytes !== String(record.size)
          )
            throw Error("Attachment reference does not match captured bytes");
          const key = Buffer.from(
            options.secrets.open(attachment.secret, `backup-attachment:${record.path}`),
          ).toString();
          const encrypt = new Encrypter();
          encrypt.addRecipient(await identityToRecipient(key));
          await mkdir(join(stage, "attachments"), { recursive: true, mode: 0o700 });
          await pipeline(
            Readable.fromWeb(
              await encrypt.encrypt(Readable.toWeb(stream) as ReadableStream<Uint8Array>),
            ),
            createWriteStream(join(stage, "attachments", `${record.path}.age`), {
              flags: "wx",
              mode: 0o600,
            }),
          );
          await syncFile(join(stage, "attachments", `${record.path}.age`));
          await syncFile(join(stage, "attachments"));
        } else {
          await pipeline(
            stream,
            createWriteStream(join(stage, entry.replace("/", "-")), { flags: "wx", mode: 0o600 }),
          );
          await syncFile(join(stage, entry.replace("/", "-")));
        }
      },
    });
    await client.query("delete from app.api_tokens");
    await client.query(
      "delete from app.settings where key in ('backup.worker.v1','backup.estimate.v1')",
    );
    await client.query(
      "update idx.scans set finished_at=now(),errors=errors+1 where finished_at is null",
    );
    await client.query(
      "update idx.ocr_runs set finished_at=now(),failed=failed+1 where finished_at is null",
    );
    await client.query(
      `update app.settings set value=jsonb_set(value, '{values}', '{"thumbnails":false,"textSearch":false,"searchOcr":false,"semanticSearch":false,"imageSearch":false,"pdfOcr":false}') where key='features.configuration'`,
    );
    await client.query(
      `update app.settings set value=jsonb_set(jsonb_set(value, '{enabled}', 'false'), '{editingEnabled}', 'false') where key='office.configuration'`,
    );
    await client.query("update app.providers set enabled = false");
    await client.query(
      "update app.backup_configuration set restored = true, schedule = jsonb_set(schedule, '{frequency}', '\"manual\"'), next_run_at = null, challenge_hash = null, challenge_expires_at = null",
    );
    if (options.rehearsal)
      await client.query("update app.backup_configuration set installation_id=$1 where id=1", [
        randomUUID(),
      ]);
    await client.query("update app.backup_destinations set enabled = false, tested_at = null");
    await client.query(
      "update app.backup_runs set artifact = null, state = case when state in ('queued','capturing','transferring') then 'cancelled' else state end",
    );
    await client.query(
      "update app.desktop_effects set state = 'quarantined' where state = 'pending'",
    );
    await client.query(
      "update app.desktop_operations set state = 'uncertain' where state in ('receiving','uploading','ready','committing')",
    );
    await client.query(
      "insert into app.settings(key, value) values ('backup.restore.v1', $1::jsonb) on conflict(key) do update set value = excluded.value",
      [
        JSON.stringify({
          snapshotId: inspected.header.id,
          mode: options.rehearsal ? "rehearsal" : "replacement",
          stagedAt: new Date().toISOString(),
          stateDirectory: stage,
          blobs: inspected.manifest.blobs,
          coverage: inspected.manifest.coverage,
          environment: inspected.header.environment,
        }),
      ],
    );
    const sequences = await client.query<{ table: string; column: string; sequence: string }>(
      `select table_schema || '.' || table_name as "table", column_name as "column", pg_get_serial_sequence(quote_ident(table_schema)||'.'||quote_ident(table_name), column_name) as sequence from information_schema.columns where table_schema in ('app','idx') and column_default like 'nextval(%'`,
    );
    for (const sequence of sequences.rows) {
      if (!sequence.sequence || !(DURABLE_TABLES as readonly string[]).includes(sequence.table))
        continue;
      await client.query(
        `select setval($1::regclass, greatest(coalesce((select max(${quoteIdentifier(sequence.column)}) from ${quoteTable(sequence.table)}), 0) + 1, 1), false)`,
        [sequence.sequence],
      );
    }
    await writeFile(join(stage, "recovery-manifest.json"), JSON.stringify(inspected.manifest), {
      flag: "wx",
      mode: 0o600,
    });
    await syncFile(join(stage, "recovery-manifest.json"));
    await syncFile(stage);
    await syncFile(options.stateDirectory);
    await client.query("commit");
    return inspected;
  } catch (error) {
    await client.query("rollback").catch(ignoreCleanupError);
    if (created) await rm(stage, { recursive: true, force: true });
    throw error;
  } finally {
    client.release();
  }
}
export async function extractAttachment(
  file: string,
  identity: string,
  record: BlobRecord,
  output: string,
): Promise<void> {
  await inspectArchive(file, identity);
  let created = false;
  try {
    let found = false;
    await inspectArchive(file, identity, {
      async blob(entry, stream) {
        if (entry === record.entry) {
          found = true;
          const { open } = await import("node:fs/promises");
          const file = await open(output, "wx", 0o600);
          created = true;
          await pipeline(stream, file.createWriteStream());
        } else
          for await (const _chunk of stream) {
            /* drain */
          }
      },
    });
    if (!found) throw Error("Attachment not found");
    const result = await digest(fileStream(output));
    if (result.sha256 !== record.sha256) throw Error("Attachment integrity check failed");
  } catch (error) {
    if (created) await rm(output, { force: true });
    throw error;
  }
}
