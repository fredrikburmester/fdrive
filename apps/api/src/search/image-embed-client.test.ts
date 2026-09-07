import { describe, expect, it, vi } from "vitest";
import { createImageEmbedClient } from "./image-embed-client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createImageEmbedClient: health", () => {
  it("returns the sidecar's health payload", async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        status: "ok",
        model: "google/siglip2-large-patch16-256",
        dim: 1024,
        device: "cpu",
      }),
    );
    const client = createImageEmbedClient({ baseUrl: "http://image-embed:8012", fetch: fetchStub });

    const result = await client.health();

    expect(result).toEqual({
      ok: true,
      data: { status: "ok", model: "google/siglip2-large-patch16-256", dim: 1024, device: "cpu" },
    });
    expect(fetchStub).toHaveBeenCalledWith(
      "http://image-embed:8012/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("reports loading with a null dim", async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { status: "loading", model: "m", dim: null, device: "cpu" }),
      );
    const client = createImageEmbedClient({ baseUrl: "http://image-embed:8012", fetch: fetchStub });

    const result = await client.health();

    expect(result).toEqual({
      ok: true,
      data: { status: "loading", model: "m", dim: null, device: "cpu" },
    });
  });

  it("reports unreachable on a network error", async () => {
    const fetchStub = vi.fn().mockRejectedValue(new Error("boom"));
    const client = createImageEmbedClient({ baseUrl: "http://image-embed:8012", fetch: fetchStub });

    const result = await client.health();

    expect(result).toEqual({ ok: false, reason: "unreachable", detail: "boom" });
  });
});

describe("createImageEmbedClient: embedText", () => {
  it("posts the query and returns the first embedding with its model", async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: "google/siglip2-large-patch16-256",
        dim: 3,
        embeddings: [[0.1, 0.2, 0.3]],
      }),
    );
    const client = createImageEmbedClient({ baseUrl: "http://image-embed:8012", fetch: fetchStub });

    const result = await client.embedText("blue chair");

    expect(result).toEqual({
      vector: [0.1, 0.2, 0.3],
      model: "google/siglip2-large-patch16-256",
    });
    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ inputs: ["blue chair"] });
  });

  it("returns null when the sidecar is unreachable", async () => {
    const fetchStub = vi.fn().mockRejectedValue(new Error("network down"));
    const client = createImageEmbedClient({ baseUrl: "http://image-embed:8012", fetch: fetchStub });

    expect(await client.embedText("blue chair")).toBeNull();
  });

  it("returns null when the sidecar responds 503 (model not loaded)", async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response("loading", { status: 503 }));
    const client = createImageEmbedClient({ baseUrl: "http://image-embed:8012", fetch: fetchStub });

    expect(await client.embedText("blue chair")).toBeNull();
  });

  it("returns null when the response has no embeddings", async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { model: "m", dim: 3, embeddings: [] }));
    const client = createImageEmbedClient({ baseUrl: "http://image-embed:8012", fetch: fetchStub });

    expect(await client.embedText("blue chair")).toBeNull();
  });

  it("truncates a query longer than 512 characters before sending", async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { model: "m", dim: 3, embeddings: [[0.1, 0.2, 0.3]] }));
    const client = createImageEmbedClient({ baseUrl: "http://image-embed:8012", fetch: fetchStub });

    await client.embedText("a".repeat(600));

    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { inputs: string[] };
    expect(body.inputs[0]).toHaveLength(512);
  });
});
