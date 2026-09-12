import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { callSidecar, joinSidecarUrl } from "./sidecar-client.js";

const SCHEMA = z.object({ ok: z.boolean() });

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("joinSidecarUrl", () => {
  it("joins a base URL without a trailing slash", () => {
    expect(joinSidecarUrl("http://indexer:8010", "/health")).toBe("http://indexer:8010/health");
  });

  it("strips a trailing slash from the base URL", () => {
    expect(joinSidecarUrl("http://indexer:8010/", "/health")).toBe("http://indexer:8010/health");
  });

  it("adds a leading slash to a bare path", () => {
    expect(joinSidecarUrl("http://indexer:8010", "health")).toBe("http://indexer:8010/health");
  });
});

describe("callSidecar", () => {
  it("returns ok:true with the parsed body on a valid 2xx response", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));

    const result = await callSidecar(
      "http://indexer:8010",
      "/health",
      SCHEMA,
      {},
      { fetch: fetchStub },
    );

    expect(result).toEqual({ ok: true, data: { ok: true } });
    expect(fetchStub).toHaveBeenCalledWith(
      "http://indexer:8010/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("sends a JSON body and POST method when jsonBody is given", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));

    await callSidecar(
      "http://indexer:8010",
      "/reindex",
      SCHEMA,
      { method: "POST", jsonBody: { root: "sftpgo" } },
      { fetch: fetchStub },
    );

    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ root: "sftpgo" }));
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("reports unreachable when fetch rejects", async () => {
    const fetchStub = vi.fn().mockRejectedValue(new Error("connection refused"));

    const result = await callSidecar(
      "http://indexer:8010",
      "/health",
      SCHEMA,
      {},
      { fetch: fetchStub },
    );

    expect(result).toEqual({
      ok: false,
      reason: "unreachable",
      detail: "connection refused",
    });
  });

  it("reports unreachable with a generic detail when the rejection is not an Error", async () => {
    const fetchStub = vi.fn().mockRejectedValue("boom");

    const result = await callSidecar(
      "http://indexer:8010",
      "/health",
      SCHEMA,
      {},
      { fetch: fetchStub },
    );

    expect(result).toEqual({ ok: false, reason: "unreachable", detail: "network error" });
  });

  it("reports unreachable for a non-2xx response", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));

    const result = await callSidecar(
      "http://indexer:8010",
      "/health",
      SCHEMA,
      {},
      { fetch: fetchStub },
    );

    expect(result).toEqual({ ok: false, reason: "unreachable", detail: "status 500", status: 500 });
  });

  it("carries the status through for a 409 response", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(409, { error: "already running" }));

    const result = await callSidecar(
      "http://indexer:8010",
      "/thumbnails/rebuild",
      SCHEMA,
      { method: "POST" },
      { fetch: fetchStub },
    );

    expect(result).toEqual({ ok: false, reason: "unreachable", detail: "status 409", status: 409 });
  });

  it("reports invalid when the body is not valid JSON", async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));

    const result = await callSidecar(
      "http://indexer:8010",
      "/health",
      SCHEMA,
      {},
      { fetch: fetchStub },
    );

    expect(result).toEqual({
      ok: false,
      reason: "invalid",
      detail: "response was not valid JSON",
    });
  });

  it("reports invalid when the body fails schema validation", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, { ok: "not a boolean" }));

    const result = await callSidecar(
      "http://indexer:8010",
      "/health",
      SCHEMA,
      {},
      { fetch: fetchStub },
    );

    expect(result).toEqual({
      ok: false,
      reason: "invalid",
      detail: "response failed contract validation",
    });
  });

  it("tolerates extra fields in the response body", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, extra: "field" }));

    const result = await callSidecar(
      "http://indexer:8010",
      "/health",
      SCHEMA,
      {},
      { fetch: fetchStub },
    );

    expect(result).toEqual({ ok: true, data: { ok: true } });
  });

  it("aborts the request after the given timeout", async () => {
    const fetchStub = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    });

    const result = await callSidecar(
      "http://indexer:8010",
      "/health",
      SCHEMA,
      {},
      { fetch: fetchStub, timeoutMs: 5 },
    );

    expect(result).toEqual({ ok: false, reason: "unreachable", detail: "aborted" });
  });
});

it("keeps the HTTP error status when cancelling its body also fails", async () => {
  const cancel = vi.fn(async () => {
    throw new Error("already closed");
  });
  const result = await callSidecar(
    "http://sidecar",
    "/health",
    SCHEMA,
    {},
    {
      fetch: async () => new Response(new ReadableStream({ cancel }), { status: 503 }),
    },
  );
  expect(result).toMatchObject({ ok: false, status: 503 });
  expect(cancel).toHaveBeenCalledOnce();
});
