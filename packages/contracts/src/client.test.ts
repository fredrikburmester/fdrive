import { describe, expect, it, vi } from "vitest";
import { ApiClientError, buildRequestUrl, createApiClient, toQueryString } from "./client";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("feature client", () => {
  it("reads and updates versioned feature settings", async () => {
    const values = {
      thumbnails: false,
      textSearch: false,
      searchOcr: false,
      semanticSearch: false,
      imageSearch: false,
      pdfOcr: false,
    };
    const response = {
      configuration: { version: 1, revision: 0, values, walkthroughComplete: false },
      source: "default",
      statuses: [],
      roots: [],
    };
    const fetchMock = vi.fn(async () => Response.json(response));
    const client = createApiClient({ fetch: fetchMock });
    expect(await client.systemFeatures()).toEqual(response);
    expect(
      await client.systemUpdateFeatures({ revision: 0, values, walkthroughComplete: false }),
    ).toEqual(response);
    expect(fetchMock.mock.calls).toHaveLength(2);
  });
});

describe("Public URL settings client", () => {
  it("reads and updates the server address", async () => {
    const response = { revision: 1, url: "https://drive.example" };
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(response));
    const client = createApiClient({ fetch: fetchMock });
    expect(await client.systemPublicUrl()).toEqual(response);
    expect(await client.systemUpdatePublicUrl(response)).toEqual(response);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "PUT"]);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/v1/system/public-url",
      "/api/v1/system/public-url",
    ]);
  });
});

describe("Office settings client", () => {
  it("reads and updates owner-controlled Office settings", async () => {
    const response = {
      configuration: {
        revision: 0,
        enabled: false,
        editingEnabled: false,
        editingProviderId: null,
        editorUsernames: [],
      },
      product: "onlyoffice" as const,
      status: "off" as const,
      activeProviderId: "123e4567-e89b-42d3-a456-426614174000",
    };
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(response));
    const client = createApiClient({ fetch: fetchMock });
    expect(await client.systemOffice()).toEqual(response);
    expect(await client.systemUpdateOffice(response.configuration)).toEqual(response);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "PUT"]);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/v1/system/office",
      "/api/v1/system/office",
    ]);
  });
});

describe("Trash settings client", () => {
  it("reads and updates provider-bound settings", async () => {
    const settings = {
      providerId: "123e4567-e89b-42d3-a456-426614174000",
      revision: 0,
      enabled: false,
      path: "/.trash",
      retentionHours: null,
      rulesConfirmed: false,
      strategy: "native",
    } as const;
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(settings));
    const client = createApiClient({ fetch: fetchMock });

    expect(await client.systemTrash()).toEqual(settings);
    expect(await client.systemUpdateTrash(settings)).toEqual(settings);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "PUT"]);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/v1/system/trash",
      "/api/v1/system/trash",
    ]);
  });
});
const AT = "2026-01-01T00:00:00.000Z";

const VALID_ME = {
  account: { id: VALID_UUID, displayName: "Alice" },
  identities: [
    {
      id: VALID_UUID,
      username: "alice",
      providerId: VALID_UUID,
      providerType: "sftpgo",
      providerLabel: "Home",
      capabilities: {
        zip: true,
        setModifiedAt: true,
        atomicMove: true,
        trash: false,
        shares: true,
        office: true,
        index: true,
        scopeMapping: true,
      },
    },
  ],
  activeIdentityId: VALID_UUID,
  isAdmin: false,
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
  builtOn: [{ name: "SFTPGo", sourceUrl: "https://github.com/drakkan/sftpgo" }],
  providers: [{ type: "sftpgo", label: "localhost:8080" }],
  setupRequired: false,
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

    const result = await client.login({ credential: { username: "alice", password: "hunter2" } });

    expect(result).toEqual(VALID_ME);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.test/api/v1/auth/login");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.credentials).toBe("include");
    expect(headerValue(calls[0]?.init ?? {}, "x-requested-with")).toBe("fdrive");
    expect(headerValue(calls[0]?.init ?? {}, "content-type")).toBe("application/json");
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({ credential: { username: "alice", password: "hunter2" } }),
    );
  });

  it("sends the identity header when configured", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ME)]);
    const client = createApiClient({ fetch: fetchStub, identityId: "identity-1" });

    await client.login({ credential: { username: "alice", password: "hunter2" } });

    expect(headerValue(calls[0]?.init ?? {}, "x-identity-id")).toBe("identity-1");
  });

  it("does not send the identity header when not configured", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ME)]);
    const client = createApiClient({ fetch: fetchStub });

    await client.login({ credential: { username: "alice", password: "hunter2" } });

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

