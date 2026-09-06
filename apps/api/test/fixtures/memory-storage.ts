import {
  baseName,
  extensionOf,
  type FileEntry,
  joinPath,
  normalizePath,
  parentPath,
  StorageError,
  type StorageProvider,
  splitSegments,
} from "@fdrive/core";

/**
 * A tiny in-memory `StorageProvider`, for archive tests that need precise
 * control over content, timing, and failures without going through the
 * SFTPGo fake's HTTP layer. Not exercised by its own unit tests: this is a
 * test fixture, excluded from coverage by living under `test/` rather than
 * `src/`.
 */
export interface MemoryStorage extends StorageProvider {
  /** Every file's virtual path to its current utf8 content, for assertions. */
  dump(): Record<string, string>;
}

interface MemFile {
  content: Uint8Array;
  mtime: Date;
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
 * implicitly.
 */
export function createMemoryStorage(
  files: Record<string, string | Uint8Array> = {},
): MemoryStorage {
  const fileMap = new Map<string, MemFile>();
  const dirs = new Set<string>(["/"]);

  function ensureDirsFor(path: string): void {
    let current = "/";
    dirs.add(current);
    for (const segment of splitSegments(path)) {
      current = joinPath(current, segment);
      dirs.add(current);
    }
  }

  function putFile(path: string, content: Uint8Array, mtime: Date): void {
    const normalized = normalizePath(path);
    ensureDirsFor(parentPath(normalized));
    fileMap.set(normalized, { content, mtime });
  }

  for (const [path, content] of Object.entries(files)) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    putFile(path, bytes, new Date(0));
  }

  function listChildren(path: string): FileEntry[] | null {
    const normalized = normalizePath(path);
    if (!dirs.has(normalized)) {
      return null;
    }
    const byName = new Map<string, FileEntry>();
    for (const [filePath, file] of fileMap) {
      if (parentPath(filePath) === normalized) {
        const name = baseName(filePath);
        byName.set(name, {
          name,
          path: filePath,
          kind: "file",
          size: file.content.length,
          modifiedAt: file.mtime,
          ext: extensionOf(name),
        });
      }
    }
    for (const dirPath of dirs) {
      if (dirPath !== "/" && parentPath(dirPath) === normalized) {
        const name = baseName(dirPath);
        byName.set(name, {
          name,
          path: dirPath,
          kind: "dir",
          size: 0,
          modifiedAt: new Date(0),
          ext: "",
        });
      }
    }
    return [...byName.values()];
  }

  const storage: MemoryStorage = {
    dump(): Record<string, string> {
      const result: Record<string, string> = {};
      for (const [path, file] of fileMap) {
        result[path] = new TextDecoder().decode(file.content);
      }
      return result;
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
      ensureDirsFor(normalizePath(path));
      dirs.add(normalizePath(path));
    },

    async move(path: string, target: string): Promise<void> {
      const normalized = normalizePath(path);
      const file = fileMap.get(normalized);
      if (file === undefined) {
        throw new StorageError("not_found", `not found: ${path}`);
      }
      fileMap.delete(normalized);
      putFile(target, file.content, file.mtime);
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
    },

    async deleteDir(path: string): Promise<void> {
      dirs.delete(normalizePath(path));
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
