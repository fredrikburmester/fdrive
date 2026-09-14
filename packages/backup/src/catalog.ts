import { open, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  digest,
  fileStream,
  ignoreCleanupError,
  limitBytes,
  readBounded,
  syncFile,
} from "./streams.js";
import type { BackupDestination } from "./types.js";
export const Completion = z
  .object({
    format: z.literal(1),
    installationId: z.uuid(),
    id: z.uuid(),
    createdAt: z.iso.datetime(),
    key: z.string().regex(/^[a-f0-9-]{36}\.fdrive\.age$/),
    bytes: z.string().regex(/^\d+$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    versionId: z.string().nullable(),
    coverage: z.array(z.string()).max(1000),
  })
  .strict();
export type Completion = z.infer<typeof Completion>;
export async function readCompletion(
  destination: BackupDestination,
  id: string,
): Promise<Completion> {
  z.uuid().parse(id);
  const record = Completion.parse(
    JSON.parse(
      (await readBounded(await destination.get(`${id}.complete.json`), 128 * 1024)).toString(),
    ),
  );
  if (record.id !== id || record.key !== `${id}.fdrive.age`)
    throw Error("Completion record binding mismatch");
  return record;
}
export async function discoverBackups(destination: BackupDestination): Promise<Completion[]> {
  const results: Completion[] = [];
  for (const name of await destination.list()) {
    const match = /^([a-f0-9-]{36})\.complete\.json$/.exec(name);
    if (!match) continue;
    results.push(await readCompletion(destination, match[1] as string));
  }
  return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function fetchBackup(
  destination: BackupDestination,
  id: string,
  output: string,
): Promise<void> {
  const record = await readCompletion(destination, id);
  const file = await open(output, "wx", 0o600);
  try {
    const size = Number(record.bytes);
    if (!Number.isSafeInteger(size) || size > 1024 ** 4)
      throw Error("Backup exceeds download limit");
    await pipeline(
      await destination.get(record.key, record.versionId ?? undefined),
      limitBytes(size),
      file.createWriteStream(),
    );
    await syncFile(output);
    await file.close();
    const bytes = await digest(fileStream(output));
    if (bytes.bytes !== size || bytes.sha256 !== record.sha256)
      throw Error("Downloaded archive checksum mismatch");
  } catch (error) {
    await file.close().catch(ignoreCleanupError);
    await rm(output, { force: true });
    throw error;
  }
}
