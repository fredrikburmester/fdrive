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
} from "@fdrive/core";

/**
 * An in-memory `StorageProvider` for tests that need precise control over
 * content, timing and directory structure without a real backend. The
 * canonical fake: it passes `describeStorageProvider`, so a test written
 * against it holds for every real provider that passes the same suite.
 *
 * Maintains a parent -> children index incrementally, so a test can seed
 * thousands of entries and walk them without quadratic slowdown.
 */
export interface MemoryStorage extends StorageProvider {
  /** Every file's virtual path to its current utf8 content, for assertions. */
  dump(): Record<string, string>;
  /** Every directory's virtual path that currently exists, sorted, for assertions. */
  dirs(): string[];
}

export interface MemoryStorageOptions {
  /** Seeded files whose `statFile` reports a `null` mtime, to exercise that fallback. */
  readonly nullMtimePaths?: readonly string[];
  /** The mtime uploads get when the caller supplies none; defaults to the epoch. */
  readonly clock?: () => Date;
}

interface MemFile {
  content: Uint8Array;
  mtime: Date | null;
}

async function readAll(body: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return body;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Builds a `MemoryStorage` seeded with `files` (virtual path to utf8 string
 * or raw bytes). Every ancestor directory of a seeded file is created
 * implicitly.
 */
export function createMemoryStorage(
  files: Record<string, string | Uint8Array> = {},
  options: MemoryStorageOptions = {},
): MemoryStorage {
  const fileMap = new Map<string, MemFile>();
  const dirs = new Set<string>(["/"]);
  const childrenOf = new Map<string, Set<string>>([["/", new Set()]]);
  const nullMtimePaths = new Set((options.nullMtimePaths ?? []).map((path) => normalizePath(path)));
  const clock = options.clock ?? (() => new Date(0));

  /** Every parent has a children set by the time it gets a child: `addDir` creates it. */
  function addChild(parent: string, child: string): void {
    childrenOf.get(parent)?.add(child);
  }

  function removeChild(parent: string, child: string): void {
    childrenOf.get(parent)?.delete(child);
  }

  function addDir(path: string): void {
    if (dirs.has(path)) {
      return;
    }
    dirs.add(path);
    childrenOf.set(path, new Set());
    addChild(parentPath(path), path);
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
    if (!fileMap.has(normalized)) {
      addChild(parent, normalized);
    }
    fileMap.set(normalized, { content, mtime });
  }

  function removeFile(path: string): void {
    fileMap.delete(path);
    removeChild(parentPath(path), path);
  }

  function removeDirTree(path: string): void {
    const prefix = `${path}/`;
    for (const filePath of [...fileMap.keys()]) {
      if (filePath.startsWith(prefix)) {
        removeFile(filePath);
      }
    }
    for (const dirPath of [...dirs]) {
      if (dirPath === path || dirPath.startsWith(prefix)) {
        dirs.delete(dirPath);
        removeChild(parentPath(dirPath), dirPath);
        childrenOf.delete(dirPath);
      }
    }
  }

  /** Copies the tree at `source` to `target`, leaving `source` in place. */
  function copyTree(source: string, target: string): void {
    const prefix = `${source}/`;
    const treeDirs = [...dirs].filter(
      (dirPath) => dirPath === source || dirPath.startsWith(prefix),
    );
    const treeFiles = [...fileMap.entries()].filter(([filePath]) => filePath.startsWith(prefix));
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

  function listChildren(path: string): FileEntry[] | null {
    const normalized = normalizePath(path);
    if (!dirs.has(normalized)) {
      return null;
    }
    const childPaths = childrenOf.get(normalized) ?? new Set<string>();
    const result: FileEntry[] = [];
    for (const childPath of childPaths) {
      const name = baseName(childPath);
      const file = fileMap.get(childPath);
      if (file !== undefined) {
        result.push({
          name,
          path: childPath,
          kind: "file",
          size: file.content.length,
          modifiedAt: file.mtime ?? new Date(0),
          ext: extensionOf(name),
        });
      } else {
        result.push({
          name,
          path: childPath,
          kind: "dir",
          size: 0,
          modifiedAt: new Date(0),
          ext: "",
        });
      }
    }
    return result;
  }

  function requireFile(path: string): { normalized: string; file: MemFile } {
    const normalized = normalizePath(path);
    const file = fileMap.get(normalized);
    if (file === undefined) {
      throw new StorageError("not_found", `not found: ${path}`);
    }
    return { normalized, file };
  }

  function exists(path: string): boolean {
    return fileMap.has(path) || dirs.has(path);
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
      return [...dirs].sort();
    },

    async list(path: string): Promise<FileEntry[]> {
      const entries = listChildren(path);
      if (entries !== null) {
        return entries;
      }
      if (fileMap.has(normalizePath(path))) {
        throw new StorageError("bad_request", "not a directory");
      }
      throw new StorageError("not_found", `not found: ${path}`);
    },

    async probeDirectoryRead(path: string): Promise<void> {
      await storage.list(path);
    },

    async statFile(path: string) {
      const normalized = normalizePath(path);
      const file = fileMap.get(normalized);
      if (file === undefined) {
        if (dirs.has(normalized)) {
          throw new StorageError("bad_request", "is a directory");
        }
        throw new StorageError("not_found", `not found: ${path}`);
      }
      return { size: file.content.length, modifiedAt: file.mtime, contentType: null };
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
      if (dirs.has(normalized)) {
        return { kind: "dir", size: 0, modifiedAt: null, contentType: null };
      }
      throw new StorageError("not_found", `not found: ${path}`);
    },

    async download(path: string, opts) {
      const { file } = requireFile(path);
      if (opts?.signal?.aborted === true) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const content = file.content;
      const total = content.length;
      const range = opts?.range;
      if (range !== undefined && range.start < total) {
        const end = Math.min(range.end ?? total - 1, total - 1);
        const slice = content.slice(range.start, end + 1);
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
        body: streamOf(content),
        contentLength: total,
        contentRange: null,
        contentType: null,
        lastModified: file.mtime,
      };
    },

    async upload(path, body, opts): Promise<void> {
      const normalized = normalizePath(path);
      if (dirs.has(normalized)) {
        throw new StorageError("conflict", `a directory exists at ${path}`);
      }
      if (opts?.overwrite === false && fileMap.has(normalized)) {
        throw new StorageError("conflict", `target exists: ${path}`);
      }
      if (opts?.mkdirParents !== true && !dirs.has(parentPath(normalized))) {
        throw new StorageError("not_found", `parent not found: ${path}`);
      }
      const bytes = await readAll(body);
      putFile(normalized, bytes, opts?.modifiedAt ?? clock());
    },

    async mkdir(path, opts): Promise<void> {
      const normalized = normalizePath(path);
      if (fileMap.has(normalized)) {
        throw new StorageError("conflict", `a file exists at ${path}`);
      }
      if (opts?.parents !== true && !dirs.has(parentPath(normalized))) {
        throw new StorageError("not_found", `parent not found: ${path}`);
      }
      ensureDirsFor(parentPath(normalized));
      addDir(normalized);
    },

    async move(path, target, opts): Promise<void> {
      const source = normalizePath(path);
      const destination = normalizePath(target);
      if (!exists(source) || source === "/") {
        throw new StorageError("not_found", `not found: ${path}`);
      }
      if (exists(destination)) {
        if (opts?.overwrite !== true) {
          throw new StorageError("conflict", `target exists: ${target}`);
        }
        if (fileMap.has(destination)) {
          removeFile(destination);
        } else {
          removeDirTree(destination);
        }
      }
      const file = fileMap.get(source);
      if (file !== undefined) {
        removeFile(source);
        putFile(destination, file.content, file.mtime);
        return;
      }
      copyTree(source, destination);
      removeDirTree(source);
    },

    async copy(path, target, opts): Promise<void> {
      const source = normalizePath(path);
      const destination = normalizePath(target);
      if (!exists(source) || source === "/") {
        throw new StorageError("not_found", `not found: ${path}`);
      }
      if (exists(destination) && opts?.overwrite === false) {
        throw new StorageError("conflict", `target exists: ${target}`);
      }
      const file = fileMap.get(source);
      if (file !== undefined) {
        if (dirs.has(destination)) {
          removeDirTree(destination);
        }
        putFile(destination, file.content, file.mtime);
        return;
      }
      if (fileMap.has(destination)) {
        removeFile(destination);
      }
      copyTree(source, destination);
    },

    async deleteFile(path: string): Promise<void> {
      const { normalized } = requireFile(path);
      removeFile(normalized);
    },

    async deleteDir(path: string): Promise<void> {
      const normalized = normalizePath(path);
      if (!dirs.has(normalized)) {
        throw new StorageError("not_found", `not found: ${path}`);
      }
      if (normalized === "/") {
        for (const child of [...(childrenOf.get("/") ?? [])]) {
          if (fileMap.has(child)) {
            removeFile(child);
          } else {
            removeDirTree(child);
          }
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