describe("createApiClient: archiveEntries", () => {
  it("gets fs/archive-entries with a path query", async () => {
    const payload = {
      format: "zip",
      entries: [{ path: "dir/file.txt", kind: "file", size: 1, modifiedAt: null }],
      truncated: false,
    };
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, payload)]);
    const client = createApiClient({ fetch: fetchStub });

    const result = await client.archiveEntries("/a.zip");

    expect(result).toEqual(payload);
    expect(calls[0]?.url).toBe("/api/v1/fs/archive-entries?path=%2Fa.zip");
  });
});

describe("createApiClient: folderSize", () => {
  it("gets fs/folder-size with a path query", async () => {
    const payload = { path: "/photos", bytes: 1024, files: 3, indexed: true };
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, payload)]);
    const client = createApiClient({ fetch: fetchStub });

    const result = await client.folderSize("/photos");

    expect(result).toEqual(payload);
    expect(calls[0]?.url).toBe("/api/v1/fs/folder-size?path=%2Fphotos");
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
      jsonResponse(200, { available: true, semantic: false, images: false }),
    ]);
    const client = createApiClient({ fetch: fetchStub });

    const result = await client.searchStatus();

    expect(result).toEqual({ available: true, semantic: false, images: false });
    expect(calls[0]?.url).toBe("/api/v1/search/status");
  });
});

const VALID_IMAGE_SEARCH_RESPONSE = {
  query: "cat",
  hits: [],
  unavailable: false,
  tookMs: 9,
};

describe("createApiClient: searchImages", () => {
  it("gets search/images with just q and returns ImageSearchResponse", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_IMAGE_SEARCH_RESPONSE)]);
    const client = createApiClient({ fetch: fetchStub });

    const result = await client.searchImages("cat");

    expect(result).toEqual(VALID_IMAGE_SEARCH_RESPONSE);
    expect(calls[0]?.url).toBe("/api/v1/search/images?q=cat");
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("serializes an optional limit", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_IMAGE_SEARCH_RESPONSE)]);
    const client = createApiClient({ fetch: fetchStub });

    await client.searchImages("cat", { limit: 5 });

    expect(calls[0]?.url).toBe("/api/v1/search/images?q=cat&limit=5");
  });
});

describe("createApiClient: shareThumbUrl", () => {
  it("builds a public share thumbnail URL with path and size", () => {
    const client = createApiClient({ baseUrl: "https://api.test" });

    expect(client.shareThumbUrl("share-1", "/photo.jpg", 256)).toBe(
      "https://api.test/api/v1/public/shares/share-1/thumb?path=%2Fphoto.jpg&size=256",
    );
  });

  it("builds a 1024 thumbnail URL for the share root", () => {
    const client = createApiClient({});

    expect(client.shareThumbUrl("share-1", "/", 1024)).toBe(
      "/api/v1/public/shares/share-1/thumb?path=%2F&size=1024",
    );
  });

  it("encodes a path with spaces", () => {
    const client = createApiClient({ baseUrl: "https://api.test" });

    expect(client.shareThumbUrl("share-1", "/my photo.jpg", 256)).toBe(
      "https://api.test/api/v1/public/shares/share-1/thumb?path=%2Fmy+photo.jpg&size=256",
    );
  });

  it("encodes a non-ASCII path", () => {
    const client = createApiClient({ baseUrl: "https://api.test" });

    expect(client.shareThumbUrl("share-1", "/café/日本語.jpg", 256)).toBe(
      "https://api.test/api/v1/public/shares/share-1/thumb?path=%2Fcaf%C3%A9%2F%E6%97%A5%E6%9C%AC%E8%AA%9E.jpg&size=256",
    );
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

describe("createApiClient: setup", () => {
  it("gets setup/status", async () => {
    const status = { required: true, hasEnvUrl: false };
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, status)]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.setupStatus()).toEqual(status);
    expect(calls[0]?.url).toBe("/api/v1/setup/status");
  });

  it("posts setup/test with the setup token header and baseUrl body", async () => {
    const result = { ok: true, detail: "reachable" };
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, result)]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.setupTest("tok-1", "http://sftpgo:8080")).toEqual(result);
    expect(calls[0]?.url).toBe("/api/v1/setup/test");
    expect(headerValue(calls[0]?.init ?? {}, "x-setup-token")).toBe("tok-1");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ baseUrl: "http://sftpgo:8080" });
  });

  it("posts setup/complete with the setup token header and returns MeResponse", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_ME)]);
    const client = createApiClient({ fetch: fetchStub });
    const req = {
      baseUrl: "http://sftpgo:8080",
      homeTemplate: "sftpgo:/{username}",
      username: "alice",
      password: "hunter2",
    };

    expect(await client.setupComplete("tok-1", req)).toEqual(VALID_ME);
    expect(calls[0]?.url).toBe("/api/v1/setup/complete");
    expect(headerValue(calls[0]?.init ?? {}, "x-setup-token")).toBe("tok-1");
  });
});

