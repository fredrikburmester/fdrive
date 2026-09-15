import { describe, expect, it, vi } from "vitest";
import { createOcrClient, OCR_DOWNLOAD_TIMEOUT_MS, ocrRefusal } from "./ocr-client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createOcrClient: health", () => {
  it("maps the raw health payload", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, running: false }));
    const client = createOcrClient({ baseUrl: "http://ocr:8020", fetch: fetchStub });

    expect(await client.health()).toEqual({ ok: true, data: { ok: true, running: false } });
    expect(fetchStub).toHaveBeenCalledWith(
      "http://ocr:8020/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("passes through an unreachable result unmapped", async () => {
    const fetchStub = vi.fn().mockRejectedValue(new Error("refused"));
    const client = createOcrClient({ baseUrl: "http://ocr:8020", fetch: fetchStub });

    expect(await client.health()).toEqual({ ok: false, reason: "unreachable", detail: "refused" });
  });
});

describe("createOcrClient: stats", () => {
  it("maps a full stats payload with a lastRun", async () => {
    const raw = {
      last_run: {
        started_at: "2026-01-01T03:00:00.000Z",
        finished_at: "2026-01-01T03:10:00.000Z",
        seen: 100,
        ocred: 5,
        skipped: 94,
        failed: 1,
      },
      next_run_at: "2026-01-02T03:00:00.000Z",
      schedule_hour: 3,
      langs: "swe+eng",
      exclude_globs: ["**/private/**"],
      max_mb: 200,
      keep_originals: false,
      originals_retention_days: 30,
      originals_count: 0,
      originals_bytes: 0,
      running: false,
    };
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, raw));
    const client = createOcrClient({ baseUrl: "http://ocr:8020", fetch: fetchStub });

    const result = await client.stats();

    expect(result).toEqual({
      ok: true,
      data: {
        lastRun: {
          startedAt: "2026-01-01T03:00:00.000Z",
          finishedAt: "2026-01-01T03:10:00.000Z",
          seen: 100,
          ocred: 5,
          skipped: 94,
          failed: 1,
        },
        nextRunAt: "2026-01-02T03:00:00.000Z",
        scheduleHour: 3,
        langs: "swe+eng",
        excludeGlobs: ["**/private/**"],
        maxMb: 200,
        keepOriginals: false,
        originalsRetentionDays: 30,
        originalsCount: 0,
        originalsBytes: 0,
        running: false,
      },
    });
  });

  it("maps a null last_run through to a null lastRun", async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        last_run: null,
        next_run_at: null,
        schedule_hour: 3,
        langs: "swe+eng",
        exclude_globs: [],
        max_mb: 200,
        keep_originals: false,
        originals_retention_days: 0,
        originals_count: 0,
        originals_bytes: 0,
        running: false,
      }),
    );
    const client = createOcrClient({ baseUrl: "http://ocr:8020", fetch: fetchStub });

    const result = await client.stats();

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.lastRun).toBeNull();
  });
});

describe("createOcrClient: run", () => {
  it("posts /run and maps started through", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(202, { started: true }));
    const client = createOcrClient({ baseUrl: "http://ocr:8020", fetch: fetchStub });

    const result = await client.run();

    expect(result).toEqual({ ok: true, data: { started: true } });
    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
  });
});

describe("createOcrClient: originals", () => {
  const rawOriginal = {
    id: "0123456789abcdef_scan.pdf",
    root: "sftpgo",
    path: "docs/scan.pdf",
    size: 1024,
    kept_at: 1_757_000_000,
    sha256: "a".repeat(64),
    legacy: false,
    state: "ocred",
  };

  it("maps kept originals and turns the epoch keep time into an instant", async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { items: [rawOriginal], total: 1, offset: 0, limit: 50 }),
      );
    const client = createOcrClient({ baseUrl: "http://ocr:8020", fetch: fetchStub });

    const result = await client.originals({});

    expect(result).toEqual({
      ok: true,
      data: {
        items: [
          {
            id: "0123456789abcdef_scan.pdf",
            root: "sftpgo",
            path: "docs/scan.pdf",
            size: 1024,
            keptAt: new Date(1_757_000_000_000).toISOString(),
            sha256: "a".repeat(64),
            legacy: false,
            state: "ocred",
          },
        ],
        total: 1,
        offset: 0,
        limit: 50,
      },
    });
    expect(fetchStub.mock.calls[0]?.[0]).toBe("http://ocr:8020/originals");
  });

  it("sends only the paging and search parameters that were given", async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { items: [], total: 0, offset: 25, limit: 25 }));
    const client = createOcrClient({ baseUrl: "http://ocr:8020", fetch: fetchStub });

    await client.originals({ query: "scan", offset: 25, limit: 25 });
    expect(fetchStub.mock.calls[0]?.[0]).toBe(
      "http://ocr:8020/originals?query=scan&offset=25&limit=25",
    );

    await client.originals({ query: "" });
    expect(fetchStub.mock.calls[1]?.[0]).toBe("http://ocr:8020/originals");
  });

  it("carries an unresolved legacy original through with nulls", async () => {
    const unresolved = {
      ...rawOriginal,
      root: null,
      path: null,
      sha256: null,
      legacy: true,
      state: null,
    };
    const fetchStub = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { items: [unresolved], total: 1, offset: 0, limit: 50 }),
      );
    const client = createOcrClient({ baseUrl: "http://ocr:8020", fetch: fetchStub });

    const result = await client.originals({});
    expect(result.ok && result.data.items[0]).toMatchObject({
      root: null,
      path: null,
      state: null,
    });
  });
});

