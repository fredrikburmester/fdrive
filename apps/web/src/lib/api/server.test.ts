import { beforeEach, describe, expect, it, vi } from "vitest";

const headersMock = vi.fn();

vi.mock("next/headers", () => ({
  headers: () => headersMock(),
}));

describe("resolveApiInternalUrl", () => {
  it("uses API_INTERNAL_URL when set", async () => {
    const { resolveApiInternalUrl } = await import("./server.js");
    expect(
      resolveApiInternalUrl({
        API_INTERNAL_URL: "http://api.internal:4000",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("http://api.internal:4000");
  });

  it("falls back to the local dev default when unset", async () => {
    const { resolveApiInternalUrl } = await import("./server.js");
    expect(resolveApiInternalUrl({} as unknown as NodeJS.ProcessEnv)).toBe("http://localhost:3001");
  });
});

describe("buildForwardingFetch", () => {
  it("forwards the cookie header onto every request", async () => {
    const { buildForwardingFetch } = await import("./server.js");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null));

    const forwardingFetch = buildForwardingFetch(fetchImpl, "session=abc");
    await forwardingFetch("http://api.internal/api/v1/auth/me");

    const [, init] = fetchImpl.mock.calls[0] as [unknown, RequestInit];
    expect(new Headers(init.headers).get("cookie")).toBe("session=abc");
  });

  it("does not set a cookie header when there is none to forward", async () => {
    const { buildForwardingFetch } = await import("./server.js");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null));

    const forwardingFetch = buildForwardingFetch(fetchImpl, null);
    await forwardingFetch("http://api.internal/api/v1/auth/me");

    const [, init] = fetchImpl.mock.calls[0] as [unknown, RequestInit];
    expect(new Headers(init.headers).get("cookie")).toBeNull();
  });
});

describe("serverApiClient", () => {
  beforeEach(() => {
    headersMock.mockReset();
    process.env.API_INTERNAL_URL = "http://api.internal:4000";
  });

  it("builds an ApiClient that forwards the incoming cookie header", async () => {
    headersMock.mockReturnValue({ get: () => "session=abc" });
    const body = {
      version: "1.0.0",
      providers: [{ type: "sftpgo", label: "localhost:8080" }],
      setupRequired: false,
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const { serverApiClient } = await import("./server.js");
    const client = await serverApiClient();
    await client.about();

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.internal:4000/api/v1/about");
    expect(new Headers(init.headers).get("cookie")).toBe("session=abc");

    vi.unstubAllGlobals();
  });
});
