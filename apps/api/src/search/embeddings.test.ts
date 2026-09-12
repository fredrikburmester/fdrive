import { describe, expect, it, vi } from "vitest";
import { createEmbedClient, parseEmbedResponse } from "./embeddings";

describe("parseEmbedResponse", () => {
  it("extracts the first vector from a valid response", () => {
    expect(parseEmbedResponse([[0.1, 0.2, 0.3]])).toEqual([0.1, 0.2, 0.3]);
  });

  it("returns null for a non-array response", () => {
    expect(parseEmbedResponse({ not: "an array" })).toBeNull();
  });

  it("returns null for an empty top-level array", () => {
    expect(parseEmbedResponse([])).toBeNull();
  });

  it("returns null when the first element is not an array", () => {
    expect(parseEmbedResponse(["not a vector"])).toBeNull();
  });

  it("returns null for an empty vector", () => {
    expect(parseEmbedResponse([[]])).toBeNull();
  });

  it("returns null when the vector contains a non-number", () => {
    expect(parseEmbedResponse([[0.1, "oops", 0.3]])).toBeNull();
  });

  it("returns null when the vector contains a non-finite number", () => {
    expect(parseEmbedResponse([[0.1, Number.NaN, 0.3]])).toBeNull();
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FetchImpl = typeof globalThis.fetch;

function fetchStub(impl: (url: string, init?: RequestInit) => Promise<Response>): FetchImpl {
  return vi.fn(async (input, init) => impl(String(input), init)) as unknown as FetchImpl;
}

describe("createEmbedClient", () => {
  it("posts the query and returns the embedding", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = fetchStub(async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, [[0.1, 0.2]]);
    });
    const client = createEmbedClient({ baseUrl: "http://embed:80", fetchImpl });

    const result = await client.embed("readme");

    expect(result).toEqual([0.1, 0.2]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://embed:80/embed");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      inputs: ["query: readme"],
      normalize: true,
      truncate: true,
    });
  });

  it("strips a trailing slash from the base URL", async () => {
    const calls: string[] = [];
    const fetchImpl = fetchStub(async (url) => {
      calls.push(url);
      return jsonResponse(200, [[0.1]]);
    });
    const client = createEmbedClient({ baseUrl: "http://embed:80/", fetchImpl });

    await client.embed("readme");

    expect(calls[0]).toBe("http://embed:80/embed");
  });

  it("returns null on a non-2xx response", async () => {
    const fetchImpl = fetchStub(async () => jsonResponse(500, { error: "down" }));
    const client = createEmbedClient({ baseUrl: "http://embed:80", fetchImpl });

    expect(await client.embed("readme")).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const fetchImpl = fetchStub(async () => {
      throw new Error("network down");
    });
    const client = createEmbedClient({ baseUrl: "http://embed:80", fetchImpl });

    expect(await client.embed("readme")).toBeNull();
  });

  it("returns null when the response body is not valid JSON", async () => {
    const fetchImpl = fetchStub(
      async () =>
        new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const client = createEmbedClient({ baseUrl: "http://embed:80", fetchImpl });

    expect(await client.embed("readme")).toBeNull();
  });

  it("aborts and returns null after the timeout elapses", async () => {
    const fetchImpl = fetchStub(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const client = createEmbedClient({ baseUrl: "http://embed:80", fetchImpl, timeoutMs: 5 });

    const result = await client.embed("readme");

    expect(result).toBeNull();
  });

  it("falls back to globalThis.fetch when no fetchImpl is given", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = fetchStub(async () => jsonResponse(200, [[0.5]]));
    try {
      const client = createEmbedClient({ baseUrl: "http://embed:80" });
      expect(await client.embed("readme")).toEqual([0.5]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("uses the default 5 second timeout when none is given", async () => {
    let called = false;
    const fetchImpl = fetchStub(async () => {
      called = true;
      return jsonResponse(200, [[0.1]]);
    });
    const client = createEmbedClient({ baseUrl: "http://embed:80", fetchImpl });

    await client.embed("readme");

    expect(called).toBe(true);
  });
});

it("releases HTTP error bodies without masking the upstream failure", async () => {
  const cancel = vi.fn(async () => {
    throw new Error("already closed");
  });
  const client = createEmbedClient({
    baseUrl: "http://embed",
    fetchImpl: async () => new Response(new ReadableStream({ cancel }), { status: 503 }),
  });
  expect(await client.embed("query")).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
});