describe("createApiClient: providers", () => {
  const FIELD = { name: "username", label: "Username", kind: "text", required: true };
  const PROVIDER = {
    id: VALID_UUID,
    type: "sftpgo",
    label: "Home",
    baseUrl: "http://sftpgo:8080",
    config: { homeTemplate: "sftpgo:/{username}" },
    enabled: true,
    managedByEnv: false,
    identityCount: 1,
    reachable: true,
    checkedAt: AT,
    createdAt: AT,
  };

  it("gets the public provider list", async () => {
    const body = {
      providers: [{ id: VALID_UUID, type: "sftpgo", label: "Home", credentialFields: [FIELD] }],
    };
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, body)]);
    const client = createApiClient({ fetch: fetchStub });
    expect(await client.providers()).toEqual(body);
    expect(calls[0]?.url).toBe("/api/v1/providers");
  });

  it("gets, creates, updates and deletes admin providers", async () => {
    const list = { providers: [PROVIDER], types: [] };
    const { fetchStub, calls } = createStubFetch([
      jsonResponse(200, list),
      jsonResponse(200, PROVIDER),
      jsonResponse(200, PROVIDER),
      jsonResponse(200, { ok: true }),
    ]);
    const client = createApiClient({ fetch: fetchStub });
    expect(await client.adminProviders()).toEqual(list);
    expect(
      await client.adminCreateProvider({ type: "sftpgo", label: "Home", baseUrl: "http://a" }),
    ).toEqual(PROVIDER);
    expect(await client.adminUpdateProvider(VALID_UUID, { enabled: false })).toEqual(PROVIDER);
    expect(await client.adminDeleteProvider(VALID_UUID)).toEqual({ ok: true });
    expect(calls.map((call) => `${call.init.method ?? "GET"} ${call.url}`)).toEqual([
      "GET /api/v1/admin/providers",
      "POST /api/v1/admin/providers",
      `PATCH /api/v1/admin/providers/${VALID_UUID}`,
      `DELETE /api/v1/admin/providers/${VALID_UUID}`,
    ]);
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ enabled: false });
  });

  it("probes a saved provider by id and an unsaved candidate by body", async () => {
    const result = { ok: true, detail: "reachable" };
    const { fetchStub, calls } = createStubFetch([
      jsonResponse(200, result),
      jsonResponse(200, result),
    ]);
    const client = createApiClient({ fetch: fetchStub });
    expect(await client.adminTestProvider(VALID_UUID)).toEqual(result);
    expect(
      await client.adminTestProvider({ type: "sftpgo", baseUrl: "http://other:8080" }),
    ).toEqual(result);
    expect(calls[0]?.url).toBe(`/api/v1/admin/providers/${VALID_UUID}/test`);
    expect(calls[0]?.init.body).toBeUndefined();
    expect(calls[1]?.url).toBe("/api/v1/admin/providers/test");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      type: "sftpgo",
      baseUrl: "http://other:8080",
    });
  });
});

