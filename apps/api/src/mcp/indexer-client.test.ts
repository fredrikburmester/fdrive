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

it("cancels HTTP error bodies even when cancellation itself fails", async () => {
  const cancel = vi.fn(async () => {
    throw new Error("already closed");
  });
  const client = createIndexerExtractClient({
    baseUrl: "http://indexer",
    fetch: async () => new Response(new ReadableStream({ cancel }), { status: 503 }),
  });
  expect(await client.extract({ root: "sftpgo", path: "a.txt" })).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
});
