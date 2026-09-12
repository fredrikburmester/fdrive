import { describe, expect, it, vi } from "vitest";
import { WebdavError } from "./errors.js";
import {
  basicAuthHeader,
  buildUrl,
  cancelBody,
  combineSignals,
  drainBounded,
  emptyByteStream,
  fetchChecked,
  parseDateOrNull,
  parseIntOrNull,
  readTextBounded,
  safeFetch,
  toRedirectError,
} from "./http.js";

function chunked(chunks: readonly string[], fail = false): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index] ?? ""));
        index += 1;
        return;
      }
      if (fail) controller.error(new Error("cut"));
      else controller.close();
    },
  });
}

describe("buildUrl", () => {
  it("joins encoded segments under the endpoint prefix", () => {
    expect(buildUrl("http://host/dav", "/a b/%41.txt")).toBe("http://host/dav/a%20b/%2541.txt");
    expect(buildUrl("http://host/dav/", "/a")).toBe("http://host/dav/a");
    expect(buildUrl("http://host", "/a")).toBe("http://host/a");
  });

  it("returns the endpoint itself for the root and marks collections with a slash", () => {
    expect(buildUrl("http://host/dav", "/")).toBe("http://host/dav/");
    expect(buildUrl("http://host/dav", "/", { collection: true })).toBe("http://host/dav/");
    expect(buildUrl("http://host/dav", "/d", { collection: true })).toBe("http://host/dav/d/");
  });

  it("drops query and fragment from the endpoint and never escapes it", () => {
    expect(buildUrl("http://host/dav?x=1#f", "/a")).toBe("http://host/dav/a");
    expect(buildUrl("http://host/dav", "//other.example/x")).toBe(
      "http://host/dav/other.example/x",
    );
    expect(buildUrl("http://host/dav", "/a/b..c/.hidden")).toBe("http://host/dav/a/b..c/.hidden");
    for (const path of ["/../etc", "/a/../../etc", "/./a", "relative", "/a\0b"]) {
      expect(() => buildUrl("http://host/dav", path)).toThrow(WebdavError);
    }
  });
});

describe("basicAuthHeader", () => {
  it("encodes username:password in base64", () => {
    expect(basicAuthHeader("alice", "s:cret")).toBe(
      `Basic ${Buffer.from("alice:s:cret").toString("base64")}`,
    );
  });
});

describe("combineSignals", () => {
  it("returns a never-aborting signal without inputs", () => {
    expect(combineSignals(undefined, null).aborted).toBe(false);
  });

  it("follows the user signal", () => {
    const controller = new AbortController();
    const signal = combineSignals(controller.signal, 60_000);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it("aborts on timeout", async () => {
    const signal = combineSignals(undefined, 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signal.aborted).toBe(true);
  });
});

describe("safeFetch and fetchChecked", () => {
  it("wraps a rejected fetch as a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    await expect(safeFetch(fetchImpl, "http://h/", {})).rejects.toMatchObject({
      kind: "network",
    });
  });

  it("requests manual redirects and refuses any 3xx", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("moved", { status: 302, headers: { Location: "http://x/" } }),
    ) as unknown as typeof globalThis.fetch;
    await expect(safeFetch(fetchImpl, "http://h/", { method: "GET" })).rejects.toMatchObject({
      kind: "server",
      status: 302,
      detail: "redirect refused; configure the final endpoint URL",
    });
    expect(fetchImpl).toHaveBeenCalledWith("http://h/", { method: "GET", redirect: "manual" });
  });

  it("describes a redirect without a location", async () => {
    const error = await toRedirectError(new Response(null, { status: 307 }));
    expect(error).toBeInstanceOf(WebdavError);
    expect(error.detail).toBe("redirect refused");
  });

  it("accepts 2xx by default or the listed statuses only", async () => {
    const ok = vi.fn(async () => new Response(null, { status: 207 })) as unknown as typeof fetch;
    await expect(fetchChecked(ok, "http://h/", {})).resolves.toBeInstanceOf(Response);
    await expect(fetchChecked(ok, "http://h/", {}, [201])).rejects.toMatchObject({
      kind: "unexpected",
      status: 207,
    });
    const notFound = vi.fn(
      async () => new Response("x", { status: 404 }),
    ) as unknown as typeof fetch;
    await expect(fetchChecked(notFound, "http://h/", {})).rejects.toMatchObject({
      kind: "not_found",
    });
  });
});

describe("readTextBounded", () => {
  it("returns the text of a body within the bound", async () => {
    expect(await readTextBounded(new Response(chunked(["ab", "cd"])), 10)).toBe("abcd");
    expect(await readTextBounded(new Response(null), 10)).toBe("");
  });

  it("refuses a declared length or a streamed size over the bound", async () => {
    const declared = new Response("x".repeat(20), { headers: { "Content-Length": "20" } });
    expect(await readTextBounded(declared, 10)).toBeNull();
    expect(await readTextBounded(new Response(chunked(["12345", "678901"])), 10)).toBeNull();
  });

  it("returns null when the stream fails", async () => {
    expect(await readTextBounded(new Response(chunked(["ab"], true)), 10)).toBeNull();
  });
});

function uncancellable(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(64));
    },
    cancel() {
      throw new Error("cannot cancel");
    },
  });
}

describe("bodies whose cancel rejects", () => {
  it("are still swallowed by every bounded reader", async () => {
    await expect(cancelBody(new Response(uncancellable()))).resolves.toBeUndefined();
    expect(await readTextBounded(new Response(uncancellable()), 10)).toBeNull();
    await expect(drainBounded(new Response(uncancellable()), 10)).resolves.toBeUndefined();
    const declared = new Response(uncancellable(), { headers: { "Content-Length": "99" } });
    expect(await readTextBounded(declared, 10)).toBeNull();
    const redirect = new Response(uncancellable(), { status: 301 });
    expect((await toRedirectError(redirect)).status).toBe(301);
  });
});

describe("drainBounded", () => {
  it("reads to the end of a short body and stops early on a long one", async () => {
    await expect(drainBounded(new Response(chunked(["a", "b"])), 10)).resolves.toBeUndefined();
    await expect(drainBounded(new Response(null), 10)).resolves.toBeUndefined();
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    await drainBounded(new Response(endless), 2048);
    expect(pulls).toBeLessThan(10);
  });
});

describe("small helpers", () => {
  it("cancels bodies safely", async () => {
    await expect(cancelBody(new Response("x"))).resolves.toBeUndefined();
    await expect(cancelBody(new Response(null))).resolves.toBeUndefined();
    const used = new Response("x");
    await used.text();
    await expect(cancelBody(used)).resolves.toBeUndefined();
  });

  it("parses integers and dates or returns null", () => {
    expect(parseIntOrNull("12")).toBe(12);
    expect(parseIntOrNull("x")).toBeNull();
    expect(parseIntOrNull(null)).toBeNull();
    expect(parseDateOrNull("Wed, 21 Oct 2015 07:28:00 GMT")?.toISOString()).toBe(
      "2015-10-21T07:28:00.000Z",
    );
    expect(parseDateOrNull("never")).toBeNull();
    expect(parseDateOrNull(null)).toBeNull();
  });

  it("emits an empty stream", async () => {
    expect(await new Response(emptyByteStream()).text()).toBe("");
  });
});