describe("createApiClient: system", () => {
  const INDEXER_SETTINGS = {
    values: {
      scanIntervalSeconds: 900,
      workers: 4,
      textExcludeGlobs: [],
      ocrImageGlobs: [],
      tesseractLangs: "swe+eng",
    },
    sources: {
      scanIntervalSeconds: "default",
      workers: "default",
      textExcludeGlobs: "default",
      ocrImageGlobs: "default",
      tesseractLangs: "default",
    },
  };

  const VALID_INDEXER = {
    configured: true,
    reachable: true,
    health: {
      ok: true,
      roots: ["sftpgo"],
      watcher: { sftpgo: true },
      embedOk: true,
      schemaVersion: 1,
    },
    stats: { roots: [], thumbnails: 0, queueDepth: 0, errorsSample: [] },
    settings: INDEXER_SETTINGS,
  };

  const OCR_SETTINGS = {
    values: { hour: 3, langs: "swe+eng", excludeGlobs: [], maxMb: 200, keepOriginals: false },
    sources: {
      hour: "default",
      langs: "default",
      excludeGlobs: "default",
      maxMb: "default",
      keepOriginals: "default",
    },
  };

  const VALID_OCR = { configured: false, reachable: false, settings: OCR_SETTINGS };

  it("gets and validates system activity", async () => {
    const activity = { observedAt: "2026-09-12T12:00:00Z", items: [] };
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, activity)]);
    const client = createApiClient({ fetch: fetchStub });
    expect(await client.systemActivity()).toEqual(activity);
    expect(calls[0]?.url).toBe("/api/v1/system/activity");
  });

  it("gets system/indexer", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_INDEXER)]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.systemIndexer()).toEqual(VALID_INDEXER);
    expect(calls[0]?.url).toBe("/api/v1/system/indexer");
  });

  it("puts system/indexer/settings with the settings body", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, INDEXER_SETTINGS)]);
    const client = createApiClient({ fetch: fetchStub });
    const patch = {
      scanIntervalSeconds: 60,
      workers: 2,
      textExcludeGlobs: ["**/tmp/**"],
      ocrImageGlobs: [],
      tesseractLangs: "eng",
    };

    expect(await client.systemUpdateIndexerSettings(patch)).toEqual(INDEXER_SETTINGS);
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.url).toBe("/api/v1/system/indexer/settings");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(patch);
  });

  it("posts system/indexer/reindex with the root and optional path", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { marked: 3 })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.systemReindex({ root: "sftpgo", path: "folder" })).toEqual({ marked: 3 });
    expect(calls[0]?.url).toBe("/api/v1/system/indexer/reindex");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ root: "sftpgo", path: "folder" });
  });

  it("posts system/indexer/reindex with thumbnails: true", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { marked: 3 })]);
    const client = createApiClient({ fetch: fetchStub });

    await client.systemReindex({ root: "sftpgo", thumbnails: true });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ root: "sftpgo", thumbnails: true });
  });

  it("posts system/indexer/thumbnails/rebuild with an empty body by default", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { started: true, total: 10 })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.systemRebuildIndexerThumbnails()).toEqual({ started: true, total: 10 });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({});
  });

  it("posts system/indexer/thumbnails/rebuild scoped to a root, path, and force", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { started: true, total: 4 })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(
      await client.systemRebuildIndexerThumbnails({ root: "sftpgo", path: "folder", force: true }),
    ).toEqual({ started: true, total: 4 });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      root: "sftpgo",
      path: "folder",
      force: true,
    });
  });

  it("gets system/search", async () => {
    const result = {
      configured: true,
      semantic: { configured: true, healthy: true },
      roots: ["sftpgo"],
      index: { files: 1, withText: 1, chunks: 1, embedded: 1 },
    };
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, result)]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.systemSearch()).toEqual(result);
    expect(calls[0]?.url).toBe("/api/v1/system/search");
  });

  it("posts system/search/reembed", async () => {
    const result = { marked: 7, roots: ["sftpgo"] };
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, result)]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.systemReembed()).toEqual(result);
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("gets system/image-search", async () => {
    const result = {
      configured: true,
      healthy: true,
      model: "google/siglip2-large-patch16-256",
      dim: 1024,
      embedded: 3,
      embeddedModel: "google/siglip2-large-patch16-256",
    };
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, result)]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.systemImageSearch()).toEqual(result);
    expect(calls[0]?.url).toBe("/api/v1/system/image-search");
  });

  it("posts system/image-search/rebuild with an empty body by default", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { started: true, total: 5 })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.systemImageSearchRebuild()).toEqual({ started: true, total: 5 });
    expect(calls[0]?.url).toBe("/api/v1/system/image-search/rebuild");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({});
  });

  it("posts system/image-search/rebuild with force", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { started: true, total: 2 })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.systemImageSearchRebuild({ force: true })).toEqual({
      started: true,
      total: 2,
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ force: true });
  });

  it("posts system/image-search/clear", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { started: true })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.systemImageSearchClear()).toEqual({ started: true });
    expect(calls[0]?.url).toBe("/api/v1/system/image-search/clear");
  });

  it("gets system/ocr", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_OCR)]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.systemOcr()).toEqual(VALID_OCR);
    expect(calls[0]?.url).toBe("/api/v1/system/ocr");
  });

  it("puts system/ocr/settings with the settings body", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, OCR_SETTINGS)]);
    const client = createApiClient({ fetch: fetchStub });
    const patch = {
      hour: 4,
      langs: "eng",
      excludeGlobs: [],
      maxMb: 100,
      keepOriginals: true,
    };

    expect(await client.systemUpdateOcrSettings(patch)).toEqual(OCR_SETTINGS);
    expect(calls[0]?.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(patch);
  });

  it("posts system/ocr/run", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { started: true })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.systemRunOcr()).toEqual({ started: true });
    expect(calls[0]?.url).toBe("/api/v1/system/ocr/run");
  });

  it("gets system/thumbnails", async () => {
    const result = { configured: true, count: 4, bytes: 2048 };
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, result)]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.systemThumbnails()).toEqual(result);
    expect(calls[0]?.url).toBe("/api/v1/system/thumbnails");
  });

  it("posts system/thumbnails/rebuild", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { started: true, total: 12 })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.systemRebuildThumbnails()).toEqual({ started: true, total: 12 });
    expect(calls[0]?.url).toBe("/api/v1/system/thumbnails/rebuild");
  });
});

