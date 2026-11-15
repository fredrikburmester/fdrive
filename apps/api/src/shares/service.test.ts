import { StorageError } from "@fdrive/core";
import { createMemoryShareRepo, type ShareInsertInput } from "@fdrive/db";
import { createMemoryStorage } from "@fdrive/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingFileOperations, testFileOperations } from "../../test/file-operations.js";
import { recordingGateOnPool } from "../../test/recording-gate.js";
import type { WriteGate } from "../backups/write-gate.ts";
import { ApiHttpError } from "../errors.ts";
import { createScryptSharePasswords } from "./passwords.ts";
import { archiveConflict, createSharesService, hiddenFromLinks, shareCall } from "./service.ts";
import { DEFAULT_SHARE_ZIP_LIMITS, ShareZipTimeoutError } from "./zip-limits.ts";

const identityId = "00000000-0000-4000-8000-000000000001";
const at = new Date("2026-11-15T00:00:00Z");
const passwords = createScryptSharePasswords({ cost: 1024, blockSize: 8, parallelization: 1 });
const text = (body: ReadableStream<Uint8Array>) => new Response(body).text();
/** The bytes a download sent, once it answered 200 or 206. */
async function sent(response: Promise<Response> | Response): Promise<string> {
  const answered = await response;
  expect([200, 206]).toContain(answered.status);
  return answered.text();
}
/** A HEAD of a shared file, which counts nothing. */
const headOnly = [
  new Request("http://share/", { method: "HEAD" }),
  { counted: false, headers: {} },
] as const;
const signal = () => new AbortController().signal;
const bytes = (value: string) => new TextEncoder().encode(value);

/** A zip stand-in: the paths it was asked for, as text. */
function fakeZip() {
  const cancel = vi.fn();
  const zip = vi.fn(async (paths: readonly string[], _opts?: { signal?: AbortSignal }) => {
    let sent = false;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) controller.close();
        else controller.enqueue(bytes(paths.join(",")));
        sent = true;
      },
      cancel,
    });
  });
  return { zip, cancel };
}

