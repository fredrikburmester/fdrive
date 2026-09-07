import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscoveryCache } from "./discovery-cache.ts";
import { officialKeys } from "./proof-vectors.fixture.ts";

const xml = `<wopi-discovery><net-zone name="external-https"><app name="Word"><action ext="docx" name="view" urlsrc="https://office/view?"/></app></net-zone><proof-key modulus="${officialKeys.modulus}" exponent="AQAB"/></wopi-discovery>`;
afterEach(() => vi.useRealTimers());

describe("discovery cache", () => {
  it("deduplicates initial and explicit refreshes, keeps a 12-hour cache", async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(xml));
    const cache = createDiscoveryCache({
      serverUrl: "https://office/prefix/",
      fetch: fetcher,
      now: () => now,
    });
    const first = cache.get();
    expect(cache.get()).toBe(first);
    expect(cache.refresh()).toBe(first);
    const discovery = await first;
    expect(fetcher).toHaveBeenCalledWith("https://office/prefix/hosting/discovery", {
      signal: expect.any(AbortSignal),
      redirect: "error",
      credentials: "omit",
    });
    now = 12 * 3600000 - 1;
    expect(await cache.get()).toBe(discovery);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now++;
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await cache.refresh();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("does not serve stale keys while refresh fails or afterward", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(xml))
      .mockResolvedValueOnce(new Response("<broken>"))
      .mockResolvedValueOnce(new Response(xml));
    const cache = createDiscoveryCache({ serverUrl: "http://office", fetch: fetcher });
    await cache.get();
    const refresh = cache.refresh();
    expect(cache.get()).toBe(refresh);
    await expect(refresh).rejects.toThrow();
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("streams and enforces byte limits even when Content-Length lies", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
        controller.enqueue(new Uint8Array(5));
      },
      cancel,
    });
    const cache = createDiscoveryCache({
      serverUrl: "http://office",
      maxBytes: 9,
      fetch: async () => new Response(stream, { headers: { "Content-Length": "1" } }),
    });
    await expect(cache.get()).rejects.toThrow("size limit");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("accepts an exact response size limit", async () => {
    const cache = createDiscoveryCache({
      serverUrl: "http://office",
      maxBytes: Buffer.byteLength(xml),
      fetch: async () => new Response(xml),
    });
    expect((await cache.get()).actions).toHaveLength(1);
  });
  it.each([
    new Response("failed", { status: 500 }),
    new Response(null),
    new Response(Uint8Array.of(0xff)),
  ])("rejects bad responses", async (response) => {
    const cache = createDiscoveryCache({ serverUrl: "http://office", fetch: async () => response });
    await expect(cache.get()).rejects.toThrow();
  });
  it("propagates transport failures and permits a later retry", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(new Response(xml));
    const cache = createDiscoveryCache({ serverUrl: "http://office", fetch: fetcher });
    await expect(cache.get()).rejects.toThrow("network");
    await expect(cache.get()).resolves.toHaveProperty("actions");
  });
  it("enforces a deadline even when the injected fetch ignores abort", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = (_url, options) => {
      signal = options?.signal;
      return new Promise(() => undefined);
    };
    const cache = createDiscoveryCache({
      serverUrl: "http://office",
      timeoutMs: 10,
      fetch: fetcher,
    });
    const result = expect(cache.get()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("handles body read errors and cancellation rejection", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("body failed"));
      },
    });
    const cache = createDiscoveryCache({
      serverUrl: "http://office",
      fetch: async () => new Response(stream),
    });
    await expect(cache.get()).rejects.toThrow("body failed");
  });
  it("cancels a stalled response body at the deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const cache = createDiscoveryCache({
      serverUrl: "http://office",
      timeoutMs: 10,
      fetch: async () => new Response(stream),
    });
    const result = expect(cache.get()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("cancels a response that arrives after the deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    let resolveFetch: (response: Response) => void = () => undefined;
    const cache = createDiscoveryCache({
      serverUrl: "http://office",
      timeoutMs: 10,
      fetch: () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    });
    const result = expect(cache.get()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10);
    await result;
    resolveFetch(new Response(stream));
    await vi.runAllTimersAsync();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([
    { serverUrl: "https://office?x=1" },
    { timeoutMs: 0 },
    { maxBytes: -1 },
    { ttlMs: 0 },
    { timeoutMs: 1.2 },
  ])("rejects invalid configuration %j", (patch) => {
    expect(() =>
      createDiscoveryCache({ serverUrl: "http://office", fetch: vi.fn<typeof fetch>(), ...patch }),
    ).toThrow();
  });
  it("uses an injected TTL", async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(xml));
    const cache = createDiscoveryCache({
      serverUrl: "http://office",
      ttlMs: 1,
      now: () => now,
      fetch: fetcher,
    });
    await cache.get();
    now = 1;
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