describe("createApiClient: account tokens", () => {
  const VALID_TOKEN_SUMMARY = {
    id: VALID_UUID,
    name: "Claude",
    identityId: VALID_UUID,
    createdAt: AT,
    lastUsedAt: null,
    expiresAt: null,
  };

  it("gets account/tokens and unwraps items", async () => {
    const { fetchStub, calls } = createStubFetch([
      jsonResponse(200, { items: [VALID_TOKEN_SUMMARY] }),
    ]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.listApiTokens()).toEqual({ items: [VALID_TOKEN_SUMMARY] });
    expect(calls[0]?.url).toBe("/api/v1/account/tokens");
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("posts account/tokens with the create request body", async () => {
    const result = { token: "fdr_abc123", item: VALID_TOKEN_SUMMARY };
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, result)]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.createApiToken({ name: "Claude", expiresInDays: 90 })).toEqual(result);
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ name: "Claude", expiresInDays: 90 });
  });

  it("deletes an api token by id", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { ok: true })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.revokeApiToken("token-1")).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("/api/v1/account/tokens/token-1");
    expect(calls[0]?.init.method).toBe("DELETE");
  });
});

describe("createApiClient: tags", () => {
  const VALID_TAG = { id: VALID_UUID, name: "Work", color: "#ff0000" };

  it("gets tags and unwraps the list", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { tags: [VALID_TAG] })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.listTags()).toEqual({ tags: [VALID_TAG] });
    expect(calls[0]?.url).toBe("/api/v1/tags");
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("posts tags with the create request body", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, VALID_TAG)]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.createTag({ name: "Work", color: "#ff0000" })).toEqual(VALID_TAG);
    expect(calls[0]?.url).toBe("/api/v1/tags");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ name: "Work", color: "#ff0000" }));
  });

  it("patches a tag by id", async () => {
    const updated = { ...VALID_TAG, name: "Job" };
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, updated)]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.updateTag("tag-1", { name: "Job" })).toEqual(updated);
    expect(calls[0]?.url).toBe("/api/v1/tags/tag-1");
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ name: "Job" }));
  });

  it("deletes a tag by id", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { ok: true })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.deleteTag("tag-1")).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("/api/v1/tags/tag-1");
    expect(calls[0]?.init.method).toBe("DELETE");
  });

  it("gets the paths tagged with a given tag", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { paths: ["/a.txt"] })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.tagFiles("tag-1")).toEqual({ paths: ["/a.txt"] });
    expect(calls[0]?.url).toBe("/api/v1/tags/tag-1/files");
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("puts fs/tags to replace a path's tags", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { ok: true })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.setFileTags({ path: "/a.txt", tagIds: ["tag-1"] })).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("/api/v1/fs/tags");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ path: "/a.txt", tagIds: ["tag-1"] }));
  });
});

describe("createApiClient: favorites", () => {
  const VALID_FAVORITE = { path: "/a.txt", kind: "file", addedAt: AT };

  it("gets favorites and unwraps items", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { items: [VALID_FAVORITE] })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.listFavorites()).toEqual({ items: [VALID_FAVORITE] });
    expect(calls[0]?.url).toBe("/api/v1/favorites");
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("posts favorites with the path body", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { ok: true })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.addFavorite({ path: "/a.txt" })).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("/api/v1/favorites");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ path: "/a.txt" }));
  });

  it("deletes favorites with the path body", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { ok: true })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.removeFavorite({ path: "/a.txt" })).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("/api/v1/favorites");
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ path: "/a.txt" }));
  });
});