describe("createOcrClient: restoreOriginal", () => {
  it("sends both opt-ins explicitly and maps the outcome", async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        restored: true,
        root: "sftpgo",
        path: "docs/scan.pdf",
        previous_state: "ocred",
      }),
    );
    const client = createOcrClient({ baseUrl: "http://ocr:8020", fetch: fetchStub });

    const result = await client.restoreOriginal({ id: "abc_scan.pdf", allowRecreate: true });

    expect(result).toEqual({
      ok: true,
      data: { restored: true, root: "sftpgo", path: "docs/scan.pdf", previousState: "ocred" },
    });
    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      id: "abc_scan.pdf",
      allow_recreate: true,
      allow_overwrite_changed: false,
    });
  });

  it("keeps the refusal body so the reason survives the failure", async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse(409, {
        error: "target_changed",
        state: "changed",
        root: "sftpgo",
        path: "docs/scan.pdf",
      }),
    );
    const client = createOcrClient({ baseUrl: "http://ocr:8020", fetch: fetchStub });

    const result = await client.restoreOriginal({ id: "abc_scan.pdf" });

    expect(result.ok).toBe(false);
    expect(ocrRefusal(result)).toEqual({
      reason: "target_changed",
      state: "changed",
      root: "sftpgo",
      path: "docs/scan.pdf",
      status: 409,
    });
  });

  it("reads no refusal from an unreachable service or a body that is not one", async () => {
    const unreachable = createOcrClient({
      baseUrl: "http://ocr:8020",
      fetch: vi.fn().mockRejectedValue(new Error("refused")),
    });
    expect(ocrRefusal(await unreachable.restoreOriginal({ id: "a" }))).toBeNull();

    const gibberish = createOcrClient({
      baseUrl: "http://ocr:8020",
      fetch: vi.fn().mockResolvedValue(jsonResponse(500, { oops: true })),
    });
    expect(ocrRefusal(await gibberish.restoreOriginal({ id: "a" }))).toBeNull();
  });
});

describe("createOcrClient: deleteOriginal and downloadOriginal", () => {
  it("posts a delete by id", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, { deleted: true }));
    const client = createOcrClient({ baseUrl: "http://ocr:8020", fetch: fetchStub });

    expect(await client.deleteOriginal("abc_scan.pdf")).toEqual({
      ok: true,
      data: { deleted: true },
    });
    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ id: "abc_scan.pdf" });
  });

  it("returns the upstream response so the route can stream it", async () => {
    const upstream = new Response("pdf bytes", { status: 200 });
    const fetchStub = vi.fn().mockResolvedValue(upstream);
    const client = createOcrClient({ baseUrl: "http://ocr:8020", fetch: fetchStub });

    const result = await client.downloadOriginal("a b/c.pdf");

    expect(result).toEqual({ ok: true, response: upstream });
    expect(fetchStub.mock.calls[0]?.[0]).toBe(
      "http://ocr:8020/originals/download?id=a%20b%2Fc.pdf",
    );
  });

  it("reports an upstream status and a network failure apart", async () => {
    const missing = createOcrClient({
      baseUrl: "http://ocr:8020",
      fetch: vi.fn().mockResolvedValue(new Response("nope", { status: 404 })),
    });
    expect(await missing.downloadOriginal("a")).toEqual({
      ok: false,
      detail: "status 404",
      status: 404,
    });

    const down = createOcrClient({
      baseUrl: "http://ocr:8020",
      fetch: vi.fn().mockRejectedValue(new Error("refused")),
    });
    expect(await down.downloadOriginal("a")).toEqual({ ok: false, detail: "refused" });
  });

  it("does not fail a reported status because discarding the error body failed", async () => {
    const body = new ReadableStream({
      cancel() {
        throw new Error("already detached");
      },
    });
    const client = createOcrClient({
      baseUrl: "http://ocr:8020",
      fetch: vi.fn().mockResolvedValue(new Response(body, { status: 503 })),
    });

    expect(await client.downloadOriginal("a")).toEqual({
      ok: false,
      detail: "status 503",
      status: 503,
    });
  });

  it("aborts a download the OCR service never starts answering", async () => {
    vi.useFakeTimers();
    try {
      const fetchStub = vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const client = createOcrClient({
        baseUrl: "http://ocr:8020",
        fetch: fetchStub as unknown as typeof globalThis.fetch,
      });

      const pending = client.downloadOriginal("a");
      await vi.advanceTimersByTimeAsync(OCR_DOWNLOAD_TIMEOUT_MS + 1);

      expect(await pending).toEqual({ ok: false, detail: "aborted" });
    } finally {
      vi.useRealTimers();
    }
  });
});
