import type { EncryptedEntry, FsEntry, SearchHit } from "@fdrive/contracts";
import { encryptedSize } from "@fdrive/crypto";
import { describe, expect, it } from "vitest";
import { encryptedEntry, encryptedFolder } from "@/test-fixtures/encryption";
import { matchEncryptedNames, withEncryptedMatches } from "./search";

async function entries() {
  const { folder } = await encryptedFolder("/Home/Private");
  const dir = await encryptedEntry("/Home/Private", "Möten", folder, "dir");
  const file = await encryptedEntry(dir.path, "Möte mars.txt", folder, "file", encryptedSize(4));
  const other = await encryptedEntry("/Home/Private", "photo.jpg", folder);
  const listed: EncryptedEntry[] = [dir, file, other].map((entry) => ({
    path: entry.path,
    kind: entry.kind === "dir" ? "dir" : "file",
    size: entry.size,
    modifiedAt: entry.modifiedAt,
  }));
  return { folder, listed, dir, file };
}

describe("name search inside an encrypted folder", () => {
  it("finds names by any case and accent encoding, with where they are", async () => {
    const { folder, listed, dir, file } = await entries();
    const found = await matchEncryptedNames(listed, "/Home/Private", folder, "MÖTE");
    expect(found.folders.map((entry) => [entry.name, entry.path])).toEqual([["Möten", dir.path]]);
    expect(found.files).toHaveLength(1);
    expect(found.files[0]).toMatchObject({
      name: "Möte mars.txt",
      path: file.path,
      ext: ".txt",
      size: 4,
      where: "/Home/Private/Möten",
    });
  });

  it("finds nothing for an empty query, and stops at the limit", async () => {
    const { folder, listed } = await entries();
    expect(await matchEncryptedNames(listed, "/Home/Private", folder, "  ")).toEqual({
      folders: [],
      files: [],
    });
    const limited = await matchEncryptedNames(listed, "/Home/Private", folder, "o", 1);
    expect(limited.folders.length + limited.files.length).toBeLessThanOrEqual(2);
  });

  it("skips names that do not decrypt", async () => {
    const { folder, listed } = await entries();
    const foreign = (await encryptedFolder()).folder;
    expect((await matchEncryptedNames(listed, "/Home/Private", foreign, "m")).files).toEqual([]);
    const broken: EncryptedEntry = {
      path: "/Home/Private/clear.txt",
      kind: "file",
      size: 1,
      modifiedAt: new Date(0).toISOString(),
    };
    expect((await matchEncryptedNames([broken], "/Home/Private", folder, "clear")).files).toEqual(
      [],
    );
  });

  it("puts its matches before the server's, and keeps the server's without any", () => {
    const folder = { name: "F" } as FsEntry;
    const hit = { name: "h" } as SearchHit;
    const server = { folders: [folder], files: [hit], content: [hit] };
    expect(withEncryptedMatches(server, undefined)).toBe(server);
    expect(withEncryptedMatches(server, { folders: [], files: [] })).toBe(server);
    const mine = { name: "m" } as FsEntry;
    const merged = withEncryptedMatches(server, {
      folders: [mine],
      files: [{ ...hit, where: "/x" }],
    });
    expect(merged?.folders).toEqual([mine, folder]);
    expect(merged?.files).toHaveLength(2);
    expect(merged?.content).toEqual([hit]);
    expect(withEncryptedMatches(undefined, { folders: [mine], files: [] })?.folders).toEqual([
      mine,
    ]);
  });
});
