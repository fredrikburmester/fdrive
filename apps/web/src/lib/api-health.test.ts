import { describe, expect, it, vi } from "vitest";
import { fetchApiHealth } from "./api-health.js";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("fetchApiHealth", () => {
  it("returns ok with the reported version on a successful response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ version: "1.2.3" }));

    const result = await fetchApiHealth(fetchImpl, "http://api.local");

    expect(result).toEqual({ ok: true, version: "1.2.3" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://api.local/api/v1/health",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("falls back to 'unknown' when the body has no version field", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));

    const result = await fetchApiHealth(fetchImpl, "http://api.local");

    expect(result).toEqual({ ok: true, version: "unknown" });
  });

  it("falls back to 'unknown' when version is not a string", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ version: 123 }));

    const result = await fetchApiHealth(fetchImpl, "http://api.local");

    expect(result).toEqual({ ok: true, version: "unknown" });
  });

  it("returns not ok when the response body is not an object", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse("not-an-object"));

    const result = await fetchApiHealth(fetchImpl, "http://api.local");

    expect(result).toEqual({ ok: true, version: "unknown" });
  });

  it("returns not ok on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false));

    const result = await fetchApiHealth(fetchImpl, "http://api.local");

    expect(result).toEqual({ ok: false });
  });

  it("returns not ok when fetch rejects with a network error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await fetchApiHealth(fetchImpl, "http://api.local");

    expect(result).toEqual({ ok: false });
  });

  it("returns not ok when the response body is not valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    } as unknown as Response);

    const result = await fetchApiHealth(fetchImpl, "http://api.local");

    expect(result).toEqual({ ok: false });
  });

  it("returns not ok when the request times out", async () => {
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    const result = await fetchApiHealth(fetchImpl, "http://api.local", 5);

    expect(result).toEqual({ ok: false });
  });
});
