import { describe, expect, it, vi } from "vitest";
import { createNameIndexClient, type NameIndexSearch } from "./name-index.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SEARCH: NameIndexSearch = {
  query: "Microlär",
  scopes: [{ rootId: 1, fsPrefix: "/alice" }],
  exclude: [{ rootId: 1, fsPrefix: "/alice/.fdrive-trash" }],
  files: 25,
  folders: 50,
};

const HIT = { id: 7, root_id: 1, path: "alice/Mikrolärande", mtime_ns: "1794614400000000000" };

describe("createNameIndexClient", () => {
  it("posts the query and root-relative places, and reads the hits", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, { files: [], folders: [HIT] }));
    const client = createNameIndexClient({ baseUrl: "http://indexer:8010", fetch: fetchStub });

    expect(await client.search(SEARCH)).toEqual({
      files: [],
      folders: [{ id: 7, rootId: 1, path: "alice/Mikrolärande", mtimeNs: 1794614400000000000n }],
    });
    expect(fetchStub).toHaveBeenCalledWith(
      "http://indexer:8010/names/search",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
        body: JSON.stringify({
          query: "Microlär",
          scopes: [{ root_id: 1, prefix: "alice" }],
          exclude: [{ root_id: 1, prefix: "alice/.fdrive-trash" }],
          files: 25,
          folders: 50,
        }),
      }),
    );
  });

  it("sends a whole root as an empty prefix", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, { files: [], folders: [] }));
    const client = createNameIndexClient({ baseUrl: "http://indexer:8010", fetch: fetchStub });

    await client.search({ ...SEARCH, scopes: [{ rootId: 2, fsPrefix: "/" }], exclude: [] });

    const init = fetchStub.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({ scopes: [{ root_id: 2, prefix: "" }] });
  });

  it("is null while the index is building or the indexer refuses", async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValue(jsonResponse(503, { error: "name index is building" }));
    const client = createNameIndexClient({ baseUrl: "http://indexer:8010", fetch: fetchStub });

    expect(await client.search(SEARCH)).toBeNull();
  });

  it("is null when the indexer cannot be reached or does not answer in time", async () => {
    const client = createNameIndexClient({
      baseUrl: "http://indexer:8010",
      fetch: vi.fn().mockRejectedValue(new Error("network down")),
      timeoutMs: 5,
    });

    expect(await client.search(SEARCH)).toBeNull();
  });

  it.each([
    ["not JSON", new Response("nope", { status: 200 })],
    ["not an object", jsonResponse(200, [])],
    ["missing a list", jsonResponse(200, { files: [] })],
    ["a list entry that is not an object", jsonResponse(200, { files: [1], folders: [] })],
    [
      "a modification time that is not a whole number",
      jsonResponse(200, { files: [], folders: [{ ...HIT, mtime_ns: "soon" }] }),
    ],
    [
      "an id that is not a number",
      jsonResponse(200, { files: [{ ...HIT, id: "7" }], folders: [] }),
    ],
  ])("is null for a reply that is %s", async (_, response) => {
    const client = createNameIndexClient({
      baseUrl: "http://indexer:8010",
      fetch: vi.fn().mockResolvedValue(response),
    });

    expect(await client.search(SEARCH)).toBeNull();
  });
});
