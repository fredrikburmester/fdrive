import type { FsEntry, TrashEntry } from "@fdrive/contracts";
import { decryptName, decryptStream, type FolderKey } from "@fdrive/crypto";
import { describe, expect, it } from "vitest";
import type { UploadItem } from "@/lib/upload/types";
import { encryptedEntry, encryptedFolder, stored } from "@/test-fixtures/encryption";
import { encryptBlob } from "./content";
import { crossesEdge, deleteForGood, planTransfer, type TransferApi } from "./transfer";

/** fdrive in memory: files by path, folders, Trash. */
function memoryApi(files: Map<string, Blob>, folders: Set<string>) {
  const trash: TrashEntry[] = [];
  const purged: string[] = [];
  const made: string[] = [];
  const children = (path: string): FsEntry[] => {
    const prefix = path === "/" ? "/" : `${path}/`;
    const direct = (candidate: string) =>
      candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/");
    return [
      ...[...folders].filter(direct).map((dir) => stored(path, dir.slice(prefix.length), "dir")),
      ...[...files]
        .filter(([file]) => direct(file))
        .map(([file, blob]) => stored(path, file.slice(prefix.length), "file", blob.size)),
    ];
  };
  const api = {
    list: async (path: string) => ({ path, entries: children(path) }),
    mkdir: async (path: string) => {
      made.push(path);
      folders.add(path);
      return stored("/", path.slice(1), "dir");
    },
    downloadUrl: (path: string) => `mem:${path}`,
    remove: async (items: { path: string }[]) => {
      for (const { path } of items) {
        files.delete(path);
        for (const folder of [...folders])
          if (folder === path || folder.startsWith(`${path}/`)) folders.delete(folder);
        trash.unshift({
          id: `t${trash.length}`,
          originalPath: path,
          name: path.split("/").at(-1) ?? "",
          size: 0,
          deletedAt: new Date(0).toISOString(),
        } as TrashEntry);
      }
      return { ok: true as const };
    },
    trashList: async () => ({ entries: trash, truncated: false }),
    trashPurge: async ({ ids }: { ids: string[] }) => {
      purged.push(...ids);
      return { ok: true as const };
    },
  } as unknown as TransferApi;
  const fetchImpl = (async (url: string) => {
    const blob = files.get(url.slice("mem:".length));
    return blob === undefined ? new Response(null, { status: 404 }) : new Response(blob);
  }) as unknown as typeof fetch;
  return { api, fetchImpl, trash, purged, made };
}

let counter = 0;
const deps = (api: TransferApi, fetchImpl: typeof fetch) => ({
  api,
  fetch: fetchImpl,
  id: () => `id${counter++}`,
});

async function text(blob: Blob, folder: FolderKey | null): Promise<string> {
  if (folder === null) return blob.text();
  return new Response(await decryptStream(blob.stream(), folder.identity)).text();
}

async function run(items: readonly UploadItem[]): Promise<Map<string, Blob>> {
  const sent = new Map<string, Blob>();
  for (const item of items) {
    sent.set(item.targetPath, (await item.source?.()) as Blob);
    await item.after?.();
  }
  return sent;
}

