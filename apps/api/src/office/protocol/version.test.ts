import { createMemoryStorage } from "@fdrive/testkit";
import { expect, it, vi } from "vitest";
import { deriveFileVersion, documentVersion } from "./version.ts";

const stamp = { size: 5, mtimeNs: 1788652800123456789n, ino: 7n, ctimeNs: 1788652800123456789n };

it("derives a short opaque version that changes with every part of the stamp", () => {
  const version = deriveFileVersion(stamp);
  expect(version).toMatch(/^[0-9a-f]{32}$/);
  expect(deriveFileVersion({ ...stamp })).toBe(version);
  const changed = [
    { ...stamp, size: 6 },
    { ...stamp, mtimeNs: stamp.mtimeNs + 1n },
    { ...stamp, ino: 8n },
    { ...stamp, ctimeNs: stamp.ctimeNs + 1n },
  ].map(deriveFileVersion);
  expect(new Set([version, ...changed]).size).toBe(5);
});

it("versions a document from its stamp without reading it", async () => {
  const storage = createMemoryStorage({ "/a.docx": "hello", "/b.docx": "hello" });
  const download = vi.spyOn(storage, "download");
  const first = await documentVersion(storage, "/a.docx");
  expect(first).toMatchObject({ size: 5, modifiedAt: new Date(0) });
  expect(await documentVersion(storage, "/a.docx")).toEqual(first);
  // Same size and modification time, as an external writer keeping the mtime would leave it.
  await storage.upload("/a.docx", new TextEncoder().encode("world"), { modifiedAt: new Date(0) });
  const replaced = await documentVersion(storage, "/a.docx");
  expect(replaced).toMatchObject({ size: 5, modifiedAt: new Date(0) });
  expect(replaced.version).not.toBe(first.version);
  expect((await documentVersion(storage, "/b.docx")).version).not.toBe(first.version);
  expect(download).not.toHaveBeenCalled();
});

it("fails as the storage does, and refuses storage without stamps", async () => {
  const storage = createMemoryStorage({});
  await expect(documentVersion(storage, "/missing.docx")).rejects.toMatchObject({
    kind: "not_found",
  });
  const { contentStamp: _unstamped, ...unstamped } = storage;
  await expect(documentVersion(unstamped, "/a.docx")).rejects.toThrow("stamps its files");
});
