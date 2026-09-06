import { describe, expect, it, vi } from "vitest";
import { fetchEmbedStatus } from "./embed-status.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchEmbedStatus", () => {
  it("reports not configured when baseUrl is undefined", async () => {
    const fetchStub = vi.fn();

    const result = await fetchEmbedStatus({ baseUrl: undefined, fetch: fetchStub });

    expect(result).toEqual({ configured: false, healthy: false });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("reports healthy with model info when both endpoints succeed", async () => {
    const fetchStub = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/health")) {
        return Promise.resolve(new Response("", { status: 200 }));
      }
      return Promise.resolve(
        jsonResponse(200, { model_id: "intfloat/multilingual-e5-small", max_input_length: 512 }),
      );
    });

    const result = await fetchEmbedStatus({ baseUrl: "http://embed:80", fetch: fetchStub });

    expect(result).toEqual({
      configured: true,
      healthy: true,
      model: "intfloat/multilingual-e5-small",
      maxInputLength: 512,
    });
  });

  it("reports unhealthy without model info when /health fails", async () => {
    const fetchStub = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/health")) {
        return Promise.reject(new Error("refused"));
      }
      return Promise.resolve(jsonResponse(500, {}));
    });

    const result = await fetchEmbedStatus({ baseUrl: "http://embed:80", fetch: fetchStub });

    expect(result).toEqual({ configured: true, healthy: false });
  });

  it("reports healthy without model info when /info is unreachable", async () => {
    const fetchStub = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/health")) {
        return Promise.resolve(new Response("", { status: 200 }));
      }
      return Promise.reject(new Error("refused"));
    });

    const result = await fetchEmbedStatus({ baseUrl: "http://embed:80", fetch: fetchStub });

    expect(result).toEqual({ configured: true, healthy: true });
  });

  it("reports unhealthy when /health returns a non-2xx status", async () => {
    const fetchStub = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/health")) {
        return Promise.resolve(new Response("", { status: 503 }));
      }
      return Promise.resolve(jsonResponse(200, { model_id: "m", max_input_length: 1 }));
    });

    const result = await fetchEmbedStatus({ baseUrl: "http://embed:80", fetch: fetchStub });

    expect(result.healthy).toBe(false);
  });

  it("reports unhealthy when /health does not respond before the timeout", async () => {
    const fetchStub = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/health")) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return Promise.resolve(jsonResponse(200, { model_id: "m", max_input_length: 1 }));
    });

    const result = await fetchEmbedStatus({
      baseUrl: "http://embed:80",
      fetch: fetchStub,
      timeoutMs: 5,
    });

    expect(result.healthy).toBe(false);
  });
});