describe("createApiClient: folder views", () => {
  it("gets, saves, removes, and resets pins", async () => {
    const { fetchStub, calls } = createStubFetch([
      jsonResponse(200, { view: { path: "/photos", mode: "grid", sort: null } }),
      jsonResponse(200, { ok: true }),
      jsonResponse(200, { ok: true }),
      jsonResponse(200, { ok: true }),
    ]);
    const client = createApiClient({ fetch: fetchStub });

    await expect(client.getFolderView("/photos")).resolves.toEqual({
      view: { path: "/photos", mode: "grid", sort: null },
    });
    await client.setFolderView({ path: "/photos", mode: "grid" });
    await client.removeFolderView({ path: "/photos" });
    await client.resetFolderViews();

    expect(calls.map((call) => [call.url, call.init.method, call.init.body])).toEqual([
      ["/api/v1/folder-views?path=%2Fphotos", "GET", undefined],
      ["/api/v1/folder-views", "PUT", JSON.stringify({ path: "/photos", mode: "grid" })],
      ["/api/v1/folder-views", "DELETE", JSON.stringify({ path: "/photos" })],
      ["/api/v1/folder-views/all", "DELETE", undefined],
    ]);
  });
});

describe("createApiClient: identityScope", () => {
  const NONADMIN_STATUS = {
    status: "available",
    reason: "ok",
    usesOverride: false,
    virtualPrefixes: ["/"],
    unmappedMounts: [{ virtualPath: "/shared", kind: "dir" }],
    unverifiedPrefixes: [],
    unindexedPrefixes: ["/archive"],
    warning: "warning text",
    isAdmin: false,
  };

  it("gets an identity's scope status", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, NONADMIN_STATUS)]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.identityScope(VALID_UUID)).toEqual(NONADMIN_STATUS);
    expect(calls[0]?.url).toBe(`/api/v1/account/identities/${VALID_UUID}/scope`);
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("puts a scope override with the scopes body", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, NONADMIN_STATUS)]);
    const client = createApiClient({ fetch: fetchStub });
    const body = {
      scopes: [{ rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" }],
      unindexedPrefixes: ["/archive"],
    };

    expect(await client.setIdentityScope(VALID_UUID, body)).toEqual(NONADMIN_STATUS);
    expect(calls[0]?.url).toBe(`/api/v1/account/identities/${VALID_UUID}/scope`);
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.body).toBe(JSON.stringify(body));
  });
});

describe("createApiClient: folder mappings and suggestions", () => {
  const MAPPINGS = {
    mappings: [{ virtualPath: "/shared", rootName: "sftpgo", fsPrefix: "/_folders/shared" }],
  };

  it("gets and puts the folder-level mappings", async () => {
    const { fetchStub, calls } = createStubFetch([
      jsonResponse(200, MAPPINGS),
      jsonResponse(200, MAPPINGS),
    ]);
    const client = createApiClient({ fetch: fetchStub });
    expect(await client.mountMappings()).toEqual(MAPPINGS);
    expect(calls[0]?.url).toBe("/api/v1/system/mount-mappings");
    expect(await client.setMountMappings(MAPPINGS)).toEqual(MAPPINGS);
    expect(calls[1]?.init.method).toBe("PUT");
    expect(calls[1]?.init.body).toBe(JSON.stringify(MAPPINGS));
  });

  it("gets an identity's mapping suggestions", async () => {
    const body = { mounts: [{ virtualPath: "/shared", suggestions: [] }] };
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, body)]);
    const client = createApiClient({ fetch: fetchStub });
    expect(await client.identityScopeSuggestions(VALID_UUID)).toEqual(body);
    expect(calls[0]?.url).toBe(`/api/v1/account/identities/${VALID_UUID}/scope/suggestions`);
  });
});

describe("createApiClient: recents", () => {
  const VALID_RECENT = { path: "/a.txt", openedAt: AT };

  it("gets recents and unwraps items", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { items: [VALID_RECENT] })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.listRecents()).toEqual({ items: [VALID_RECENT] });
    expect(calls[0]?.url).toBe("/api/v1/recents");
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("posts recents/touch with the path body", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { ok: true })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.touchRecent({ path: "/a.txt" })).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("/api/v1/recents/touch");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ path: "/a.txt" }));
  });
});

