import { describe, expect, it, vi } from "vitest";
import { createOcrClient } from "./ocr-client.js";

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