describe("moving across an encrypted folder's edge", () => {
  it("knows when a move crosses it", async () => {
    const { folder } = await encryptedFolder();
    const other = (await encryptedFolder()).folder;
    expect(crossesEdge(null, null)).toBe(false);
    expect(crossesEdge(folder, folder)).toBe(false);
    expect(crossesEdge(null, folder)).toBe(true);
    expect(crossesEdge(folder, null)).toBe(true);
    expect(crossesEdge(folder, other)).toBe(true);
  });

  it("moves a file in, encrypting it, and deletes the clear original for good", async () => {
    const { folder } = await encryptedFolder();
    const files = new Map([["/Docs/a.txt", new Blob(["alpha"])]]);
    const memory = memoryApi(files, new Set(["/Docs", "/Private"]));
    const [source] = (await memory.api.list("/Docs")).entries;
    const items = await planTransfer(
      { sources: [source as FsEntry], from: null, target: "/Private", to: folder, move: true },
      deps(memory.api, memory.fetchImpl),
    );
    expect(items[0]?.relativePath).toBe("a.txt");
    const sent = await run(items);
    const [[target, blob]] = [...sent] as [[string, Blob]];
    expect(await decryptName(target.split("/")[2] ?? "", folder.nameKey, folder.id)).toBe("a.txt");
    expect(await text(blob, folder)).toBe("alpha");
    expect(files.has("/Docs/a.txt")).toBe(false);
    expect(memory.purged).toEqual(["t0"]);
  });

  it("copies a folder out, decrypting names and files, and leaves the original", async () => {
    const { folder } = await encryptedFolder();
    const dir = await encryptedEntry("/Private", "Receipts", folder, "dir");
    const file = await encryptedEntry(dir.path, "march.pdf", folder);
    const files = new Map([[file.path, await encryptBlob(new Blob(["pdf"]), folder.recipient)]]);
    const memory = memoryApi(files, new Set(["/Private", dir.path, "/Docs"]));
    const shown = { ...dir, name: "Receipts" };
    const items = await planTransfer(
      { sources: [shown], from: folder, target: "/Docs", to: null, move: false },
      deps(memory.api, memory.fetchImpl),
    );
    expect(memory.made).toEqual(["/Docs/Receipts"]);
    expect(items.map((item) => item.relativePath)).toEqual(["Receipts/march.pdf"]);
    expect(items[0]?.after).toBeUndefined();
    const sent = await run(items);
    expect(await text(sent.get("/Docs/Receipts/march.pdf") as Blob, null)).toBe("pdf");
    expect(files.has(file.path)).toBe(true);
  });

  it("moves a folder once its last file has gone, and an empty one at once", async () => {
    const { folder } = await encryptedFolder();
    const files = new Map([
      ["/Docs/Trip/a.jpg", new Blob(["a"])],
      ["/Docs/Trip/b.jpg", new Blob(["b"])],
    ]);
    const memory = memoryApi(files, new Set(["/Docs", "/Docs/Trip", "/Docs/Empty", "/Private"]));
    const listed = (await memory.api.list("/Docs")).entries;
    const trip = listed.find((entry) => entry.name === "Trip") as FsEntry;
    const items = await planTransfer(
      { sources: [trip], from: null, target: "/Private", to: folder, move: true },
      deps(memory.api, memory.fetchImpl),
    );
    expect(items).toHaveLength(2);
    await items[0]?.source?.();
    await items[0]?.after?.();
    expect((await memory.api.list("/Docs")).entries.some((e) => e.name === "Trip")).toBe(true);
    await items[1]?.after?.();
    expect((await memory.api.list("/Docs")).entries.some((e) => e.name === "Trip")).toBe(false);

    const empty = (await memory.api.list("/Docs")).entries.find((e) => e.name === "Empty");
    const none = await planTransfer(
      { sources: [empty as FsEntry], from: null, target: "/Private", to: folder, move: true },
      deps(memory.api, memory.fetchImpl),
    );
    expect(none).toEqual([]);
    expect(folderExists(memory, "/Docs/Empty")).toBe(false);
  });

  it("moves between two encrypted folders, re-encrypting under the other's key", async () => {
    const a = (await encryptedFolder("/A")).folder;
    const b = (await encryptedFolder("/B")).folder;
    const file = await encryptedEntry("/A", "x.txt", a);
    const files = new Map([[file.path, await encryptBlob(new Blob(["moved"]), a.recipient)]]);
    const memory = memoryApi(files, new Set(["/A", "/B"]));
    const items = await planTransfer(
      { sources: [{ ...file, name: "x.txt" }], from: a, target: "/B", to: b, move: true },
      deps(memory.api, memory.fetchImpl),
    );
    const sent = await run(items);
    const [[target, blob]] = [...sent] as [[string, Blob]];
    expect(await decryptName(target.split("/")[2] ?? "", b.nameKey, b.id)).toBe("x.txt");
    expect(await text(blob, b)).toBe("moved");
  });

  it("refuses a name that does not decrypt, and a source fdrive does not list", async () => {
    const { folder } = await encryptedFolder();
    const memory = memoryApi(
      new Map([["/Private/clear.txt", new Blob(["x"])]]),
      new Set(["/Private"]),
    );
    await expect(
      planTransfer(
        {
          sources: [stored("/Private", "clear.txt")],
          from: folder,
          target: "/",
          to: null,
          move: true,
        },
        deps(memory.api, memory.fetchImpl),
      ),
    ).rejects.toThrow("cannot be moved");
    // Something no longer listed plans from what the caller knew of it, at the top.
    const gone = await planTransfer(
      {
        sources: [stored("/", "gone.txt")],
        from: null,
        target: "/Private",
        to: folder,
        move: false,
      },
      deps(memory.api, memory.fetchImpl),
    );
    await expect(gone[0]?.source?.()).rejects.toThrow("404");
  });

  it("deletes for good even when Trash does not list the item", async () => {
    const memory = memoryApi(new Map(), new Set());
    const api = { ...memory.api, trashList: async () => ({ entries: [], truncated: false }) };
    await deleteForGood(api as TransferApi, stored("/", "x", "dir"));
    expect(memory.purged).toEqual([]);
  });
});

function folderExists(memory: ReturnType<typeof memoryApi>, path: string): boolean {
  return memory.trash.every((item) => item.originalPath !== path) === true;
}