describe("createApiClient: trash", () => {
  const VALID_TRASH_ENTRY = {
    id: "docs/a.txt/1788761221798866471",
    originalPath: "/docs/a.txt",
    name: "a.txt",
    size: 7,
    deletedAt: AT,
  };

  it("gets trash/status", async () => {
    const { fetchStub, calls } = createStubFetch([
      jsonResponse(200, { available: true, path: "/.trash", retentionHours: null }),
    ]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.trashStatus()).toEqual({
      available: true,
      path: "/.trash",
      retentionHours: null,
    });
    expect(calls[0]?.url).toBe("/api/v1/trash/status");
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("gets trash and returns entries and truncated", async () => {
    const { fetchStub, calls } = createStubFetch([
      jsonResponse(200, { entries: [VALID_TRASH_ENTRY], truncated: false }),
    ]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.trashList()).toEqual({ entries: [VALID_TRASH_ENTRY], truncated: false });
    expect(calls[0]?.url).toBe("/api/v1/trash");
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("posts trash/restore with the request body", async () => {
    const VALID_ENTRY_LOCAL = {
      name: "a.txt",
      path: "/docs/a.txt",
      kind: "file",
      size: 7,
      modifiedAt: AT,
      ext: ".txt",
      mime: null,
    };
    const { fetchStub, calls } = createStubFetch([
      jsonResponse(200, { restored: [VALID_ENTRY_LOCAL] }),
    ]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.trashRestore({ ids: ["docs/a.txt/1"] })).toEqual({
      restored: [VALID_ENTRY_LOCAL],
    });
    expect(calls[0]?.url).toBe("/api/v1/trash/restore");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ ids: ["docs/a.txt/1"] }));
  });

  it("posts trash/purge with the request body", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { ok: true })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.trashPurge({ ids: ["docs/a.txt/1"] })).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("/api/v1/trash/purge");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ ids: ["docs/a.txt/1"] }));
  });

  it("posts trash/empty with no body", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(200, { ok: true })]);
    const client = createApiClient({ fetch: fetchStub });

    expect(await client.trashEmpty()).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("/api/v1/trash/empty");
    expect(calls[0]?.init.method).toBe("POST");
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

describe("createApiClient: clear jobs", () => {
  it.each([undefined, { root: "sftpgo" }, { root: "sftpgo", path: "/a_%/file.pdf" }])(
    "posts index clear scope %j",
    async (scope) => {
      const { fetchStub, calls } = createStubFetch([jsonResponse(202, { started: true })]);
      const client = createApiClient({ fetch: fetchStub });
      expect(await client.systemClearIndex(scope)).toEqual({ started: true });
      expect(calls[0]?.url).toBe("/api/v1/system/indexer/clear");
      expect(calls[0]?.init.method).toBe("POST");
      expect(JSON.parse(String(calls[0]?.init.body))).toEqual(scope ?? {});
    },
  );

  it("posts global thumbnail clear", async () => {
    const { fetchStub, calls } = createStubFetch([jsonResponse(202, { started: true })]);
    const client = createApiClient({ fetch: fetchStub });
    expect(await client.systemClearThumbnails()).toEqual({ started: true });
    expect(calls[0]?.url).toBe("/api/v1/system/thumbnails/clear");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({});
  });

  it.each(["systemClearIndex", "systemClearThumbnails"] as const)(
    "preserves conflicts from %s",
    async (method) => {
      const { fetchStub } = createStubFetch([
        jsonResponse(409, { kind: "conflict", message: "already running" }),
      ]);
      const client = createApiClient({ fetch: fetchStub });
      await expect(client[method]()).rejects.toMatchObject({ status: 409 });
    },
  );
});

describe("office client", () => {
  it("uses pinned routes, request payloads, CSRF and identity headers", async () => {
    const status = {
      available: true,
      product: "onlyoffice",
      extensions: { view: ["docx"], edit: ["docx"], convert: [] },
    };
    const opened = {
      fileId: VALID_UUID,
      identityId: VALID_UUID,
      path: "/a.docx",
      mode: "edit",
      actionUrl: "https://office/edit",
      editorOrigin: "https://office",
      formFields: { access_token: "test" },
      expiresAt: AT,
    };
    const created = { identityId: VALID_UUID, path: "/a.docx" };
    const { fetchStub, calls } = createStubFetch([
      jsonResponse(200, status),
      jsonResponse(200, opened),
      jsonResponse(201, created),
    ]);
    const client = createApiClient({ fetch: fetchStub, identityId: VALID_UUID });
    expect(await client.officeStatus()).toEqual(status);
    expect(await client.officeOpen({ path: "/a.docx", mode: "edit" })).toEqual(opened);
    expect(await client.officeCreateDocument({ parent: "/", name: "a.docx" })).toEqual(created);
    expect(calls.map((c) => c.url)).toEqual([
      "/api/v1/office",
      "/api/v1/office/open",
      "/api/v1/office/documents",
    ]);
    expect(calls[1]?.init.body).toBe(JSON.stringify({ path: "/a.docx", mode: "edit" }));
    for (const call of calls.slice(1)) {
      expect(headerValue(call.init, "x-requested-with")).toBe("fdrive");
      expect(headerValue(call.init, "x-identity-id")).toBe(VALID_UUID);
    }
  });
});

