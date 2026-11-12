import { StorageError } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiHttpError } from "../errors.ts";
import { RangeNotSatisfiableError, type ShareView, shareCall } from "./access.ts";
import { archiveConflict, boundedRange, isUnder, ownedShareAccess } from "./owned-access.ts";
import { DEFAULT_SHARE_ZIP_LIMITS, ShareZipTimeoutError } from "./zip-limits.ts";

const text = (body: ReadableStream<Uint8Array>) => new Response(body).text();

/** A zip stand-in: the paths it was asked for, as text. */
function fakeZip() {
  const cancel = vi.fn();
  const zip = vi.fn(async (paths: readonly string[], _opts?: { signal?: AbortSignal }) => {
    let sent = false;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) controller.close();
        else controller.enqueue(new TextEncoder().encode(paths.join(",")));
        sent = true;
      },
      cancel,
    });
  });
  return { zip, cancel };
}

function build(
  files: Record<string, string>,
  view: Partial<ShareView> = {},
  options: { zip?: ReturnType<typeof fakeZip>["zip"] | null } = {},
) {
  const memory = createMemoryStorage(files);
  const storage =
    options.zip === null ? memory : Object.assign(memory, { zip: options.zip ?? fakeZip().zip });
  const consume = vi.fn(async () => true);
  const release = vi.fn();
  const acquire = vi.fn((): (() => void) | null => release);
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
    zip: { limits: DEFAULT_SHARE_ZIP_LIMITS, acquire },
  });
  return { storage: memory, consume, access, acquire, release };
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

afterEach(() => {
  vi.useRealTimers();
});

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
    const open = await access.download("/", {
      range: { start: 8 },
      ifRange: "Thu, 01 Jan 1970 00:00:00 GMT",
      signal: new AbortController().signal,
    });
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

  it("uploads a name into the shared directory and counts it", async () => {
    const { access, consume, storage } = build(
      { "/inbox/.keep": "" },
      { scope: "write", paths: ["/inbox"] },
    );
    await access.upload("new.txt", new TextEncoder().encode("hello"), { contentLength: 5 });
    expect(storage.dump()["/inbox/new.txt"]).toBe("hello");
    expect(consume).toHaveBeenCalledTimes(1);
    const archive = build({ "/a": "a", "/b": "b" }, { paths: ["/a", "/b"] });
    expect(await kindOf(archive.access.list("/"))).toBe("bad_request");
    expect(await kindOf(archive.access.download("/"))).toBe("bad_request");
  });

  it("maps storage failures for a visitor and keeps its own errors", async () => {
    const failing = (kind: ConstructorParameters<typeof StorageError>[0]) =>
      shareCall(async () => {
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
        shareCall(async () => {
          throw new Error("plain");
        }),
      ),
    ).toBe("upstream_unavailable");
    const own = new ApiHttpError("payload_too_large", "safe");
    await expect(
      shareCall(async () => {
        throw own;
      }),
    ).rejects.toBe(own);
    expect(
      await kindOf(
        shareCall(async () => {
          throw new RangeNotSatisfiableError(7);
        }),
      ),
    ).toBe("416:7");
  });

  it("zips the canonical shared paths as one counted download", async () => {
    const { zip } = fakeZip();
    const { access, consume, acquire, release } = build(
      { "/docs/a.txt": "alpha", "/b.txt": "bravo" },
      { paths: ["/docs", "/b.txt"] },
      { zip },
    );
    const signal = new AbortController().signal;
    expect(await text(await access.zip({ signal }))).toBe("/docs,/b.txt");
    expect(zip).toHaveBeenCalledWith(["/docs", "/b.txt"], { signal: expect.any(AbortSignal) });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("refuses an archive it cannot make or may not make, before taking a slot", async () => {
    const cases: [Parameters<typeof build>, string][] = [
      [[{ "/docs/a": "a" }, {}, { zip: null }], "unsupported"],
      [[{ "/.trash/a": "a" }, { paths: ["/.trash/a"] }], "not_found"],
      [[{ "/.fdrive-backups/a": "a" }, { paths: ["/.fdrive-backups"] }], "not_found"],
      [[{ "/.trash/a": "a" }, { paths: ["/"] }], "forbidden"],
      [[{ "/x/a": "a", "/y/A": "b" }, { paths: ["/x/a", "/y/A"] }], "bad_request"],
      [[{ "/docs/a": "a" }, { paths: ["/docs/\0"] }], "bad_request"],
    ];
    for (const [args, kind] of cases) {
      const { access, acquire, consume } = build(...args);
      expect(await kindOf(access.zip()), JSON.stringify(args[1])).toBe(kind);
      expect(acquire).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
    }
  });

  it("refuses a share whose archive slots are taken, and gives a slot back on failure", async () => {
    const busy = build({ "/docs/a": "a" });
    busy.acquire.mockReturnValueOnce(null);
    expect(await kindOf(busy.access.zip())).toBe("rate_limited");
    expect(busy.consume).not.toHaveBeenCalled();

    const failing = build(
      { "/docs/a": "a" },
      {},
      {
        zip: vi.fn(async () => {
          throw new StorageError("not_found", "private detail");
        }),
      },
    );
    expect(await kindOf(failing.access.zip())).toBe("not_found");
    expect(failing.release).toHaveBeenCalledTimes(1);
    expect(failing.consume).not.toHaveBeenCalled();

    const { zip, cancel } = fakeZip();
    const spent = build({ "/docs/a": "a" }, {}, { zip });
    spent.consume.mockResolvedValueOnce(false);
    await expect(spent.access.zip()).rejects.toMatchObject({
      kind: "forbidden",
      details: { reason: "limit" },
    });
    expect(cancel).toHaveBeenCalled();
    expect(spent.release).toHaveBeenCalledTimes(1);
  });

  it("ends an archive when the visitor leaves or its time runs out", async () => {
    const left = build({ "/docs/a": "a" });
    const visitor = new AbortController();
    const reader = (await left.access.zip({ signal: visitor.signal })).getReader();
    visitor.abort(new Error("visitor left"));
    await expect(reader.read()).rejects.toThrow("visitor left");
    expect(left.release).toHaveBeenCalledTimes(1);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const slow = build({ "/docs/a": "a" });
    const stream = await slow.access.zip();
    vi.advanceTimersByTime(DEFAULT_SHARE_ZIP_LIMITS.timeoutMs);
    await expect(stream.getReader().read()).rejects.toBeInstanceOf(ShareZipTimeoutError);
    expect(slow.release).toHaveBeenCalledTimes(1);
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

  it("archiveConflict finds paths that would collide in one archive", () => {
    expect(archiveConflict(["/a"])).toBe(false);
    expect(archiveConflict(["/"])).toBe(false);
    expect(archiveConflict(["/x/a", "/y/b", "/c"])).toBe(false);
    expect(archiveConflict(["/x/a", "/y/a"])).toBe(true);
    expect(archiveConflict(["/x/Report.txt", "/y/report.txt"])).toBe(true);
    // The same name, composed and decomposed.
    expect(archiveConflict(["/x/\u00e9", "/y/e\u0301"])).toBe(true);
    expect(archiveConflict(["/a", "/a"])).toBe(true);
    expect(archiveConflict(["/a", "/a/b"])).toBe(true);
    expect(archiveConflict(["/", "/b"])).toBe(true);
  });
});
