import { describe, expect, it, vi } from "vitest";
import { ApiClientError, buildRequestUrl, createApiClient, toQueryString } from "./client";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";
const AT = "2026-01-01T00:00:00.000Z";

const VALID_ME = {
  account: { id: VALID_UUID, displayName: "Alice" },
  identities: [
    { id: VALID_UUID, username: "alice", providerType: "sftpgo", providerLabel: "Home" },
  ],
  activeIdentityId: VALID_UUID,
};

const VALID_ENTRY = {
  name: "photo.jpg",
  path: "/photos/photo.jpg",
  kind: "file",
  size: 1024,
  modifiedAt: AT,
  ext: "jpg",
  mime: "image/jpeg",
};

const VALID_LIST = { path: "/photos", entries: [VALID_ENTRY] };
const VALID_ABOUT = {
  version: "1.0.0",
  builtOn: { name: "SFTPGo", sourceUrl: "https://github.com/drakkan/sftpgo" },
  provider: { type: "sftpgo", label: "localhost:8080" },
};

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createStubFetch(responses: Response[]) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("no more stub responses queued");
    }
    return next;
  });
  return { fetchStub, calls };
}

function headerValue(init: RequestInit, name: string): string | null {
  const headers = init.headers;
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  return new Headers(headers as ConstructorParameters<typeof Headers>[0]).get(name);
}

describe("toQueryString", () => {
  it("returns an empty string for no entries", () => {
    expect(toQueryString({})).toBe("");
  });

  it("omits keys with an undefined value", () => {
    expect(toQueryString({ a: "1", b: undefined })).toBe("?a=1");
  });

  it("serializes multiple keys", () => {
    const qs = toQueryString({ a: "1", b: "2" });
    expect(qs).toBe("?a=1&b=2");
  });
});

describe("buildRequestUrl", () => {
  it("joins baseUrl and path with no query", () => {
    expect(buildRequestUrl("https://api.example.com", "/api/v1/fs/list")).toBe(
      "https://api.example.com/api/v1/fs/list",
    );
  });

  it("appends a query string when given", () => {
    expect(buildRequestUrl("", "/api/v1/fs/list", { path: "/a" })).toBe(
      "/api/v1/fs/list?path=%2Fa",
    );
  });
});

describe("createApiClient: login", () => {
  it("posts credentials and returns MeResponse", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ME)]);
    const client = createApiClient({ baseUrl: "https://api.test", fetch: fetchStub });

    const result = await client.login({ username: "alice", password: "hunter2" });

    expect(result).toEqual(VALID_ME);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.test/api/v1/auth/login");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.credentials).toBe("include");
    expect(headerValue(calls[0]?.init ?? {}, "x-requested-with")).toBe("fdrive");
    expect(headerValue(calls[0]?.init ?? {}, "content-type")).toBe("application/json");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ username: "alice", password: "hunter2" }));
  });

  it("sends the identity header when configured", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ME)]);
    const client = createApiClient({ fetch: fetchStub, identityId: "identity-1" });

    await client.login({ username: "alice", password: "hunter2" });

    expect(headerValue(calls[0]?.init ?? {}, "x-identity-id")).toBe("identity-1");
  });

  it("does not send the identity header when not configured", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ME)]);
    const client = createApiClient({ fetch: fetchStub });

    await client.login({ username: "alice", password: "hunter2" });

    expect(headerValue(calls[0]?.init ?? {}, "x-identity-id")).toBeNull();
  });
});

describe("createApiClient: logout", () => {
  it("posts to auth/logout and parses OkResponse", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { ok: true })]);
    const client = createApiClient({ fetch: fetchStub });

    const result = await client.logout();

    expect(result).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("/api/v1/auth/logout");
    expect(calls[0]?.init.method).toBe("POST");
    expect(headerValue(calls[0]?.init ?? {}, "x-requested-with")).toBe("fdrive");
  });
});