/** The service over a memory storage holding `files`, and one share of it. */
async function build(
  files: Record<string, string>,
  share: Partial<ShareInsertInput> = {},
  zip = fakeZip().zip,
  gate?: WriteGate,
) {
  const memory = createMemoryStorage(files);
  const storage = Object.assign(memory, { zip });
  const shares = createMemoryShareRepo();
  const consume = vi.spyOn(shares, "consume");
  const operations = recordingFileOperations(testFileOperations(gate ? { gate } : {}));
  const service = createSharesService({
    shares,
    storageFor: async () => storage,
    files: operations.files,
    passwords,
    zipLimits: { perShare: 1 },
    clock: () => at,
    ...(gate ? { gate } : {}),
  });
  const inserted = await shares.insert({
    identityId,
    name: "Docs",
    description: "",
    scope: "read",
    paths: ["/docs"],
    expiresAt: null,
    maxDownloads: 0,
    presentation: "auto",
    passwordHash: null,
    at,
    ...share,
  });
  const open = async (counted = false) =>
    service.authorize(await service.load(inserted.id), undefined, inserted.scope, counted);
  const used = async () => (await shares.get(inserted.id))?.usedDownloads;
  return {
    storage: memory,
    shares,
    consume,
    service,
    open,
    used,
    id: inserted.id,
    fileCalls: operations.calls,
  };
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof ApiHttpError) return error.kind;
    throw error;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a public share's paths", () => {
  it("resolves every path inside the shared folder and refuses the rest", async () => {
    const { service, open, consume } = await build({
      "/docs/a.txt": "alpha",
      "/docs/sub/b.txt": "bravo",
      "/top.txt": "x",
    });
    const share = await open();
    expect((await service.entries(share, "/")).map((entry) => entry.name).sort()).toEqual([
      "a.txt",
      "sub",
    ]);
    expect((await service.entries(share, "/sub")).map((entry) => entry.name)).toEqual(["b.txt"]);
    expect(await sent(service.download(share, "/a.txt", ...headOnly))).toBe("");
    expect(await kindOf(service.download(share, "/missing.txt", ...headOnly))).toBe("not_found");
    // Canonical request paths never carry `..`, but the guard holds anyway.
    expect(await kindOf(service.download(share, "/../top.txt", ...headOnly))).toBe("bad_request");
    expect(await kindOf(service.download(share, "/\0", ...headOnly))).toBe("bad_request");
    expect(consume).not.toHaveBeenCalled();
  });

  it("hides the Trash from a root share, and serves an old backup folder like any other", async () => {
    const { service, open } = await build(
      { "/.trash/old.txt": "gone", "/.fdrive-backups/b": "backup", "/keep.txt": "kept" },
      { paths: ["/"] },
    );
    const share = await open();
    expect((await service.entries(share, "/")).map((entry) => entry.name).sort()).toEqual([
      ".fdrive-backups",
      "keep.txt",
    ]);
    expect(
      (await service.download(share, "/.fdrive-backups/b", ...headOnly)).headers.get(
        "content-length",
      ),
    ).toBe("6");
    for (const hidden of ["/.trash/old.txt", "/.trash"]) {
      expect(await kindOf(service.download(share, hidden, ...headOnly))).toBe("not_found");
      expect(await kindOf(service.entries(share, hidden))).toBe("not_found");
    }
    expect(hiddenFromLinks("/Shared with me/x")).toBe(true);
    expect(hiddenFromLinks("/a/.fdrive-move-v1/b")).toBe(true);
    expect(hiddenFromLinks("/Shared with meme")).toBe(false);
  });

  it("serves an archive share only whole", async () => {
    const { service, open } = await build({ "/a": "a", "/b": "b" }, { paths: ["/a", "/b"] });
    const share = await open();
    expect(await kindOf(service.entries(share, "/"))).toBe("bad_request");
    expect(await kindOf(service.preview(share, "/"))).toBe("bad_request");
  });

  it("finds paths that would collide in one archive", () => {
    expect(archiveConflict(["/a"])).toBe(false);
    expect(archiveConflict(["/"])).toBe(false);
    expect(archiveConflict(["/x/a", "/y/b", "/c"])).toBe(false);
    expect(archiveConflict(["/x/a", "/y/a"])).toBe(true);
    expect(archiveConflict(["/x/Report.txt", "/y/report.txt"])).toBe(true);
    // The same name, composed and decomposed.
    expect(archiveConflict(["/x/é", "/y/é"])).toBe(true);
    expect(archiveConflict(["/a", "/a"])).toBe(true);
    expect(archiveConflict(["/a", "/a/b"])).toBe(true);
    expect(archiveConflict(["/", "/b"])).toBe(true);
  });
});

describe("counting a public share's downloads", () => {
  it("counts a download once it sends bytes, and refuses once the limit is spent", async () => {
    const { service, open, storage, used } = await build(
      { "/report.txt": "0123456789" },
      { paths: ["/report.txt"], maxDownloads: 2 },
    );
    const share = await open();
    const download = (headers: Record<string, string> = {}) =>
      service.download(share, "/", new Request("http://share/", { headers }), {
        counted: false,
        headers: {},
      });
    expect(await sent(download())).toBe("0123456789");
    const tail = await download({ range: "bytes=-4" });
    expect(tail.headers.get("content-range")).toBe("bytes 6-9/10");
    expect(await sent(tail)).toBe("6789");
    // A range the file cannot satisfy, and a HEAD, are answered before anything is spent.
    expect((await download({ range: "bytes=10-" })).status).toBe(416);
    expect(await used()).toBe(2);
    // The limit raced away while storage answered: the file is closed, not served.
    const close = vi.fn();
    const opened = storage.open.bind(storage);
    vi.spyOn(storage, "open").mockImplementationOnce(async (path) => ({
      ...(await opened(path)),
      close,
    }));
    await expect(download()).rejects.toMatchObject({
      kind: "forbidden",
      details: { reason: "limit" },
    });
    expect(close).toHaveBeenCalled();
    expect(await kindOf(open())).toBe("forbidden");
  });

  it("counts a preview once, and lets its reads past the limit it reached", async () => {
    const { service, open, used } = await build(
      { "/docs/movie.mp4": "0123456789" },
      { maxDownloads: 1 },
    );
    await service.preview(await open(), "/movie.mp4");
    expect(await used()).toBe(1);
    // The link is spent now, but the preview it paid for still plays.
    expect(await kindOf(open())).toBe("forbidden");
    const previewed = await open(true);
    for (const range of ["bytes=0-", "bytes=2-5", "bytes=8-"]) {
      const read = await service.download(
        previewed,
        "/movie.mp4",
        new Request("http://share/", { headers: { range } }),
        { counted: true, headers: {} },
      );
      expect(read.status).toBe(206);
      await read.arrayBuffer();
    }
    expect(await used()).toBe(1);
    expect(await kindOf(service.preview(previewed, "/missing.mp4"))).toBe("not_found");
    // Only what a viewer streams opens as a preview; the rest is one plain download.
    expect(await kindOf(service.preview(previewed, "/notes.txt"))).toBe("bad_request");
    expect(await used()).toBe(1);
  });

  it("maps storage failures for a visitor and keeps its own errors", async () => {
    const failing = (kind: ConstructorParameters<typeof StorageError>[0]) =>
      shareCall(async () => {
        throw new StorageError(kind, "private detail");
      });
    expect(await kindOf(failing("not_found"))).toBe("not_found");
    expect(await kindOf(failing("bad_request"))).toBe("bad_request");
    expect(await kindOf(failing("storage_limit_reached"))).toBe("storage_limit_reached");
    for (const kind of ["forbidden", "upstream_unavailable", "internal", "conflict"] as const)
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
  });
});

