import { describe, expect, it, vi } from "vitest";
import { SftpgoError } from "./errors.js";
import {
  basicAuthHeader,
  buildUrl,
  combineSignals,
  emptyByteStream,
  fetchChecked,
  parseDateOrNull,
  parseIntOrNull,
  safeFetch,
  stripTrailingSlash,
  toRedirectError,
} from "./http.js";

describe("stripTrailingSlash", () => {
  it("removes a single trailing slash", () => {
    expect(stripTrailingSlash("http://host:8080/")).toBe("http://host:8080");
  });

  it("leaves a URL without a trailing slash untouched", () => {
    expect(stripTrailingSlash("http://host:8080")).toBe("http://host:8080");
  });
});

describe("buildUrl", () => {
  it("builds a URL with query params, encoding values", () => {
    const url = buildUrl("http://host", "/api/v2/user/dirs", { path: "/a b" });
    expect(url).toBe("http://host/api/v2/user/dirs?path=%2Fa+b");
  });

  it("omits undefined params", () => {
    const url = buildUrl("http://host", "/api/v2/user/dirs", { path: "/a", other: undefined });
    expect(url).toBe("http://host/api/v2/user/dirs?path=%2Fa");
  });

  it("coerces numbers and booleans to strings", () => {
    const url = buildUrl("http://host", "/x", { limit: 500, flag: true });
    expect(url).toContain("limit=500");
    expect(url).toContain("flag=true");
  });
});

describe("basicAuthHeader", () => {
  it("base64-encodes username:password", () => {
    expect(basicAuthHeader("alice", "secret")).toBe(
      `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    );
  });
});

describe("combineSignals", () => {
  it("returns a signal that never aborts when neither input is given", () => {
    const signal = combineSignals(undefined, null);
    expect(signal.aborted).toBe(false);
  });

  it("returns an aborted signal when the user signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    const signal = combineSignals(controller.signal, null);
    expect(signal.aborted).toBe(true);
  });

  it("combines a user signal with a timeout", () => {
    const controller = new AbortController();
    const signal = combineSignals(controller.signal, 10000);
    expect(signal.aborted).toBe(false);
  });

  it("applies only the timeout when no user signal is given", () => {
    const signal = combineSignals(undefined, 10000);
    expect(signal.aborted).toBe(false);
  });
});

describe("safeFetch", () => {
  it("returns the response on success", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const response = await safeFetch(fetchImpl, "http://host/", {});
    expect(await response.text()).toBe("ok");
  });

  it("converts a rejected fetch into a network SftpgoError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(safeFetch(fetchImpl, "http://host/", {})).rejects.toMatchObject({
      kind: "network",
    });
  });

  it("requests redirect: manual by default", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    await safeFetch(fetchImpl, "http://host/", { method: "GET" });
    expect(fetchImpl).toHaveBeenCalledWith("http://host/", {
      method: "GET",
      redirect: "manual",
    });
  });

  it("honours an explicit redirect option instead of overriding it", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    await safeFetch(fetchImpl, "http://host/", { redirect: "follow" });
    expect(fetchImpl).toHaveBeenCalledWith("http://host/", { redirect: "follow" });
  });

  it("throws a server-kind SftpgoError for a 3xx response instead of returning it", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("moved", { status: 302, headers: { Location: "http://evil/" } }),
    );
    await expect(safeFetch(fetchImpl, "http://host/", {})).rejects.toMatchObject({
      kind: "server",
      status: 302,
      detail: "moved",
    });
  });
});

describe("toRedirectError", () => {
  it("reads the response body as detail", async () => {
    const error = await toRedirectError(new Response("moved permanently", { status: 301 }));
    expect(error).toMatchObject({ kind: "server", status: 301, detail: "moved permanently" });
  });

  it("truncates a very long body", async () => {
    const error = await toRedirectError(new Response("x".repeat(600), { status: 302 }));
    expect(error.detail).toHaveLength(500);
  });

  it("uses a null detail for an empty body", async () => {
    const error = await toRedirectError(new Response("", { status: 302 }));
    expect(error.detail).toBeNull();
  });

  it("falls back to a null detail when reading the body throws", async () => {
    const response = new Response("moved", { status: 302 });
    vi.spyOn(response, "text").mockRejectedValue(new Error("stream error"));
    const error = await toRedirectError(response);
    expect(error.detail).toBeNull();
  });
});

describe("fetchChecked", () => {
  it("returns the response when the status is ok", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const response = await fetchChecked(fetchImpl, "http://host/", {});
    expect(response.status).toBe(200);
  });

  it("returns the response when the status is in the explicit okStatuses list", async () => {
    const fetchImpl = vi.fn(async () => new Response("created", { status: 201 }));
    const response = await fetchChecked(fetchImpl, "http://host/", {}, [201]);
    expect(response.status).toBe(201);
  });

  it("throws a SftpgoError when the status is not ok", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "nope" }), { status: 404 }),
    );
    await expect(fetchChecked(fetchImpl, "http://host/", {})).rejects.toBeInstanceOf(SftpgoError);
  });

  it("throws when the status is not in the explicit okStatuses list", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    await expect(fetchChecked(fetchImpl, "http://host/", {}, [201])).rejects.toBeInstanceOf(
      SftpgoError,
    );
  });

  it("throws a server-kind SftpgoError for a 3xx response, even when okStatuses is given", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 307 }));
    await expect(fetchChecked(fetchImpl, "http://host/", {}, [307])).rejects.toMatchObject({
      kind: "server",
      status: 307,
    });
  });
});

describe("parseIntOrNull", () => {
  it("parses a numeric string", () => {
    expect(parseIntOrNull("42")).toBe(42);
  });

  it("returns null for null input", () => {
    expect(parseIntOrNull(null)).toBeNull();
  });

  it("returns null for a non-numeric string", () => {
    expect(parseIntOrNull("abc")).toBeNull();
  });
});

describe("parseDateOrNull", () => {
  it("parses a valid date string", () => {
    expect(parseDateOrNull("2024-01-02T00:00:00Z")).toEqual(new Date("2024-01-02T00:00:00Z"));
  });

  it("returns null for null input", () => {
    expect(parseDateOrNull(null)).toBeNull();
  });

  it("returns null for an invalid date string", () => {
    expect(parseDateOrNull("not a date")).toBeNull();
  });
});

describe("emptyByteStream", () => {
  it("produces a stream that closes immediately with no data", async () => {
    const reader = emptyByteStream().getReader();
    const result = await reader.read();
    expect(result.done).toBe(true);
  });
});