describe("createApiClient: me", () => {
  it("gets auth/me without the csrf header", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ME)]);
    const client = createApiClient({ fetch: fetchStub });

    const result = await client.me();

    expect(result).toEqual(VALID_ME);
    expect(calls[0]?.init.method).toBe("GET");
    expect(headerValue(calls[0]?.init ?? {}, "x-requested-with")).toBeNull();
  });
});

describe("createApiClient: list", () => {
  it("gets fs/list with a path query", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_LIST)]);
    const client = createApiClient({ fetch: fetchStub });

    const result = await client.list("/photos");

    expect(result).toEqual(VALID_LIST);
    expect(calls[0]?.url).toBe("/api/v1/fs/list?path=%2Fphotos");
  });
});

describe("createApiClient: stat", () => {
  it("gets fs/stat and returns an entry", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ENTRY)]);
    const client = createApiClient({ fetch: fetchStub });

    const result = await client.stat("/photos/photo.jpg");

    expect(result).toEqual(VALID_ENTRY);
    expect(calls[0]?.url).toBe("/api/v1/fs/stat?path=%2Fphotos%2Fphoto.jpg");
  });
});

describe("createApiClient: mkdir", () => {
  it("posts fs/mkdir with the path body", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ENTRY)]);
    const client = createApiClient({ fetch: fetchStub });

    const result = await client.mkdir("/photos/new");

    expect(result).toEqual(VALID_ENTRY);
    expect(calls[0]?.url).toBe("/api/v1/fs/mkdir");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ path: "/photos/new" }));
  });
});

describe("createApiClient: move", () => {
  it("posts fs/move with path and target", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ENTRY)]);
    const client = createApiClient({ fetch: fetchStub });

    await client.move("/a", "/b");

    expect(calls[0]?.url).toBe("/api/v1/fs/move");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ path: "/a", target: "/b" }));
  });
});

describe("createApiClient: copy", () => {
  it("posts fs/copy with path and target", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ENTRY)]);
    const client = createApiClient({ fetch: fetchStub });

    await client.copy("/a", "/b");

    expect(calls[0]?.url).toBe("/api/v1/fs/copy");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ path: "/a", target: "/b" }));
  });
});

describe("createApiClient: rename", () => {
  it("posts fs/rename with path and newName", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ENTRY)]);
    const client = createApiClient({ fetch: fetchStub });

    await client.rename("/a/old.txt", "new.txt");

    expect(calls[0]?.url).toBe("/api/v1/fs/rename");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ path: "/a/old.txt", newName: "new.txt" }));
  });
});

describe("createApiClient: remove", () => {
  it("posts fs/delete with the items array", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { ok: true })]);
    const client = createApiClient({ fetch: fetchStub });

    const items = [{ path: "/a", kind: "file" as const }];
    const result = await client.remove(items);

    expect(result).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("/api/v1/fs/delete");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ items }));
  });
});

describe("createApiClient: zip", () => {
  it("posts fs/zip with paths only and returns the raw Response", async () => {
    const zipResponse = new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    const { fetchStub, calls } = createStubFetch([zipResponse]);
    const client = createApiClient({ fetch: fetchStub });

    const result = await client.zip(["/a", "/b"]);

    expect(result).toBe(zipResponse);
    expect(calls[0]?.init.body).toBe(JSON.stringify({ paths: ["/a", "/b"] }));
  });

  it("includes name when given", async () => {
    const { fetchStub, calls } = createStubFetch([new Response(null, { status: 200 })]);
    const client = createApiClient({ fetch: fetchStub });

    await client.zip(["/a"], "archive.zip");

    expect(calls[0]?.init.body).toBe(JSON.stringify({ paths: ["/a"], name: "archive.zip" }));
  });
});

