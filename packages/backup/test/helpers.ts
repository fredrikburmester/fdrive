import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { BackupDestination, SecretCodec } from "../src/types.js";
/** Deterministic injectable envelope for orchestration tests; production AES is tested in API. */
export const secrets: SecretCodec = {
  seal(bytes, context) {
    return Buffer.from(JSON.stringify({ context, bytes: Buffer.from(bytes).toString("base64") }));
  },
  open(bytes, context) {
    const value = JSON.parse(Buffer.from(bytes).toString()) as { context: string; bytes: string };
    if (value.context !== context) throw Error("wrong envelope context");
    return Buffer.from(value.bytes, "base64");
  },
};
export function memoryDestination() {
  const objects = new Map<string, { bytes: Buffer; versionId: string }>();
  let fail = false,
    locked = false;
  const destination: BackupDestination = {
    async information(key) {
      const item = objects.get(key);
      if (!item) return null;
      return locked
        ? { versionId: item.versionId, retentionUntil: "2030-01-01T00:00:00.000Z" }
        : { versionId: item.versionId };
    },
    async put(key, file, signal) {
      signal?.throwIfAborted();
      if (fail) throw Error("offline");
      const versionId = randomUUID();
      objects.set(key, { bytes: await readFile(file), versionId });
      return { versionId };
    },
    async get(key, versionId) {
      if (fail) throw Error("offline");
      const row = objects.get(key);
      if (!row || (versionId && row.versionId !== versionId)) throw Error("missing");
      return Readable.from([row.bytes]);
    },
    async list() {
      return [...objects.keys()];
    },
    async remove(key) {
      if (locked) throw Error("Object Lock");
      objects.delete(key);
    },
  };
  return {
    objects,
    destination,
    offline(value: boolean) {
      fail = value;
    },
    lock(value: boolean) {
      locked = value;
    },
  };
}

export function required<T>(value: T | null | undefined): T {
  if (value == null) throw Error("Expected fixture value");
  return value;
}
