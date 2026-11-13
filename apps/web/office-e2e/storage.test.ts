import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { run } from "./process";
import { fixtureState, type OfficeFixtureState } from "./state";
import {
  putExternally,
  storedBytes,
  storedMetadata,
  storedPath,
  storedText,
  storedXml,
} from "./storage";

let directory: string;
let state: OfficeFixtureState;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "office-storage-unit-"));
  const storageRoot = join(directory, "root");
  await mkdir(join(storageRoot, "alice"), { recursive: true });
  state = { directory, storageRoot } as OfficeFixtureState;
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("reads only the configured private fixture state", async () => {
  await expect(fixtureState("")).rejects.toThrow("not started");
  await writeFile(join(directory, "office.json"), JSON.stringify({ product: "onlyoffice" }));
  expect(await fixtureState(directory)).toEqual({ product: "onlyoffice" });
});

it("reads the literal path from alice's home and names a missing file", async () => {
  await writeFile(storedPath(state, "/Å %20.docx"), "saved");
  expect(Buffer.from(await storedBytes(state, "/Å %20.docx")).toString()).toBe("saved");
  await expect(storedBytes(state, "/missing.docx")).rejects.toThrow(
    "Stored file missing: /missing.docx",
  );
  await mkdir(storedPath(state, "/folder"));
  await expect(storedBytes(state, "/folder")).rejects.toThrow("EISDIR");
});

it("extracts real OOXML and tolerates the initial empty document", async () => {
  await writeFile(storedPath(state, "/empty.docx"), new Uint8Array());
  expect(await storedXml(state, "/empty.docx")).toBe("");
  await run("python3", [
    "-c",
    "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('word/document.xml','<p>saved text<span> &amp; more</span></p>')\n z.writestr('binary.bin',b'\\xff')",
    storedPath(state, "/x.docx"),
  ]);
  expect(await storedXml(state, "/x.docx")).toContain("<p>saved text<span> &amp; more</span></p>");
  expect(await storedText(state, "/x.docx")).toBe("saved text & more\n");
});

it("writes an outside edit in place and keeps its modification time", async () => {
  const target = storedPath(state, "/Å %20.docx");
  await writeFile(target, "before");
  const inode = (await stat(target)).ino;
  const local = join(directory, "a b");
  await writeFile(local, "edited");
  await utimes(local, 1_700_000_000, 1_700_000_000);
  await putExternally(state, local, "/Å %20.docx");
  expect(await readFile(target, "utf8")).toBe("edited");
  expect((await stat(target)).ino).toBe(inode);
  expect(await storedMetadata(state, "/Å %20.docx")).toEqual({
    size: 6,
    modifiedSeconds: 1_700_000_000,
  });
});

it("reads size and whole-second modification time, and only of files", async () => {
  const target = storedPath(state, "/x");
  await writeFile(target, "twelve bytes");
  await utimes(target, 1_700_000_000.75, 1_700_000_000.75);
  expect(await storedMetadata(state, "/x")).toEqual({ size: 12, modifiedSeconds: 1_700_000_000 });
  await mkdir(storedPath(state, "/folder"));
  await expect(storedMetadata(state, "/folder")).rejects.toThrow("metadata unavailable");
  await expect(storedMetadata(state, "/missing")).rejects.toThrow("ENOENT");
});