describe("createApiClient: downloadUrl", () => {
  it("builds a url with only the path when inline is not requested", () => {
    const client = createApiClient({ baseUrl: "https://api.test" });
    expect(client.downloadUrl("/a/b.txt")).toBe(
      "https://api.test/api/v1/fs/download?path=%2Fa%2Fb.txt",
    );
  });

  it("adds inline=1 when requested", () => {
    const client = createApiClient({ baseUrl: "https://api.test" });
    expect(client.downloadUrl("/a/b.txt", { inline: true })).toBe(
      "https://api.test/api/v1/fs/download?path=%2Fa%2Fb.txt&inline=1",
    );
  });

  it("omits inline when explicitly false", () => {
    const client = createApiClient({});
    expect(client.downloadUrl("/a", { inline: false })).toBe("/api/v1/fs/download?path=%2Fa");
  });
});

describe("createApiClient: upload", () => {
  it("puts the body to fs/upload with the path query", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ENTRY)]);
    const client = createApiClient({ fetch: fetchStub });

    const body = new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>;
    const result = await client.upload("/a/b.bin", body);

    expect(result).toEqual(VALID_ENTRY);
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.url).toBe("/api/v1/fs/upload?path=%2Fa%2Fb.bin");
    expect(headerValue(calls[0]?.init ?? {}, "x-requested-with")).toBe("fdrive");
  });

  it("sets mkdirParents=true in the query when requested", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ENTRY)]);
    const client = createApiClient({ fetch: fetchStub });

    await client.upload("/a/b.bin", new Uint8Array() as Uint8Array<ArrayBuffer>, {
      mkdirParents: true,
    });

    expect(calls[0]?.url).toBe("/api/v1/fs/upload?path=%2Fa%2Fb.bin&mkdirParents=true");
  });

  it("sets mkdirParents=false in the query when explicitly disabled", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ENTRY)]);
    const client = createApiClient({ fetch: fetchStub });

    await client.upload("/a/b.bin", new Uint8Array() as Uint8Array<ArrayBuffer>, {
      mkdirParents: false,
    });

    expect(calls[0]?.url).toBe("/api/v1/fs/upload?path=%2Fa%2Fb.bin&mkdirParents=false");
  });

  it("sends the modifiedAt header as ms since epoch", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ENTRY)]);
    const client = createApiClient({ fetch: fetchStub });
    const modifiedAt = new Date("2026-01-01T00:00:00.000Z");

    await client.upload("/a/b.bin", new Uint8Array() as Uint8Array<ArrayBuffer>, { modifiedAt });

    expect(headerValue(calls[0]?.init ?? {}, "x-modified-at")).toBe(String(modifiedAt.getTime()));
  });

  it("sends the content-length header when given", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ENTRY)]);
    const client = createApiClient({ fetch: fetchStub });

    await client.upload("/a/b.bin", new Uint8Array() as Uint8Array<ArrayBuffer>, {
      contentLength: 42,
    });

    expect(headerValue(calls[0]?.init ?? {}, "content-length")).toBe("42");
  });

  it("sets duplex: half when the body is a ReadableStream", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ENTRY)]);
    const client = createApiClient({ fetch: fetchStub });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });

    await client.upload("/a/b.bin", stream);

    const call = calls[0];
    expect(call).toBeDefined();
    expect((call?.init as { duplex?: string } | undefined)?.duplex).toBe("half");
  });

  it("accepts a Blob body", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ENTRY)]);
    const client = createApiClient({ fetch: fetchStub });

    await client.upload("/a/b.bin", new Blob(["hello"]));

    expect(calls).toHaveLength(1);
  });
});

const VALID_JOB_STATUS = {
  id: "job-1",
  kind: "compress",
  state: "queued",
  createdAt: AT,
  updatedAt: AT,
  progress: { processed: 0, total: null, bytes: 0 },
};

describe("createApiClient: duplicate", () => {
  it("posts fs/duplicate with the path", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ENTRY)]);
    const client = createApiClient({ fetch: fetchStub });

    const result = await client.duplicate("/a.txt");

    expect(result).toEqual(VALID_ENTRY);
    expect(calls[0]?.url).toBe("/api/v1/fs/duplicate");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ path: "/a.txt" }));
  });
});

