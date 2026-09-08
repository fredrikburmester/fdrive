import { StorageError, type StorageProvider } from "@fdrive/core";
import { describe, expect, it, vi } from "vitest";
import { createReadAuthorizer } from "./read-authorizer.ts";

function fakeDownloadResult(): {
  result: Awaited<ReturnType<StorageProvider["download"]>>;
  cancelSpy: ReturnType<typeof vi.fn>;
} {
  const cancelSpy = vi.fn(async () => {});
  const body = { cancel: cancelSpy } as unknown as ReadableStream<Uint8Array>;
  return {
    result: {
      status: 200,
      body,
      contentLength: null,
      contentRange: null,
      contentType: null,
      lastModified: null,
    },
    cancelSpy,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createReadAuthorizer: files", () => {
  it("allows a file it can download, and cancels the body without reading it", async () => {
    const { result, cancelSpy } = fakeDownloadResult();
    const download = vi.fn(async () => result);
    const authorizer = createReadAuthorizer({
      storage: { download, list: vi.fn() } as unknown as Pick<StorageProvider, "list" | "download">,
    });

    expect(await authorizer.authorize({ kind: "file", path: "/a.txt" })).toEqual({
      allowed: true,
    });
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("maps not_found to missing", async () => {
    const download = vi.fn(async () => {
      throw new StorageError("not_found", "no such file");
    });
    const authorizer = createReadAuthorizer({
      storage: { download, list: vi.fn() } as unknown as Pick<StorageProvider, "list" | "download">,
    });

    expect(await authorizer.authorize({ kind: "file", path: "/gone.txt" })).toEqual({
      allowed: false,
      reason: "missing",
    });
  });

  it("maps forbidden and unauthorized to denied", async () => {
    for (const kind of ["forbidden", "unauthorized"] as const) {
      const download = vi.fn(async () => {
        throw new StorageError(kind, "no");
      });
      const authorizer = createReadAuthorizer({
        storage: { download, list: vi.fn() } as unknown as Pick<
          StorageProvider,
          "list" | "download"
        >,
      });
      expect(await authorizer.authorize({ kind: "file", path: "/x" })).toEqual({
        allowed: false,
        reason: "denied",
      });
    }
  });

  it("maps every other storage error kind, and a non-storage error, to unavailable", async () => {
    const download = vi.fn(async () => {
      throw new StorageError("upstream_unavailable", "down");
    });
    const authorizer = createReadAuthorizer({
      storage: { download, list: vi.fn() } as unknown as Pick<StorageProvider, "list" | "download">,
    });
    expect(await authorizer.authorize({ kind: "file", path: "/x" })).toEqual({
      allowed: false,
      reason: "unavailable",
    });

    const download2 = vi.fn(async () => {
      throw new Error("network exploded");
    });
    const authorizer2 = createReadAuthorizer({
      storage: { download: download2, list: vi.fn() } as unknown as Pick<
        StorageProvider,
        "list" | "download"
      >,
    });
    expect(await authorizer2.authorize({ kind: "file", path: "/x" })).toEqual({
      allowed: false,
      reason: "unavailable",
    });
  });
});

describe("createReadAuthorizer: directories", () => {
  it("prefers probeDirectoryRead over list when available", async () => {
    const probeDirectoryRead = vi.fn(async () => undefined);
    const list = vi.fn(async () => []);
    const download = vi.fn();
    const authorizer = createReadAuthorizer({
      storage: { probeDirectoryRead, list, download },
    });

    expect(await authorizer.authorize({ kind: "dir", path: "/folder" })).toEqual({
      allowed: true,
    });
    expect(probeDirectoryRead).toHaveBeenCalledWith("/folder");
    expect(list).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("does not fall back to list when probeDirectoryRead rejects", async () => {
    const probeDirectoryRead = vi.fn(async () => {
      throw new StorageError("forbidden", "permission denied");
    });
    const list = vi.fn(async () => []);
    const authorizer = createReadAuthorizer({
      storage: { probeDirectoryRead, list, download: vi.fn() },
    });

    expect(await authorizer.authorize({ kind: "dir", path: "/folder" })).toEqual({
      allowed: false,
      reason: "denied",
    });
    expect(probeDirectoryRead).toHaveBeenCalledWith("/folder");
    expect(list).not.toHaveBeenCalled();
  });

  it("falls back to list when probeDirectoryRead is undefined", async () => {
    const list = vi.fn(async () => []);
    const download = vi.fn();
    const authorizer = createReadAuthorizer({
      storage: { list, download },
    });

    expect(await authorizer.authorize({ kind: "dir", path: "/folder" })).toEqual({
      allowed: true,
    });
    expect(list).toHaveBeenCalledWith("/folder");
    expect(download).not.toHaveBeenCalled();
  });

  it("maps a list failure the same way as a download failure", async () => {
    const list = vi.fn(async () => {
      throw new StorageError("forbidden", "no");
    });
    const authorizer = createReadAuthorizer({
      storage: { list, download: vi.fn() },
    });
    expect(await authorizer.authorize({ kind: "dir", path: "/folder" })).toEqual({
      allowed: false,
      reason: "denied",
    });
  });
});

describe("createReadAuthorizer: deduping", () => {
  it("reuses one probe for duplicate targets within the same authorizer", async () => {
    const { result } = fakeDownloadResult();
    const download = vi.fn(async () => result);
    const authorizer = createReadAuthorizer({
      storage: { download, list: vi.fn() } as unknown as Pick<StorageProvider, "list" | "download">,
    });

    const [a, b] = await Promise.all([
      authorizer.authorize({ kind: "file", path: "/a.txt" }),
      authorizer.authorize({ kind: "file", path: "/a.txt" }),
    ]);
    expect(a).toEqual({ allowed: true });
    expect(b).toEqual({ allowed: true });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("reuses the cached result for a second call after the first completes", async () => {
    const { result } = fakeDownloadResult();
    const download = vi.fn(async () => result);
    const authorizer = createReadAuthorizer({
      storage: { download, list: vi.fn() } as unknown as Pick<StorageProvider, "list" | "download">,
    });

    await authorizer.authorize({ kind: "file", path: "/a.txt" });
    await authorizer.authorize({ kind: "file", path: "/a.txt" });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("treats different kinds for the same path as distinct targets", async () => {
    const { result } = fakeDownloadResult();
    const download = vi.fn(async () => result);
    const list = vi.fn(async () => []);
    const authorizer = createReadAuthorizer({
      storage: { download, list } as unknown as Pick<StorageProvider, "list" | "download">,
    });

    await authorizer.authorize({ kind: "file", path: "/same" });
    await authorizer.authorize({ kind: "dir", path: "/same" });
    expect(download).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe("createReadAuthorizer: bounded concurrency", () => {
  it("never runs more than the configured number of probes at once", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    let active = 0;
    let maxActive = 0;

    const list = vi.fn(async (path: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const gate = deferred<void>();
      gates.set(path, gate);
      await gate.promise;
      active -= 1;
      return [];
    });

    const authorizer = createReadAuthorizer({
      storage: { list, download: vi.fn() } as unknown as Pick<StorageProvider, "list" | "download">,
      concurrency: 2,
    });

    const paths = ["/a", "/b", "/c", "/d"];
    const pending = paths.map((path) => authorizer.authorize({ kind: "dir", path: path }));

    // Let the first wave of microtasks run so the first two probes start.
    await Promise.resolve();
    await Promise.resolve();
    expect(active).toBe(2);

    for (const path of paths) {
      // Release probes one at a time, waiting for the next to start.
      gates.get(path)?.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }

    await Promise.all(pending);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
