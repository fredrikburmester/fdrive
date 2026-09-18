import { StorageError } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/testkit";
import { describe, expect, it, vi } from "vitest";
import { ApiHttpError } from "../errors.ts";
import { RangeNotSatisfiableError, type ShareView } from "./access.ts";
import { boundedRange, isUnder, ownedShareAccess, storageCall } from "./owned-access.ts";

const text = (body: ReadableStream<Uint8Array>) => new Response(body).text();

function build(files: Record<string, string>, view: Partial<ShareView> = {}) {
  const storage = createMemoryStorage(files);
  const consume = vi.fn(async () => true);
  const access = ownedShareAccess({
    storage,
    view: {
      name: "Docs",
      scope: "read",
      paths: ["/docs"],
      hasPassword: false,
      maxDownloads: 0,
      ...view,
    },
    restricted: ["/.trash"],
    consume,
  });
  return { storage, consume, access };
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof ApiHttpError) return error.kind;
    if (error instanceof RangeNotSatisfiableError) return `416:${error.size}`;
    throw error;
  }
}

describe("ownedShareAccess", () => {
  it("resolves every path inside the shared directory and refuses the rest", async () => {
    const { access, consume } = build({
      "/docs/a.txt": "alpha",
      "/docs/sub/b.txt": "bravo",
      "/top.txt": "x",
    });
    expect((await access.list("/")).map((entry) => entry.name).sort()).toEqual(["a.txt", "sub"]);
    expect((await access.list("/sub")).map((entry) => entry.name)).toEqual(["b.txt"]);
    expect(await text((await access.download("/sub/b.txt")).body)).toBe("bravo");
    expect((await access.statFile?.("/a.txt"))?.size).toBe(5);
    expect(await kindOf(access.download("/missing.txt"))).toBe("not_found");
    // Canonical request paths never carry `..`, but the guard holds anyway.
    expect(await kindOf(access.download("/../top.txt"))).toBe("bad_request");
    expect(await kindOf(access.download("/\0"))).toBe("bad_request");
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("hides the Trash and backup folders from a root share", async () => {
    const { access } = build(
      { "/.trash/old.txt": "gone", "/.fdrive-backups/b": "backup", "/keep.txt": "kept" },
      { paths: ["/"] },
    );
    expect((await access.list("/")).map((entry) => entry.name)).toEqual(["keep.txt"]);
    for (const hidden of ["/.trash/old.txt", "/.trash", "/.fdrive-backups/b"]) {
      expect(await kindOf(access.download(hidden))).toBe("not_found");
      expect(await kindOf(access.list(hidden))).toBe("not_found");
      expect(await kindOf(access.statFile?.(hidden) ?? Promise.resolve())).toBe("not_found");
    }
  });

  it("serves a single file at / with ranges resolved against its size", async () => {
    const { access, consume } = build({ "/report.txt": "0123456789" }, { paths: ["/report.txt"] });
    const full = await access.download("/");
    expect(full.status).toBe(200);
    expect(await text(full.body)).toBe("0123456789");
    const tail = await access.download("/", { range: { suffix: 4 } });
    expect(tail.status).toBe(206);
    expect(tail.contentRange).toBe("bytes 6-9/10");
    expect(await text(tail.body)).toBe("6789");
    const clamped = await access.download("/", { range: { start: 2, end: 99 } });
    expect(clamped.contentRange).toBe("bytes 2-9/10");
    expect(await text(clamped.body)).toBe("23456789");
    const open = await access.download("/", { range: { start: 8 } });
    expect(await text(open.body)).toBe("89");
    expect(consume).toHaveBeenCalledTimes(4);
    expect(await kindOf(access.download("/", { range: { start: 10 } }))).toBe("416:10");
    expect(await kindOf(access.download("/", { range: { start: 3, end: 2 } }))).toBe("416:10");
    expect(consume).toHaveBeenCalledTimes(4);
    const empty = build({ "/empty.txt": "" }, { paths: ["/empty.txt"] });
    expect(await kindOf(empty.access.download("/", { range: { suffix: 3 } }))).toBe("416:0");
  });

  it("spends the budget only after storage answered, and refuses once it is spent", async () => {
    const { access, consume, storage } = build({ "/docs/a.txt": "alpha" });
    consume.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await access.download("/a.txt")).status).toBe(200);
    const cancel = vi.fn(async () => undefined);
    vi.spyOn(storage, "download").mockResolvedValueOnce({
      status: 200,
      body: { cancel } as unknown as ReadableStream<Uint8Array>,
      contentLength: 5,
      contentRange: null,
      contentType: null,
      lastModified: null,
    });
    await expect(access.download("/a.txt")).rejects.toMatchObject({
      kind: "forbidden",
      details: { reason: "limit" },
    });
    expect(cancel).toHaveBeenCalled();
    expect(consume).toHaveBeenCalledTimes(2);
    vi.spyOn(storage, "download").mockRejectedValueOnce(
      new StorageError("forbidden", "AccessDenied"),
    );
    expect(await kindOf(access.download("/a.txt"))).toBe("upstream_unavailable");
    expect(await kindOf(access.download("/missing.txt"))).toBe("not_found");
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it("uploads a name into the shared directory, counts it, and has no archive yet", async () => {
    const { access, consume, storage } = build(
      { "/inbox/.keep": "" },
      { scope: "write", paths: ["/inbox"] },
    );
    await access.upload("new.txt", new TextEncoder().encode("hello"), { contentLength: 5 });
    expect(storage.dump()["/inbox/new.txt"]).toBe("hello");
    expect(consume).toHaveBeenCalledTimes(1);
    expect(await kindOf(access.zip())).toBe("unsupported");
    const archive = build({ "/a": "a", "/b": "b" }, { paths: ["/a", "/b"] });
    expect(await kindOf(archive.access.list("/"))).toBe("bad_request");
    expect(await kindOf(archive.access.download("/"))).toBe("bad_request");
  });

  it("maps storage failures for a visitor and keeps its own errors", async () => {
    const failing = (kind: ConstructorParameters<typeof StorageError>[0]) =>
      storageCall(async () => {
        throw new StorageError(kind, "private detail");
      });
    expect(await kindOf(failing("not_found"))).toBe("not_found");
    expect(await kindOf(failing("bad_request"))).toBe("bad_request");
    for (const kind of [
      "forbidden",
      "unauthorized",
      "upstream_unavailable",
      "internal",
      "conflict",
    ] as const)
      expect(await kindOf(failing(kind))).toBe("upstream_unavailable");
    await expect(failing("forbidden")).rejects.not.toHaveProperty("message", "private detail");
    expect(
      await kindOf(
        storageCall(async () => {
          throw new Error("plain");
        }),
      ),
    ).toBe("upstream_unavailable");
    const own = new ApiHttpError("payload_too_large", "safe");
    await expect(
      storageCall(async () => {
        throw own;
      }),
    ).rejects.toBe(own);
    expect(
      await kindOf(
        storageCall(async () => {
          throw new RangeNotSatisfiableError(7);
        }),
      ),
    ).toBe("416:7");
  });

  it("isUnder and boundedRange", () => {
    expect(isUnder("/a/b", "/a")).toBe(true);
    expect(isUnder("/a", "/a")).toBe(true);
    expect(isUnder("/ab", "/a")).toBe(false);
    expect(isUnder("/x", "/")).toBe(true);
    expect(boundedRange({ suffix: 4 }, 10)).toEqual({ start: 6, end: 9 });
    expect(boundedRange({ suffix: 40 }, 10)).toEqual({ start: 0, end: 9 });
    expect(boundedRange({ start: 2 }, 10)).toEqual({ start: 2 });
    expect(boundedRange({ start: 2, end: 30 }, 10)).toEqual({ start: 2, end: 9 });
    expect(() => boundedRange({ start: 10 }, 10)).toThrow(RangeNotSatisfiableError);
  });
});