describe("createApiClient: compress", () => {
  it("posts fs/compress and returns the accepted job id", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(202, { jobId: "job-1" })]);
    const client = createApiClient({ fetch: fetchStub });

    const result = await client.compress({ paths: ["/a"], format: "zip" });

    expect(result).toEqual({ jobId: "job-1" });
    expect(calls[0]?.url).toBe("/api/v1/fs/compress");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ paths: ["/a"], format: "zip" }));
  });
});

describe("createApiClient: extract", () => {
  it("posts fs/extract and returns the accepted job id", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(202, { jobId: "job-2" })]);
    const client = createApiClient({ fetch: fetchStub });

    const result = await client.extract({ path: "/a.zip" });

    expect(result).toEqual({ jobId: "job-2" });
    expect(calls[0]?.url).toBe("/api/v1/fs/extract");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ path: "/a.zip" }));
  });
});

describe("createApiClient: jobs", () => {
  it("gets fs/jobs and unwraps the jobs array", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { jobs: [VALID_JOB_STATUS] })]);
    const client = createApiClient({ fetch: fetchStub });

    const result = await client.jobs();

    expect(result).toEqual([VALID_JOB_STATUS]);
    expect(calls[0]?.url).toBe("/api/v1/fs/jobs");
    expect(calls[0]?.init.method).toBe("GET");
  });
});

describe("createApiClient: job", () => {
  it("gets a single job by id", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_JOB_STATUS)]);
    const client = createApiClient({ fetch: fetchStub });

    const result = await client.job("job-1");

    expect(result).toEqual(VALID_JOB_STATUS);
    expect(calls[0]?.url).toBe("/api/v1/fs/jobs/job-1");
  });
});

describe("createApiClient: cancelJob", () => {
  it("posts to the job's cancel route", async () => {
    const { fetchStub, calls } = createStubFetch([
      jsonResponse(200, { ...VALID_JOB_STATUS, state: "cancelled" }),
    ]);
    const client = createApiClient({ fetch: fetchStub });

    const result = await client.cancelJob("job-1");

    expect(result).toEqual({ ...VALID_JOB_STATUS, state: "cancelled" });
    expect(calls[0]?.url).toBe("/api/v1/fs/jobs/job-1/cancel");
    expect(calls[0]?.init.method).toBe("POST");
  });
});

describe("createApiClient: about", () => {
  it("gets about and returns AboutResponse", async () => {
    const { fetchStub } = createStubFetch([jsonResponse(200, VALID_ABOUT)]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.about()).toEqual(VALID_ABOUT);
  });
});

const VALID_SEARCH_RESPONSE = {
  query: "readme",
  sections: { folders: [], files: [], content: [] },
  degraded: false,
  unavailable: false,
  tookMs: 12,
};

describe("createApiClient: search", () => {
  it("gets search with just q and returns SearchResponse", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_SEARCH_RESPONSE)]);
    const client = createApiClient({ fetch: fetchStub });

    const result = await client.search("readme");

    expect(result).toEqual(VALID_SEARCH_RESPONSE);
    expect(calls[0]?.url).toBe("/api/v1/search?q=readme");
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("serializes every optional filter", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_SEARCH_RESPONSE)]);
    const client = createApiClient({ fetch: fetchStub });

    await client.search("readme", {
      limit: 10,
      ext: "pdf",
      folder: "/docs",
      after: "2026-01-01",
      before: "2026-02-01",
    });

    expect(calls[0]?.url).toBe(
      "/api/v1/search?q=readme&limit=10&ext=pdf&folder=%2Fdocs&after=2026-01-01&before=2026-02-01",
    );
  });
});

describe("createApiClient: searchStatus", () => {
  it("gets search status and returns SearchStatusResponse", async () => {
    const { fetchStub, calls } = createStubFetch([
      jsonResponse(200, { available: true, semantic: false }),
    ]);
    const client = createApiClient({ fetch: fetchStub });

    const result = await client.searchStatus();

    expect(result).toEqual({ available: true, semantic: false });
    expect(calls[0]?.url).toBe("/api/v1/search/status");
  });
});

