import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BackupAttachmentInput } from "@fdrive/contracts";
import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import type { z } from "zod";
import type { AttachmentRecord, BackupStore } from "./store.js";
import { ignoreCleanupError, syncFile } from "./streams.js";
import type { BlobSource, SecretCodec } from "./types.js";

export class AttachmentStore {
  constructor(
    readonly store: BackupStore,
    readonly directory: string,
    readonly secrets: SecretCodec,
    readonly maxBytes = 256 * 1024 * 1024,
    readonly totalBytes = 2 * 1024 ** 3,
  ) {}
  path(version: string): string {
    if (!/^[a-f0-9-]{36}$/.test(version)) throw Error("Invalid attachment version");
    return join(this.directory, `${version}.age`);
  }
  async upload(
    input: z.infer<typeof BackupAttachmentInput>,
    body: Readable,
    id: string = randomUUID(),
  ): Promise<string> {
    const lease = await this.store.pool.connect();
    try {
      await lease.query("select pg_advisory_lock(736591206)");
      return await this.uploadLocked(input, body, id);
    } finally {
      await lease.query("select pg_advisory_unlock(736591206)").catch(ignoreCleanupError);
      lease.release();
    }
  }
  private async uploadLocked(
    input: z.infer<typeof BackupAttachmentInput>,
    body: Readable,
    id: string,
  ): Promise<string> {
    if (!input.filename.toLowerCase().endsWith(".zip") || /[\\/\r\n\0]/.test(input.filename))
      throw Error("Upload a ZIP with a simple filename");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const quota = (await this.store.attachments())
      .filter((row) => row.id !== id)
      .reduce((sum, row) => sum + Number(row.bytes), 0);
    const disk = await statfs(this.directory);
    const limit = Math.min(
      this.maxBytes,
      this.totalBytes - quota,
      Math.max(0, disk.bavail * disk.bsize - 64 * 1024 * 1024),
    );
    if (limit <= 0) throw Error("Configuration attachment storage is full");
    const version = randomUUID();
    const key = await generateIdentity();
    const encrypt = new Encrypter();
    encrypt.addRecipient(await identityToRecipient(key));
    const file = this.path(version);
    const hash = createHash("sha256");
    let bytes = 0;
    const stream = Readable.from(
      (async function* () {
        for await (const chunk of body) {
          bytes += chunk.length;
          if (bytes > limit) throw Error("Configuration ZIP exceeds storage quota");
          hash.update(chunk);
          yield chunk;
        }
        if (!bytes) throw Error("Configuration ZIP is empty");
      })(),
    );
    try {
      const encrypted = await encrypt.encrypt(Readable.toWeb(stream) as ReadableStream<Uint8Array>);
      await pipeline(
        Readable.fromWeb(encrypted),
        createWriteStream(`${file}.partial`, { flags: "wx", mode: 0o600 }),
      );
      await syncFile(`${file}.partial`);
      await rename(`${file}.partial`, file);
      await syncFile(this.directory);
      await this.store.saveAttachment({
        id,
        version_id: version,
        label: input.label,
        filename: input.filename,
        source_date: input.sourceDate ? new Date(input.sourceDate) : null,
        notes: input.notes,
        uploaded_at: new Date(),
        bytes: bytes.toString(),
        sha256: hash.digest("hex"),
        secret: Buffer.from(this.secrets.seal(Buffer.from(key), `backup-attachment:${version}`)),
      });
      return id;
    } catch (error) {
      await rm(`${file}.partial`, { force: true });
      await rm(file, { force: true });
      throw error;
    }
  }
  async download(record: AttachmentRecord): Promise<Readable> {
    const key = Buffer.from(
      this.secrets.open(record.secret, `backup-attachment:${record.version_id}`),
    ).toString();
    const decrypt = new Decrypter();
    decrypt.addIdentity(key);
    const body = Readable.fromWeb(
      await decrypt.decrypt(
        Readable.toWeb(
          createReadStream(this.path(record.version_id)),
        ) as ReadableStream<Uint8Array>,
      ),
    );
    return Readable.from(
      (async function* () {
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of body) {
          hash.update(chunk);
          bytes += chunk.length;
          yield chunk;
        }
        if (bytes !== Number(record.bytes) || hash.digest("hex") !== record.sha256)
          throw Error("Configuration ZIP integrity mismatch");
      })(),
    );
  }
  /** Called only under the exclusive capture gate; open downloads retain their descriptor. */
  async collect(): Promise<void> {
    const active = new Set((await this.store.attachments()).map((row) => `${row.version_id}.age`));
    for (const name of await readdir(this.directory).catch(() => []))
      if (/^[a-f0-9-]{36}\.age$/.test(name) && !active.has(name))
        await rm(join(this.directory, name), { force: true });
  }
  source(record: AttachmentRecord): BlobSource {
    return {
      kind: "attachment",
      path: record.version_id,
      size: Number(record.bytes),
      open: () => this.download(record),
    };
  }
}