describe("uploads through a public share", () => {
  it("never replaces a file: a taken name gets the next free number", async () => {
    const { service, open, storage, used, fileCalls } = await build(
      { "/inbox/photo.jpg": "first", "/inbox/photo (2).jpg": "second" },
      { scope: "write", paths: ["/inbox"] },
    );
    const share = await open();
    expect(await service.upload(share, "photo.jpg", bytes("third"), signal())).toBe(
      "photo (3).jpg",
    );
    expect(await service.upload(share, "new.txt", bytes("new"), signal())).toBe("new.txt");
    expect(storage.dump()).toMatchObject({
      "/inbox/photo.jpg": "first",
      "/inbox/photo (2).jpg": "second",
      "/inbox/photo (3).jpg": "third",
      "/inbox/new.txt": "new",
    });
    // Every attempt is the file operations' upload, as every change to files is.
    expect(fileCalls).toEqual([
      "upload /inbox/photo.jpg",
      "upload /inbox/photo (2).jpg",
      "upload /inbox/photo (3).jpg",
      "upload /inbox/new.txt",
    ]);
    expect(await used()).toBe(2);
  });

  it("counts an upload in the write that published it, never holding the gate for its body", async () => {
    const steps: string[] = [];
    const { gate, connections } = recordingGateOnPool(steps);
    const { service, open, consume } = await build(
      { "/inbox/.keep": "" },
      { scope: "write", paths: ["/inbox"] },
      fakeZip().zip,
      gate,
    );
    consume.mockImplementationOnce(async () => {
      steps.push("counted");
      return null;
    });
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          steps.push("body arrived");
          controller.enqueue(bytes("mine"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    expect(await service.upload(await open(), "a.txt", body, signal())).toBe("a.txt");
    expect(steps).toEqual(["body arrived", "gate held", "counted", "gate let go"]);
    // The upload's gate is the one write's, joined rather than taken twice.
    expect(connections()).toBe(1);
  });

  it("gives up on a name taken after storage read the body, rather than store nothing", async () => {
    const { service, open, storage, used } = await build(
      { "/inbox/.keep": "" },
      { scope: "write", paths: ["/inbox"] },
    );
    const upload = storage.upload.bind(storage);
    vi.spyOn(storage, "upload").mockImplementationOnce(async (path, body) => {
      // Reads the body, then finds the name taken, as a racing writer would leave it.
      if (body instanceof ReadableStream) await body.getReader().read();
      await upload(path, bytes("racer"));
      throw new StorageError("conflict", "taken");
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes("mine"));
        controller.close();
      },
    });
    await expect(service.upload(await open(), "a.txt", body, signal())).rejects.toMatchObject({
      kind: "conflict",
    });
    expect(storage.dump()["/inbox/a.txt"]).toBe("racer");
    expect(storage.dump()["/inbox/a (2).txt"]).toBeUndefined();
    expect(await used()).toBe(0);
  });
});