it("includes scoped identity in native download links without losing inline/path", () => {
  const client = createApiClient({ identityId: VALID_UUID });
  const url = new URL(client.downloadUrl("/å.docx", { inline: true }), "https://app");
  expect(url.searchParams.get("identity")).toBe(VALID_UUID);
  expect(url.searchParams.get("path")).toBe("/å.docx");
  expect(url.searchParams.get("inline")).toBe("1");
});

it("calls account identity and cross-identity view routes with typed responses", async () => {
  const favorites = { items: [], unavailableIdentityIds: [] };
  const search = {
    query: "a",
    sections: { folders: [], files: [], content: [] },
    degraded: false,
    unavailable: false,
    tookMs: 0,
    unavailableIdentityIds: [],
  };
  const { fetchStub, calls } = createStubFetch([
    jsonResponse(200, VALID_ME),
    jsonResponse(200, VALID_ME),
    jsonResponse(200, VALID_ME),
    jsonResponse(200, favorites),
    jsonResponse(200, search),
    jsonResponse(200, search),
  ]);
  const client = createApiClient({ fetch: fetchStub });
  expect(
    await client.linkIdentity({
      credential: { username: "alice", password: "secret", otp: "123456" },
      currentCredential: { password: "mine" },
    }),
  ).toEqual(VALID_ME);
  expect(
    await client.unlinkIdentity(VALID_UUID, { currentCredential: { password: "mine" } }),
  ).toEqual(VALID_ME);
  expect(await client.switchIdentity(VALID_UUID)).toEqual(VALID_ME);
  expect(await client.accountFavorites()).toEqual(favorites);
  expect(await client.accountSearch("a")).toEqual(search);
  expect(
    await client.accountSearch("a", {
      limit: 5,
      ext: "txt",
      folder: "/docs",
      after: "2026-01-01",
      before: "2026-09-01",
    }),
  ).toEqual(search);
  expect(calls.slice(0, 5).map((call) => call.url)).toEqual([
    "/api/v1/account/identities",
    `/api/v1/account/identities/${VALID_UUID}`,
    "/api/v1/account/active-identity",
    "/api/v1/account/favorites",
    "/api/v1/account/search?q=a",
  ]);
  expect(calls[0]?.init.body).toBe(
    JSON.stringify({
      credential: { username: "alice", password: "secret", otp: "123456" },
      currentCredential: { password: "mine" },
    }),
  );
  expect(calls[1]?.init.method).toBe("DELETE");
  expect(calls[2]?.init.body).toBe(JSON.stringify({ identityId: VALID_UUID }));
  expect(headerValue(calls[0]?.init ?? {}, "x-requested-with")).toBe("fdrive");
  expect(calls[5]?.url).toContain("limit=5");
});

describe("system logs client", () => {
  it("requests a subsystem's log page and omits unset query parameters", async () => {
    const response = {
      subsystem: "indexer",
      entries: [
        {
          id: "api:1",
          at: "2026-01-01T12:00:00Z",
          level: "info",
          message: "Reindex requested",
          source: "api",
        },
      ],
    };
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(response));
    const client = createApiClient({ fetch: fetchMock });

    expect(await client.systemLogs("indexer")).toEqual(response);
    expect(
      await client.systemLogs("ocr", { limit: 50, level: "error", before: "2026-01-01T12:00:00Z" }),
    ).toEqual(response);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/v1/system/indexer/logs",
      "/api/v1/system/ocr/logs?limit=50&level=error&before=2026-01-01T12%3A00%3A00Z",
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET"]);
  });
});

it("passes stat cancellation through to fetch", async () => {
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json(VALID_ENTRY));
  const client = createApiClient({ fetch: fetchMock });
  const controller = new AbortController();
  await client.stat("/file.txt", controller.signal);
  expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
});
