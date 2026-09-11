import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createSftpgoClient } from "./client.js";
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
import { probeConnection } from "./probe.js";

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

  it("keeps a reverse-proxy path prefix from the base URL", () => {
    const url = buildUrl("https://files.example/sftpgo", "/api/v2/user/dirs", {
      path: "/docs",
    });
    expect(url).toBe("https://files.example/sftpgo/api/v2/user/dirs?path=%2Fdocs");
  });

  it("keeps a multi-segment prefix, with or without a trailing slash", () => {
    expect(buildUrl("https://files.example/apps/sftpgo", "/healthz")).toBe(
      "https://files.example/apps/sftpgo/healthz",
    );
    expect(buildUrl("https://files.example/apps/sftpgo/", "/healthz")).toBe(
      "https://files.example/apps/sftpgo/healthz",
    );
  });

  it("never lets a path escape the configured origin", () => {
    expect(buildUrl("http://host", "//other.example/x")).toBe("http://host/other.example/x");
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

/**
 * A real loopback HTTP server standing in for SFTPGo behind a reverse proxy
 * that confines it to a subpath. It answers only under `prefix`; every other
 * path is a 404, so a client that drops the prefix fails here instead of
 * silently passing a URL-string assertion. Pass "" for the unproxied
 * deployment, which must keep behaving exactly as before.
 */
async function startSftpgoBehind(prefix: string): Promise<{
  readonly baseUrl: string;
  readonly requests: readonly string[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    req.resume();
    const target = req.url ?? "";
    requests.push(target);
    const route = new URL(target, "http://127.0.0.1").pathname.slice(prefix.length);
    const send = (status: number, contentType: string, body: string): void => {
      res.writeHead(status, { "content-type": contentType });
      res.end(body);
    };
    if (!target.startsWith(`${prefix}/`)) {
      send(404, "text/plain", "outside the proxy prefix");
      return;
    }
    if (route === "/healthz") {
      send(200, "text/plain", "ok");
      return;
    }
    if (route === "/api/v2/user/token") {
      if (req.headers.authorization === undefined) {
        send(401, "text/plain", "unauthorized");
        return;
      }
      send(
        200,
        "application/json",
        JSON.stringify({ access_token: "proxied", expires_at: "2999-01-01T00:00:00Z" }),
      );
      return;
    }
    if (route === "/api/v2/user/dirs" && req.headers.authorization === "Bearer proxied") {
      send(
        200,
        "application/json",
        JSON.stringify([
          { name: "notes.txt", size: 3, mode: 420, last_modified: "2026-01-02T03:04:05Z" },
        ]),
      );
      return;
    }
    send(404, "text/plain", "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no fixture port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}${prefix}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("endpoint joining against a real reverse-proxied SFTPGo", () => {
  it("reaches the proxied API through a prefixed endpoint", async () => {
    const fixture = await startSftpgoBehind("/sftpgo");
    try {
      const client = createSftpgoClient({ baseUrl: fixture.baseUrl });

      const token = await client.login({ username: "alice", password: "secret" });
      const entries = await client.user(token.accessToken).list("/");

      expect(entries.map((entry) => entry.name)).toEqual(["notes.txt"]);
      expect(fixture.requests).toEqual([
        "/sftpgo/api/v2/user/token",
        "/sftpgo/api/v2/user/dirs?path=%2F",
      ]);
    } finally {
      await fixture.close();
    }
  });

  // probeConnection joins its two paths by string concatenation rather than
  // through buildUrl, so it always kept the prefix. Locked in here so the two
  // ways this package reaches an endpoint cannot drift apart again.
  it("probes the proxied health and token endpoints through a prefixed endpoint", async () => {
    const fixture = await startSftpgoBehind("/sftpgo");
    try {
      await expect(probeConnection(fixture.baseUrl, { fetch })).resolves.toEqual({
        ok: true,
        detail: "SFTPGo is reachable",
      });
      expect(fixture.requests).toEqual(["/sftpgo/healthz", "/sftpgo/api/v2/user/token"]);
    } finally {
      await fixture.close();
    }
  });

  it("fails loudly when the prefix is dropped, the way the old join did", async () => {
    const fixture = await startSftpgoBehind("/sftpgo");
    try {
      const unprefixed = new URL(fixture.baseUrl).origin;
      const client = createSftpgoClient({ baseUrl: unprefixed });

      await expect(client.login({ username: "alice", password: "secret" })).rejects.toMatchObject({
        kind: "not_found",
        status: 404,
      });
      expect(fixture.requests).toEqual(["/api/v2/user/token"]);
    } finally {
      await fixture.close();
    }
  });

  it("still reaches an unproxied SFTPGo served at the origin root", async () => {
    const fixture = await startSftpgoBehind("");
    try {
      const client = createSftpgoClient({ baseUrl: fixture.baseUrl });

      const token = await client.login({ username: "alice", password: "secret" });
      await client.user(token.accessToken).list("/");
      await expect(probeConnection(fixture.baseUrl, { fetch })).resolves.toMatchObject({
        ok: true,
      });

      expect(fixture.requests).toEqual([
        "/api/v2/user/token",
        "/api/v2/user/dirs?path=%2F",
        "/healthz",
        "/api/v2/user/token",
      ]);
    } finally {
      await fixture.close();
    }
  });
});