describe("archives of a public share", () => {
  it("zips the canonical shared paths as one counted download", async () => {
    const { zip } = fakeZip();
    const { service, open, used } = await build(
      { "/docs/a.txt": "alpha", "/b.txt": "bravo" },
      { paths: ["/docs", "/b.txt"] },
      zip,
    );
    expect(await text(await service.zip(await open(), signal()))).toBe("/docs,/b.txt");
    expect(zip).toHaveBeenCalledWith(["/docs", "/b.txt"], { signal: expect.any(AbortSignal) });
    expect(await used()).toBe(1);
  });

  it("refuses an archive it may not make, before taking a slot", async () => {
    const cases: [Record<string, string>, string[], string][] = [
      [{ "/.trash/a": "a" }, ["/.trash/a"], "not_found"],
      [{ "/.trash/a": "a" }, ["/"], "forbidden"],
      [{ "/x/a": "a", "/y/A": "b" }, ["/x/a", "/y/A"], "bad_request"],
    ];
    for (const [files, paths, kind] of cases) {
      const { zip } = fakeZip();
      const { service, open, consume } = await build(files, { paths }, zip);
      expect(await kindOf(service.zip(await open(), signal())), paths.join()).toBe(kind);
      expect(zip).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
    }
  });

  it("holds a share to its archive slots, and gives a slot back on failure", async () => {
    const busy = await build({ "/docs/a": "a" });
    const share = await busy.open();
    const first = await busy.service.zip(share, signal());
    expect(await kindOf(busy.service.zip(share, signal()))).toBe("rate_limited");
    await first.cancel();
    expect(await text(await busy.service.zip(share, signal()))).toBe("/docs");

    const failing = await build(
      { "/docs/a": "a" },
      {},
      vi.fn(async () => {
        throw new StorageError("not_found", "private detail");
      }),
    );
    const failed = await failing.open();
    expect(await kindOf(failing.service.zip(failed, signal()))).toBe("not_found");
    // Its one slot came back, so the second attempt fails the same way, not busy.
    expect(await kindOf(failing.service.zip(failed, signal()))).toBe("not_found");
    expect(failing.consume).not.toHaveBeenCalled();

    const { zip, cancel } = fakeZip();
    const spent = await build({ "/docs/a": "a" }, { maxDownloads: 1 }, zip);
    const last = await spent.open();
    await spent.shares.consume(spent.id, at);
    await expect(spent.service.zip(last, signal())).rejects.toMatchObject({
      kind: "forbidden",
      details: { reason: "limit" },
    });
    expect(cancel).toHaveBeenCalled();
  });

  it("ends an archive when the visitor leaves or its time runs out", async () => {
    const left = await build({ "/docs/a": "a" });
    const visitor = new AbortController();
    const reader = (await left.service.zip(await left.open(), visitor.signal)).getReader();
    visitor.abort(new Error("visitor left"));
    await expect(reader.read()).rejects.toThrow("visitor left");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const slow = await build({ "/docs/a": "a" });
    const stream = await slow.service.zip(await slow.open(), signal());
    vi.advanceTimersByTime(DEFAULT_SHARE_ZIP_LIMITS.timeoutMs);
    await expect(stream.getReader().read()).rejects.toBeInstanceOf(ShareZipTimeoutError);
  });
});

describe("a public share's password", () => {
  it("opens to the credential its password issued, and to no other", async () => {
    const { service, id } = await build(
      { "/docs/a": "a" },
      { passwordHash: await passwords.hash("secret") },
    );
    const row = await service.load(id);
    await expect(service.credential(row, "wrong")).rejects.toMatchObject({
      kind: "unauthorized",
      details: { reason: "password" },
    });
    const issued = await service.credential(row, "secret");
    expect(service.showsThumbnails(row, issued)).toBe(true);
    expect(service.showsThumbnails(row, undefined)).toBe(false);
    expect(service.showsThumbnails(row, { verified: "forged" })).toBe(false);
    expect(await kindOf(service.authorize(row, { verified: "forged" }, "read"))).toBe(
      "unauthorized",
    );
    expect(await kindOf(service.authorize(row, issued, "read"))).toBe("ok");
    expect(await kindOf(service.authorize(row, issued, "write"))).toBe("forbidden");
    expect(await kindOf(service.load("00000000-0000-4000-8000-000000000099"))).toBe("not_found");
  });
});
