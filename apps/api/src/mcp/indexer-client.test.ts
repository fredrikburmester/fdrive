import { describe, expect, it, vi } from "vitest";
import { createIndexerExtractClient } from "./indexer-client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createIndexerExtractClient", () => {
  it("posts to <baseUrl>/extract with the root and path", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, { text: "hello", status: "ok" }));
    const client = createIndexerExtractClient({ baseUrl: "http://indexer:8090", fetch: fetchStub });

    const result = await client.extract({ root: "sftpgo", path: "alice/a.txt" });

    expect(result).toEqual({ text: "hello", status: "ok" });
    expect(fetchStub).toHaveBeenCalledWith(
      "http://indexer:8090/extract",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ root: "sftpgo", path: "alice/a.txt" }),
      }),
    );
  });

  it("returns null when the indexer responds non-2xx", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(404, { error: "not found" }));
    const client = createIndexerExtractClient({ baseUrl: "http://indexer:8090", fetch: fetchStub });

    expect(await client.extract({ root: "sftpgo", path: "missing.txt" })).toBeNull();
  });

  it("returns null when fetch itself rejects", async () => {
    const fetchStub = vi.fn().mockRejectedValue(new Error("network down"));
    const client = createIndexerExtractClient({ baseUrl: "http://indexer:8090", fetch: fetchStub });

    expect(await client.extract({ root: "sftpgo", path: "a.txt" })).toBeNull();
  });

  it("returns null when the response body is not valid JSON", async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
    const client = createIndexerExtractClient({ baseUrl: "http://indexer:8090", fetch: fetchStub });

    expect(await client.extract({ root: "sftpgo", path: "a.txt" })).toBeNull();
  });

  it("returns null when the response body is not an object", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, "just a string"));
    const client = createIndexerExtractClient({ baseUrl: "http://indexer:8090", fetch: fetchStub });

    expect(await client.extract({ root: "sftpgo", path: "a.txt" })).toBeNull();
  });

  it("defaults missing text and status fields", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const client = createIndexerExtractClient({ baseUrl: "http://indexer:8090", fetch: fetchStub });

    expect(await client.extract({ root: "sftpgo", path: "a.txt" })).toEqual({
      text: "",
      status: "unknown",
    });
  });
});

it("sends authorized content bytes with an encoded name and handles optional extraction failures", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse(200, { text: "text", status: "indexed" }))
    .mockResolvedValueOnce(jsonResponse(200, { text: null, status: "disabled" }))
    .mockResolvedValueOnce(jsonResponse(503, {}))
    .mockResolvedValueOnce(jsonResponse(200, {}))
    .mockResolvedValueOnce(jsonResponse(200, null))
    .mockRejectedValueOnce(new Error("offline"));
  const client = createIndexerExtractClient({ baseUrl: "http://indexer", fetch });
  const input = { name: "report #?.pdf", bytes: new Uint8Array([1, 2, 3]) };
  expect(await client.extractContent?.(input)).toEqual({ text: "text", status: "indexed" });
  expect(fetch).toHaveBeenCalledWith(
    "http://indexer/extract-content?name=report%20%23%3F.pdf",
    expect.objectContaining({ body: input.bytes, signal: expect.any(AbortSignal) }),
  );
  expect(await client.extractContent?.(input)).toEqual({ text: "", status: "disabled" });
  for (let i = 0; i < 4; i++) expect(await client.extractContent?.(input)).toBeNull();
});