describe("createApiClient: thumbUrl", () => {
  it("builds a thumbnail URL with path and size", () => {
    const client = createApiClient({ baseUrl: "https://api.test" });

    expect(client.thumbUrl("/photos/a.jpg", 256)).toBe(
      "https://api.test/api/v1/thumb?path=%2Fphotos%2Fa.jpg&size=256",
    );
  });

  it("builds a 1024 thumbnail URL", () => {
    const client = createApiClient({});

    expect(client.thumbUrl("/photos/a.jpg", 1024)).toBe(
      "/api/v1/thumb?path=%2Fphotos%2Fa.jpg&size=1024",
    );
  });
});

describe("createApiClient: error mapping", () => {
  it("throws ApiClientError with the kind and message from a well-formed ApiError body", async () => {
    const { fetchStub } = createStubFetch([
      jsonResponse(404, {
        error: { kind: "not_found", message: "no such file", requestId: "req-1" },
      }),
    ]);
    const client = createApiClient({ fetch: fetchStub });

    await expect(client.stat("/missing")).rejects.toMatchObject({
      name: "ApiClientError",
      kind: "not_found",
      message: "no such file",
      status: 404,
      requestId: "req-1",
    });
  });

  it("throws an internal ApiClientError when the error body is not well-formed", async () => {
    const { fetchStub } = createStubFetch([new Response("plain text failure", { status: 500 })]);
    const client = createApiClient({ fetch: fetchStub });

    await expect(client.stat("/x")).rejects.toMatchObject({
      kind: "internal",
      status: 500,
    });
  });

  it("throws an internal ApiClientError when the error body is JSON but not ApiError-shaped", async () => {
    const { fetchStub } = createStubFetch([jsonResponse(400, { unexpected: true })]);
    const client = createApiClient({ fetch: fetchStub });

    await expect(client.stat("/x")).rejects.toMatchObject({ kind: "internal", status: 400 });
  });

  it("throws an internal ApiClientError when a 2xx response fails contract validation", async () => {
    const { fetchStub } = createStubFetch([jsonResponse(200, { not: "an entry" })]);
    const client = createApiClient({ fetch: fetchStub });

    const error = await client.stat("/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).kind).toBe("internal");
    expect((error as ApiClientError).details).toHaveProperty("issues");
  });

  it("throws an upstream_unavailable ApiClientError when fetch itself rejects", async () => {
    const fetchStub = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const client = createApiClient({ fetch: fetchStub });

    await expect(client.me()).rejects.toMatchObject({
      kind: "upstream_unavailable",
      status: 0,
      message: "network down",
    });
  });

  it("falls back to a generic message when a network failure is not an Error instance", async () => {
    const fetchStub = vi.fn(async () => {
      throw "boom";
    });
    const client = createApiClient({ fetch: fetchStub });

    await expect(client.me()).rejects.toMatchObject({
      kind: "upstream_unavailable",
      message: "network request failed",
    });
  });
});

/**
 * Regression coverage for a real browser bug: native `fetch` throws
 * `TypeError: Illegal invocation` when called with a `this` other than
 * `window` (or undefined). These stubs mimic that check so a regression
 * where the client calls `ctx.fetchImpl(...)` as a method (binding `this`
 * to the context object) fails loudly in Node too.
 */
function createIllegalInvocationFetch(): (
  this: unknown,
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
) => Promise<Response> {
  return function stubFetch(this: unknown) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }
    return Promise.resolve(jsonResponse(200, VALID_ME));
  };
}

describe("createApiClient: fetch `this`-binding regression", () => {
  it("calls an options.fetch stub without binding `this` to the client context", async () => {
    const client = createApiClient({ fetch: createIllegalInvocationFetch() });

    await expect(client.me()).resolves.toEqual(VALID_ME);
  });

  it("calls the default globalThis.fetch without binding `this` to the client context", async () => {
    vi.stubGlobal("fetch", createIllegalInvocationFetch());
    try {
      const client = createApiClient({});
      await expect(client.me()).resolves.toEqual(VALID_ME);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
