import {
  baseName,
  extensionOf,
  type FileEntry,
  normalizePath,
  parentPath,
  StorageError,
  type StorageProvider,
  splitSegments,
} from "../../src/index.ts";

/**
 * A tiny in-memory `StorageProvider`, for trash tests that need precise
 * control over content, timing, and directory structure without a real
 * provider. Not exercised by its own unit tests: this is a test fixture,
 * excluded from coverage by living under `test/` rather than `src/`.
 *
 * Maintains a parent -> children index incrementally (rather than scanning
 * every file and directory on every `list`), so a test can seed thousands of
 * trash leaves and walk them without quadratic slowdown.
 */
export interface MemoryStorage extends StorageProvider {
  /** Every file's virtual path to its current utf8 content, for assertions. */
  dump(): Record<string, string>;
  /** Every directory's virtual path that currently exists, for assertions. */
  dirs(): string[];
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

/**
 * Builds a `MemoryStorage` seeded with `files` (virtual path -> utf8 string
 * or raw bytes). Every ancestor directory of a seeded file is created
 * implicitly. Every seeded file's mtime is `new Date(0)` unless it is listed
 * in `nullMtimePaths`, in which case `statFile` reports a `null` mtime (used
 * to exercise the fallback when a provider does not report one).
 */
export function createMemoryStorage(
  files: Record<string, string | Uint8Array> = {},
  options: { nullMtimePaths?: readonly string[] } = {},
): MemoryStorage {
  const fileMap = new Map<string, MemFile>();
  const dirs = new Set<string>(["/"]);
  const childrenOf = new Map<string, Set<string>>([["/", new Set()]]);
  const nullMtimePaths = new Set((options.nullMtimePaths ?? []).map((path) => normalizePath(path)));

  function addChild(parent: string, child: string): void {
    let siblings = childrenOf.get(parent);
    if (siblings === undefined) {
      siblings = new Set();
      childrenOf.set(parent, siblings);
    }
    siblings.add(child);
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

    async stat(path: string) {
      const normalized = normalizePath(path);
      const file = fileMap.get(normalized);
      if (file !== undefined) {
        return {
          kind: "file" as const,
          size: file.content.length,
          modifiedAt: file.mtime,
          contentType: null,
        };
      }
      if (dirs.has(normalized)) {
        return { kind: "dir" as const, size: 0, modifiedAt: null, contentType: null };
      }
      throw new StorageError("not_found", `not found: ${path}`);
    },

    async download(path: string) {
      const normalized = normalizePath(path);
      const file = fileMap.get(normalized);
      if (file === undefined) {
        throw new StorageError("not_found", `not found: ${path}`);
      }
      const content = file.content;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(content);
          controller.close();
        },
      });
      return {
        status: 200 as const,
        body,
        contentLength: content.length,
        contentRange: null,
        contentType: null,
        lastModified: file.mtime,
      };
    },

    async upload(
      path: string,
      body: ReadableStream<Uint8Array> | Uint8Array,
      opts?: { modifiedAt?: Date },
    ): Promise<void> {
      const bytes = await readAll(body);
      putFile(path, bytes, opts?.modifiedAt ?? new Date(0));
    },

    async mkdir(path: string): Promise<void> {
      const normalized = normalizePath(path);
      ensureDirsFor(parentPath(normalized));
      addDir(normalized);
    },

    async move(path: string, target: string): Promise<void> {
      const normalizedSource = normalizePath(path);
      const normalizedTarget = normalizePath(target);
      if (fileMap.has(normalizedTarget) || dirs.has(normalizedTarget)) {
        throw new StorageError("conflict", `target exists: ${target}`);
      }
      const file = fileMap.get(normalizedSource);
      if (file !== undefined) {
        fileMap.delete(normalizedSource);
        removeChild(parentPath(normalizedSource), normalizedSource);
        putFile(normalizedTarget, file.content, file.mtime);
        return;
      }
      if (!dirs.has(normalizedSource) || normalizedSource === "/") {
        throw new StorageError("not_found", `not found: ${path}`);
      }
      const prefix = `${normalizedSource}/`;
      const movedFiles = [...fileMap.entries()].filter(([filePath]) => filePath.startsWith(prefix));
      const movedDirs = [...dirs].filter(
        (dirPath) => dirPath === normalizedSource || dirPath.startsWith(prefix),
      );
      for (const [filePath] of movedFiles) {
        fileMap.delete(filePath);
        removeChild(parentPath(filePath), filePath);
      }
      for (const dirPath of movedDirs) {
        dirs.delete(dirPath);
        removeChild(parentPath(dirPath), dirPath);
        childrenOf.delete(dirPath);
      }
      ensureDirsFor(parentPath(normalizedTarget));
      addDir(normalizedTarget);
      for (const dirPath of movedDirs) {
        addDir(`${normalizedTarget}${dirPath.slice(normalizedSource.length)}`);
      }
      for (const [filePath, entry] of movedFiles) {
        putFile(
          `${normalizedTarget}${filePath.slice(normalizedSource.length)}`,
          entry.content,
          entry.mtime,
        );
      }
    },

    async copy(path: string, target: string): Promise<void> {
      const normalized = normalizePath(path);
      const file = fileMap.get(normalized);
      if (file === undefined) {
        throw new StorageError("not_found", `not found: ${path}`);
      }
      putFile(target, file.content, file.mtime);
    },

    async deleteFile(path: string): Promise<void> {
      const normalized = normalizePath(path);
      if (!fileMap.delete(normalized)) {
        throw new StorageError("not_found", `not found: ${path}`);
      }
      removeChild(parentPath(normalized), normalized);
    },

    async deleteDir(path: string): Promise<void> {
      const normalized = normalizePath(path);
      if (!dirs.has(normalized)) {
        throw new StorageError("not_found", `not found: ${path}`);
      }
      const prefix = normalized === "/" ? "/" : `${normalized}/`;
      for (const filePath of [...fileMap.keys()]) {
        if (filePath === normalized || filePath.startsWith(prefix)) {
          fileMap.delete(filePath);
          removeChild(parentPath(filePath), filePath);
        }
      }
      for (const dirPath of [...dirs]) {
        if (dirPath !== "/" && (dirPath === normalized || dirPath.startsWith(prefix))) {
          dirs.delete(dirPath);
          removeChild(parentPath(dirPath), dirPath);
          childrenOf.delete(dirPath);
        }
      }
    },

    async setModifiedAt(path: string, modifiedAt: Date): Promise<void> {
      const normalized = normalizePath(path);
      const file = fileMap.get(normalized);
      if (file === undefined) {
        throw new StorageError("not_found", `not found: ${path}`);
      }
      file.mtime = modifiedAt;
    },

    async zip(): Promise<ReadableStream<Uint8Array>> {
      throw new Error("not implemented in MemoryStorage");
    },
  };

  return storage;
}
