import {
  baseName,
  createRecycleFolderTrash,
  type EntryStat,
  extensionOf,
  type FileEntry,
  normalizePath,
  parentPath,
  StorageError,
  type StorageProvider,
  splitSegments,
} from "../index.js";

export interface MemoryStorage extends StorageProvider {
  dump(): Record<string, string>;
  dirs(): string[];
}

export interface MemoryStorageOptions {
  readonly nullMtimePaths?: readonly string[];
  /** Modification times of new files, and the names of new Trash leaves. */
  readonly clock?: () => Date;
}

interface MemFile {
  content: Uint8Array;
  mtime: Date | null;
  /** Like a disk's: every publish is a new inode, and every write moves the change time. */
  ino: bigint;
  ctimeNs: bigint;
}

/** The refusal for a name that is taken, worded as the local folder words it. */
function taken(path: string): StorageError {
  return new StorageError("conflict", `something already exists at ${path}`);
}

async function readAll(body: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  return body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function createMemoryStorage(
  files: Record<string, string | Uint8Array> = {},
  options: MemoryStorageOptions = {},
): MemoryStorage {
  const fileMap = new Map<string, MemFile>();
  /** Resumable uploads' bytes so far, by part id, until their final piece publishes them. */
  const parts = new Map<string, Uint8Array>();
  const childrenOf = new Map<string, Set<string>>([["/", new Set()]]);
  /** A folder's inode, kept across a move as a disk's rename keeps it. */
  const dirInodes = new Map<string, bigint>();
  const nullMtimePaths = new Set((options.nullMtimePaths ?? []).map((p) => normalizePath(p)));
  const clock = options.clock ?? (() => new Date(0));
  // BigInt() rather than literals: the web app type-checks this file for an older target.
  let ticks = BigInt(0);
  const tick = () => {
    ticks += BigInt(1);
    return ticks;
  };

  function isDir(p: string): boolean {
    return childrenOf.has(p);
  }

  function addDir(p: string, ino?: bigint): void {
    if (childrenOf.has(p)) return;
    childrenOf.set(p, new Set());
    dirInodes.set(p, ino ?? tick());
    childrenOf.get(parentPath(p))?.add(p);
  }

  function ensureDirsFor(path: string): void {
    let current = "/";
    for (const segment of splitSegments(path)) {
      current = `${current === "/" ? "" : current}/${segment}`;
      addDir(current);
    }
  }

  function putFile(path: string, content: Uint8Array, mtime: Date | null): void {
    const normalized = normalizePath(path);
    const parent = parentPath(normalized);
    ensureDirsFor(parent);
    childrenOf.get(parent)?.add(normalized);
    fileMap.set(normalized, { content, mtime, ino: tick(), ctimeNs: tick() });
  }

  function removeFile(path: string): void {
    fileMap.delete(path);
    childrenOf.get(parentPath(path))?.delete(path);
  }

  function removeDirTree(path: string): void {
    const prefix = `${path}/`;
    for (const filePath of [...fileMap.keys()]) {
      if (filePath.startsWith(prefix)) removeFile(filePath);
    }
    for (const dirPath of [...childrenOf.keys()]) {
      if (dirPath === path || dirPath.startsWith(prefix)) {
        childrenOf.get(parentPath(dirPath))?.delete(dirPath);
        childrenOf.delete(dirPath);
        dirInodes.delete(dirPath);
      }
    }
  }

  function copyTree(source: string, target: string): void {
    const prefix = `${source}/`;
    const treeDirs = [...childrenOf.keys()].filter((d) => d === source || d.startsWith(prefix));
    const treeFiles = [...fileMap.entries()].filter(([f]) => f.startsWith(prefix));
    ensureDirsFor(parentPath(target));
    addDir(target);
    for (const dirPath of treeDirs) {
      addDir(`${target}${dirPath.slice(source.length)}`);
    }
    for (const [filePath, entry] of treeFiles) {
      putFile(`${target}${filePath.slice(source.length)}`, entry.content, entry.mtime);
    }
  }

  /** Renames `source` to `target` as a disk does: every file and folder keeps its inode. */
  function renameTree(source: string, target: string): void {
    ensureDirsFor(parentPath(target));
    const file = fileMap.get(source);
    if (file !== undefined) {
      removeFile(source);
      childrenOf.get(parentPath(target))?.add(target);
      fileMap.set(target, { ...file, ctimeNs: tick() });
      return;
    }
    const prefix = `${source}/`;
    const treeDirs = [...childrenOf.keys()]
      .filter((d) => d === source || d.startsWith(prefix))
      .sort((a, b) => a.length - b.length)
      .map((d) => [d, dirInodes.get(d)] as const);
    const treeFiles = [...fileMap.entries()].filter(([f]) => f.startsWith(prefix));
    removeDirTree(source);
    for (const [dirPath, ino] of treeDirs) addDir(`${target}${dirPath.slice(source.length)}`, ino);
    for (const [filePath, entry] of treeFiles) {
      const moved = `${target}${filePath.slice(source.length)}`;
      childrenOf.get(parentPath(moved))?.add(moved);
      fileMap.set(moved, entry);
    }
  }

  for (const [path, content] of Object.entries(files)) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const normalized = normalizePath(path);
    putFile(normalized, bytes, nullMtimePaths.has(normalized) ? null : new Date(0));
  }

  function requireFile(path: string): { normalized: string; file: MemFile } {
    const normalized = normalizePath(path);
    const file = fileMap.get(normalized);
    if (!file) throw new StorageError("not_found", `not found: ${path}`);
    return { normalized, file };
  }

  const storage: Omit<MemoryStorage, "trash"> = {
    dump(): Record<string, string> {
      const result: Record<string, string> = {};
      for (const [path, file] of fileMap) {
        result[path] = new TextDecoder().decode(file.content);
      }
      return result;
    },

    dirs(): string[] {
      return [...childrenOf.keys()].sort();
    },

    async list(path: string): Promise<FileEntry[]> {
      const normalized = normalizePath(path);
      const childPaths = childrenOf.get(normalized);
      if (childPaths !== undefined) {
        return [...childPaths].map((childPath) => {
          const name = baseName(childPath);
          const file = fileMap.get(childPath);
          return file !== undefined
            ? {
                name,
                path: childPath,
                kind: "file",
                size: file.content.length,
                modifiedAt: file.mtime ?? new Date(0),
                ext: extensionOf(name),
              }
            : { name, path: childPath, kind: "dir", size: 0, modifiedAt: new Date(0), ext: "" };
        });
      }
      if (fileMap.has(normalized)) throw new StorageError("bad_request", "not a directory");
      throw new StorageError("not_found", `not found: ${path}`);
    },

    async probeDirectoryRead(path: string): Promise<void> {
      await storage.list(path);
    },

    async contentStamp(path: string) {
      const s = await storage.stat(path);
      if (s.kind === "dir") throw new StorageError("bad_request", "is a directory");
      const { file } = requireFile(path);
      return {
        size: file.content.length,
        mtimeNs: BigInt(file.mtime?.getTime() ?? 0) * BigInt(1_000_000),
        ino: file.ino,
        ctimeNs: file.ctimeNs,
      };
    },

    async statFile(path: string) {
      const s = await storage.stat(path);
      if (s.kind === "dir") throw new StorageError("bad_request", "is a directory");
      return { size: s.size, modifiedAt: s.modifiedAt, contentType: s.contentType };
    },

    async stat(path: string): Promise<EntryStat> {
      const normalized = normalizePath(path);
      const file = fileMap.get(normalized);
      if (file !== undefined) {
        return {
          kind: "file",
          size: file.content.length,
          modifiedAt: file.mtime,
          contentType: null,
          ino: file.ino,
        };
      }
      if (isDir(normalized)) {
        const ino = dirInodes.get(normalized);
        return {
          kind: "dir",
          size: 0,
          modifiedAt: null,
          contentType: null,
          ...(ino === undefined ? {} : { ino }),
        };
      }
      throw new StorageError("not_found", `not found: ${path}`);
    },

    async download(path: string, opts) {
      const { file } = requireFile(path);
      if (opts?.signal?.aborted === true) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const total = file.content.length;
      const range = opts?.range;
      if (range !== undefined && range.start < total) {
        const end = Math.min(range.end ?? total - 1, total - 1);
        const slice = file.content.slice(range.start, end + 1);
        return {
          status: 206 as const,
          body: streamOf(slice),
          contentLength: slice.length,
          contentRange: `bytes ${range.start}-${end}/${total}`,
          contentType: null,
          lastModified: file.mtime,
        };
      }
      return {
        status: 200 as const,
        body: streamOf(file.content),
        contentLength: total,
        contentRange: null,
        contentType: null,
        lastModified: file.mtime,
      };
    },

    async upload(path, body, opts): Promise<void> {
      const normalized = normalizePath(path);
      if (isDir(normalized)) throw new StorageError("conflict", `a directory exists at ${path}`);
      if (opts?.overwrite !== true && fileMap.has(normalized)) throw taken(path);
      if (opts?.mkdirParents !== true && !isDir(parentPath(normalized)))
        throw new StorageError("not_found", `parent not found: ${path}`);
      const bytes = await readAll(body);
      if (opts?.contentLength !== undefined && bytes.length !== opts.contentLength)
        throw new StorageError("bad_request", `upload ended after ${bytes.length} bytes: ${path}`);
      const part = opts?.part;
      let content = bytes;
      if (part !== undefined) {
        const held = parts.get(part.id) ?? new Uint8Array();
        if (held.length < part.offset)
          throw new StorageError("bad_request", `the upload has no byte ${part.offset}: ${path}`);
        content = new Uint8Array(part.offset + bytes.length);
        content.set(held.subarray(0, part.offset));
        content.set(bytes, part.offset);
        parts.set(part.id, content);
        if (!part.final) return;
        parts.delete(part.id);
      }
      putFile(normalized, content, opts?.modifiedAt ?? clock());
    },

    async mkdir(path, opts): Promise<void> {
      const normalized = normalizePath(path);
      if (fileMap.has(normalized)) throw new StorageError("conflict", `a file exists at ${path}`);
      if (opts?.parents !== true && !isDir(parentPath(normalized)))
        throw new StorageError("not_found", `parent not found: ${path}`);
      ensureDirsFor(parentPath(normalized));
      addDir(normalized);
    },

    async move(path, target, opts): Promise<void> {
      const destination = normalizePath(target);
      const source = normalizePath(path);
      const s = await storage.stat(source);
      if (source === "/") throw new StorageError("not_found", `not found: ${path}`);
      if (s.kind === "dir" && destination.startsWith(`${source}/`))
        throw new StorageError("bad_request", `cannot move ${path} into itself`);
      if (fileMap.has(destination) || isDir(destination)) {
        if (opts?.overwrite !== true) throw taken(target);
        if (isDir(destination)) removeDirTree(destination);
        else removeFile(destination);
      }
      renameTree(source, destination);
    },

    async copy(path, target, opts): Promise<void> {
      const source = normalizePath(path);
      const destination = normalizePath(target);
      if ((!fileMap.has(source) && !isDir(source)) || source === "/")
        throw new StorageError("not_found", `not found: ${path}`);
      if ((fileMap.has(destination) || isDir(destination)) && opts?.overwrite !== true)
        throw taken(target);
      const file = fileMap.get(source);
      if (file !== undefined) {
        if (isDir(destination)) removeDirTree(destination);
        putFile(destination, file.content, file.mtime);
        return;
      }
      if (fileMap.has(destination)) removeFile(destination);
      copyTree(source, destination);
    },

    async deleteFile(path: string): Promise<void> {
      const { normalized } = requireFile(path);
      removeFile(normalized);
    },

    async deleteDir(path: string): Promise<void> {
      const normalized = normalizePath(path);
      if (!isDir(normalized)) throw new StorageError("not_found", `not found: ${path}`);
      if (normalized === "/") {
        for (const child of [...(childrenOf.get("/") ?? [])]) {
          if (fileMap.has(child)) removeFile(child);
          else removeDirTree(child);
        }
        return;
      }
      removeDirTree(normalized);
    },

    async deleteEmptyDir(path: string): Promise<void> {
      const normalized = normalizePath(path);
      if (fileMap.has(normalized))
        throw new StorageError("bad_request", `not a directory: ${path}`);
      const children = childrenOf.get(normalized);
      if (children === undefined) throw new StorageError("not_found", `not found: ${path}`);
      if (normalized === "/") throw new StorageError("bad_request", "the root stays");
      if (children.size > 0) throw new StorageError("conflict", `not empty: ${path}`);
      removeDirTree(normalized);
    },

    async setModifiedAt(path: string, modifiedAt: Date): Promise<void> {
      const { file } = requireFile(path);
      file.mtime = modifiedAt;
      file.ctimeNs = tick();
    },
  };

  return Object.assign(storage, { trash: createRecycleFolderTrash({ storage, clock }) });
}
