import { expect, it, vi } from "vitest";
import { createIndexerExtractClient } from "./indexer-client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

it("sends authorized content bytes with an encoded name and handles optional extraction failures", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse(200, { text: "text", status: "indexed" }))
    .mockResolvedValueOnce(jsonResponse(200, { text: null, status: "disabled" }))
    .mockResolvedValueOnce(jsonResponse(503, {}))
    .mockResolvedValueOnce(jsonResponse(200, {}))
    .mockResolvedValueOnce(jsonResponse(200, null))
    .mockResolvedValueOnce(new Response("not json", { status: 200 }))
    .mockRejectedValueOnce(new Error("offline"));
  const client = createIndexerExtractClient({ baseUrl: "http://indexer", fetch });
  const input = { name: "report #?.pdf", bytes: new Uint8Array([1, 2, 3]) };
  expect(await client.extractContent(input)).toEqual({ text: "text", status: "indexed" });
  expect(fetch).toHaveBeenCalledWith(
    "http://indexer/extract-content?name=report%20%23%3F.pdf",
    expect.objectContaining({ body: input.bytes, signal: expect.any(AbortSignal) }),
  );
  expect(await client.extractContent(input)).toEqual({ text: "", status: "disabled" });
  for (let i = 0; i < 5; i++) expect(await client.extractContent(input)).toBeNull();
  // Only bytes are ever sent: the client has no way to ask for a path on the indexer's disk.
  expect(fetch.mock.calls.every(([url]) => String(url).includes("/extract-content?"))).toBe(true);
  expect(Object.keys(client)).toEqual(["extractContent"]);
});

it("cancels HTTP error bodies even when cancellation itself fails", async () => {
  const cancel = vi.fn(async () => {
    throw new Error("already closed");
  });
  const client = createIndexerExtractClient({
    baseUrl: "http://indexer",
    fetch: async () => new Response(new ReadableStream({ cancel }), { status: 503 }),
  });
  expect(await client.extractContent({ name: "a.txt", bytes: new Uint8Array() })).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
});
