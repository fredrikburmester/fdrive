import {
  baseName,
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
  readonly clock?: () => Date;
}

interface MemFile {
  content: Uint8Array;
  mtime: Date | null;
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
  const childrenOf = new Map<string, Set<string>>([["/", new Set()]]);
  const nullMtimePaths = new Set((options.nullMtimePaths ?? []).map((p) => normalizePath(p)));
  const clock = options.clock ?? (() => new Date(0));

  function isDir(p: string): boolean {
    return childrenOf.has(p);
  }

  function addDir(p: string): void {
    if (childrenOf.has(p)) return;
    childrenOf.set(p, new Set());
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
    fileMap.set(normalized, { content, mtime });
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

  const storage: MemoryStorage = {
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
        };
      }
      if (isDir(normalized)) {
        return { kind: "dir", size: 0, modifiedAt: null, contentType: null };
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
      if (opts?.overwrite === false && fileMap.has(normalized))
        throw new StorageError("conflict", `target exists: ${path}`);
      if (opts?.mkdirParents !== true && !isDir(parentPath(normalized)))
        throw new StorageError("not_found", `parent not found: ${path}`);
      const bytes = await readAll(body);
      putFile(normalized, bytes, opts?.modifiedAt ?? clock());
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
      if (fileMap.has(destination) || isDir(destination)) {
        if (opts?.overwrite !== true)
          throw new StorageError("conflict", `target exists: ${target}`);
        if (isDir(destination)) removeDirTree(destination);
        else removeFile(destination);
      }
      await storage.copy(source, destination, opts);
      await (s.kind === "file" ? storage.deleteFile(source) : storage.deleteDir(source));
    },

    async copy(path, target, opts): Promise<void> {
      const source = normalizePath(path);
      const destination = normalizePath(target);
      if ((!fileMap.has(source) && !isDir(source)) || source === "/")
        throw new StorageError("not_found", `not found: ${path}`);
      if ((fileMap.has(destination) || isDir(destination)) && opts?.overwrite === false)
        throw new StorageError("conflict", `target exists: ${target}`);
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

    async setModifiedAt(path: string, modifiedAt: Date): Promise<void> {
      const { file } = requireFile(path);
      file.mtime = modifiedAt;
    },
  };

  return storage;
}
