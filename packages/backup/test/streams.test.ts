import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tar from "tar-stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeArchiveEntry } from "../src/snapshot.js";
import { localBlobs, readBounded } from "../src/streams.js";
import { required } from "./helpers.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "backup-streams-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
it("rejects archive entry writes when the destination errors or closes during backpressure", async () => {
  for (const error of [Error("disk failed"), undefined]) {
    const pack = tar.pack();
    pack.on("error", () => undefined);
    const pending = writeArchiveEntry(pack, "payload", Buffer.alloc(1024 * 1024));
    pack.destroy(error);
    await expect(pending).rejects.toThrow(error ? "disk failed" : "closed");
    await expect(writeArchiveEntry(pack, "later", Buffer.alloc(0))).rejects.toThrow("closed");
  }
});
it("preserves empty files and refuses source mutation while a file is being streamed", async () => {
  const path = join(directory, "file");
  await writeFile(path, Buffer.alloc(256 * 1024));
  const blob = required((await localBlobs(directory, "desktop"))[0]);
  const body = await blob.open();
  let changed = false;
  const reading = (async () => {
    for await (const _chunk of body) {
      if (!changed) {
        changed = true;
        await appendFile(path, "changed");
      }
    }
  })();
  await expect(reading).rejects.toThrow("changed while reading");
  await rm(path);
  await writeFile(join(directory, "empty"), "");
  expect(
    (await readBounded(await required((await localBlobs(directory, "desktop"))[0]).open())).length,
  ).toBe(0);
  await expect(localBlobs(join(directory, "empty"), "desktop")).rejects.toThrow("not a directory");
  await expect(localBlobs(directory, "desktop", 0)).rejects.toThrow("Too many");
  await mkdir(join(directory, "nested"));
  execFileSync("mkfifo", [join(directory, "nested", "pipe")]);
  await expect(localBlobs(directory, "desktop")).rejects.toThrow("Unsupported");
});
