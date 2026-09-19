import type { ActivityReadInput, ActivityReadsRepo, IndexQueries } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import {
  createFakeSftpgoServer,
  createSftpgoClient,
  createSftpgoStorageProvider,
  type FakeSeed,
} from "@fdrive/sftpgo";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityFixture } from "../../test/activity-fixture.js";
import { createApp } from "../app.js";
import { createLoginLimiter, DEFAULT_MAX_FAILURES } from "../auth/login-limiter.js";
import { loadConfig } from "../config.js";
import { extractClientIp } from "../net.js";
import type { SearchService } from "../search/service.js";
import { createResolveTokenPrincipal } from "../tokens/principal.js";
import { generateApiToken, hashApiToken } from "../tokens/token-format.js";
import type { McpToolDeps } from "./handlers.js";
import { createIndexerExtractClient } from "./indexer-client.js";
import { registerMcpRoutes } from "./routes.js";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  SFTPGO_URL: "http://localhost:8080",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
};

/** The single ephemeral-port `@hono/node-server` instance for the harness in the currently running test. */
let currentServer: ServerType | null = null;

const SEED: FakeSeed = {
  users: [{ username: "alice", password: "secret", permissions: { "/": ["*"] } }],
  files: {
    alice: {
      "/hello.txt": "hello world",
      "/dir/nested.txt": "nested contents",
    },
  },
};

function fail(name: string): never {
  throw new Error(`unexpected call to ${name} in this test`);
}

function stubIndexQueries(): IndexQueries {
  return {
    semantic: async () => fail("semantic"),
    fulltext: async () => fail("fulltext"),
    filename: async () => fail("filename"),
    filesByIds: async () => fail("filesByIds"),
    fileByPath: async () => null,
    listFiles: async () => ({ total: 0, files: [] }),
    filesBySha256: async () => fail("filesBySha256"),
    rootIdsByName: async () => ({ sftpgo: 1 }),
    directoriesWithFiles: async () => [],
    stats: async () => ({ filesTracked: 0, byTextStatus: [], chunks: 0, chunksEmbedded: 0 }),
    statsForFileIds: async () => ({ chunks: 0, chunksEmbedded: 0 }),
    fileTextPrefix: async () => "",
    duplicates: async () => [],
    similar: async () => fail("similar"),
    recentFiles: async () => fail("recentFiles"),
    thumbnail: async () => fail("thumbnail"),
    recordMove: async () => undefined,
    recentMoves: async () => [],
    deletedRowSha: async () => null,
    liveRowsBySha: async () => [],
    searchImages: async () => [],
    imageEmbeddingStats: async () => ({ total: 0, model: null }),
    subtreeSize: async () => fail("subtreeSize"),
  };
}

function stubSearchService(): SearchService {
  return {
    async search(input) {
      return {
        query: input.query,
        sections: {
          folders: [],
          files: [
            {
              path: "/hello.txt",
              name: "hello.txt",
              kind: "file",
              ext: ".txt",
              mime: "text/plain",
              size: 11,
              modifiedAt: "2026-01-01T00:00:00.000Z",
              score: 1,
              snippets: [{ text: "hello world", ranges: [] }],
              hasThumbnail: false,
            },
          ],
          content: [],
        },
        degraded: false,
        unavailable: false,
        tookMs: 1,
      };
    },
  };
}

interface Harness {
  readonly app: ReturnType<typeof createApp>;
  readonly port: number;
  readonly token: string;
  readonly toolDeps: McpToolDeps;
  readonly activity: ReturnType<typeof activityFixture>;
  readonly reads: ActivityReadInput[];
  close(): Promise<void>;
}

async function startHarness(writesEnabled: boolean): Promise<Harness> {
  const config = loadConfig(REQUIRED_ENV);
  const fakeSftpgo = createFakeSftpgoServer(SEED);
  const sftpgoClient = createSftpgoClient({
    baseUrl: "http://sftpgo.test",
    fetch: fakeSftpgo.fetch,
  });
  const aliceToken = await sftpgoClient.login({ username: "alice", password: "secret" });
  const storage = createSftpgoStorageProvider({
    client: sftpgoClient,
    withToken: async (fn) => fn(aliceToken.accessToken),
  });

  const repos = createMemoryRepos();
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://sftpgo.test" });
  const account = await repos.accounts.create({ displayName: "Alice" });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });

  const rawToken = generateApiToken();
  await repos.apiTokens.create({
    accountId: account.id,
    identityId: identity.id,
    name: "Claude",
    tokenHash: hashApiToken(rawToken),
    expiresAt: null,
  });

  const resolveToken = createResolveTokenPrincipal({
    apiTokens: repos.apiTokens,
    identities: repos.identities,
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
    storageFactory: async () => storage,
  });

  const indexerFetch = (async (input: unknown) => {
    if (String(input).endsWith("/extract")) {
      return new Response(JSON.stringify({ text: "extracted text", status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch to ${String(input)}`);
  }) as typeof globalThis.fetch;

  const clock = () => new Date("2026-01-01T00:00:00.000Z");
  const activity = activityFixture(clock);
  const reads: ActivityReadInput[] = [];
  const toolDeps: McpToolDeps = {
    activity: activity.service,
    activityReads: {
      record: async (input: ActivityReadInput) => {
        reads.push(input);
        return undefined as never;
      },
    } as unknown as ActivityReadsRepo,
    indexQueries: stubIndexQueries(),
    searchService: stubSearchService(),
    scopeResolver: {
      verifiedIndexScopes: async () => ({
        available: true,
        scopes: [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }],
      }),
    },
    identities: repos.identities,
    publicUrl: async () => "https://fdrive.example.com",
    indexerClient: createIndexerExtractClient({
      baseUrl: "http://indexer.test",
      fetch: indexerFetch,
    }),
    writesEnabled,
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
    trashPath: null,
  };

  const app = createApp({
    config,
    logger: {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
      fatal: () => {},
      trace: () => {},
    } as never,
    version: "1.0.0",
    startedAt: new Date(0),
    connectionStatus: async () => ({
      required: false,
      providers: [{ type: "sftpgo", host: "sftpgo:8080" }],
    }),
  });
  registerMcpRoutes(app, {
    resolveToken,
    limiter: createLoginLimiter({ clock: () => new Date() }),
    clientIp: (c) => extractClientIp(c, config.fdriveTrustedProxyHops),
    toolDeps,
  });

  const port = await new Promise<number>((resolve) => {
    currentServer = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
  });

  return {
    app,
    port,
    token: rawToken,
    toolDeps,
    activity,
    reads,
    async close() {
      const server = currentServer;
      currentServer = null;
      if (server === null) {
        return;
      }
      await new Promise<void>((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      });
    },
  };
}

// `StreamableHTTPClientTransport`'s own `sessionId?: string` field is
// declared without `| undefined`, which conflicts with this project's
// `exactOptionalPropertyTypes` when TypeScript checks it structurally
// against the SDK's own `Transport` interface at the `connect()` call
// site. The cast below is scoped to this SDK typing mismatch only.
async function connectTransport(
  client: Client,
  transport: StreamableHTTPClientTransport,
): Promise<void> {
  await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
}

async function connectBearerClient(port: number, token: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await connectTransport(client, transport);
  return client;
}

async function connectPathTokenClient(port: number, token: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp/t/${token}`),
  );
  await connectTransport(client, transport);
  return client;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected a text content block");
  }
  return first.text;
}

describe("MCP server end to end", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness(false);
  });

  afterEach(async () => {
    await harness.close();
  });

  it("bounds authenticated request bodies before MCP parsing", async () => {
    const headers = {
      authorization: `Bearer ${harness.token}`,
      "content-type": "application/json",
    };
    expect(
      (await harness.app.request("/mcp", { method: "POST", headers, body: "invalid" })).status,
    ).toBe(400);
    expect(
      (
        await harness.app.request("/mcp", {
          method: "POST",
          headers: { ...headers, "content-length": "999999999" },
          body: "x",
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await harness.app.request("/mcp", {
          method: "POST",
          headers,
          body: "x".repeat(32 * 1024 * 1024 + 1),
        })
      ).status,
    ).toBe(413);
  });

  it("initializes and lists every tool", async () => {
    const client = await connectBearerClient(harness.port, harness.token);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "search",
        "find_files",
        "list_directory",
        "read_file_text",
        "file_info",
        "find_duplicates",
        "similar_files",
        "folder_overview",
        "index_stats",
        "capabilities",
        "recent_moves",
      ].sort(),
    );

    await client.close();
  });

  it("calls list_directory against the fake SFTPGo server", async () => {
    const client = await connectBearerClient(harness.port, harness.token);

    const result = await client.callTool({ name: "list_directory", arguments: { path: "/" } });

    const body = JSON.parse(textOf(result as CallToolResult)) as { entries: { name: string }[] };
    expect(body.entries.map((e) => e.name).sort()).toEqual(["dir", "hello.txt"]);
    expect(result.isError).not.toBe(true);

    await client.close();
  });

  it("calls search and returns the stubbed results with fdrive urls", async () => {
    const client = await connectBearerClient(harness.port, harness.token);

    const result = await client.callTool({ name: "search", arguments: { query: "hello" } });

    const body = JSON.parse(textOf(result as CallToolResult)) as {
      results: { url: string }[];
    };
    expect(body.results[0]?.url).toBe("https://fdrive.example.com/view/hello.txt");

    await client.close();
  });

  it("calls read_file_text against the stub indexer fetch", async () => {
    const client = await connectBearerClient(harness.port, harness.token);

    const result = await client.callTool({
      name: "read_file_text",
      arguments: { path: "/hello.txt" },
    });

    const body = JSON.parse(textOf(result as CallToolResult)) as { text: string };
    expect(body.text).toBe("extracted text");

    await client.close();
  });

  it("gates create_folder off by default", async () => {
    const client = await connectBearerClient(harness.port, harness.token);

    const result = await client.callTool({ name: "create_folder", arguments: { path: "/new" } });

    expect(result.isError).toBe(true);
    expect(textOf(result as CallToolResult)).toMatch(/not found/);

    await client.close();
  });

  it("gates move_path off by default", async () => {
    const client = await connectBearerClient(harness.port, harness.token);

    const result = await client.callTool({
      name: "move_path",
      arguments: { src: "/hello.txt", dst: "/moved.txt" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result as CallToolResult)).toMatch(/not found/);

    await client.close();
  });

  it("calls every remaining read tool through the wire without crashing the server", async () => {
    const client = await connectBearerClient(harness.port, harness.token);

    const findFiles = await client.callTool({ name: "find_files", arguments: {} });
    expect(findFiles.isError).not.toBe(true);
    expect(JSON.parse(textOf(findFiles as CallToolResult))).toMatchObject({ total_matches: 0 });

    const fileInfo = await client.callTool({
      name: "file_info",
      arguments: { path: "/hello.txt" },
    });
    expect(fileInfo.isError).toBe(true);

    const duplicates = await client.callTool({ name: "find_duplicates", arguments: {} });
    expect(duplicates.isError).not.toBe(true);
    expect(JSON.parse(textOf(duplicates as CallToolResult))).toMatchObject({ total_groups: 0 });

    const similar = await client.callTool({
      name: "similar_files",
      arguments: { path: "/hello.txt" },
    });
    expect(similar.isError).toBe(true);

    const overview = await client.callTool({ name: "folder_overview", arguments: {} });
    expect(overview.isError).not.toBe(true);
    expect(JSON.parse(textOf(overview as CallToolResult))).toMatchObject({ total_files: 0 });

    const stats = await client.callTool({ name: "index_stats", arguments: {} });
    expect(stats.isError).not.toBe(true);
    expect(JSON.parse(textOf(stats as CallToolResult))).toMatchObject({ files_tracked: 0 });

    const recentMoves = await client.callTool({ name: "recent_moves", arguments: {} });
    expect(recentMoves.isError).not.toBe(true);
    expect(JSON.parse(textOf(recentMoves as CallToolResult))).toEqual({ moves: [] });

    await client.close();
  });

  it("authenticates via the token-in-path URL", async () => {
    const client = await connectPathTokenClient(harness.port, harness.token);

    const { tools } = await client.listTools();

    expect(tools.length).toBeGreaterThan(0);

    await client.close();
  });

  it("returns 401 for a request with no credentials at all", async () => {
    const res = await fetch(`http://127.0.0.1:${harness.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("returns 401 for an invalid bearer token", async () => {
    const res = await fetch(`http://127.0.0.1:${harness.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer fdr_does-not-exist",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("answers 429 with Retry-After once an address has burned its failed-lookup budget", async () => {
    const attempt = async (forwardedFor: string) => {
      const res = await fetch(`http://127.0.0.1:${harness.port}/mcp/t/${generateApiToken()}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-forwarded-for": forwardedFor,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      return { status: res.status, headers: res.headers, body: await res.text() };
    };

    for (let i = 0; i < DEFAULT_MAX_FAILURES; i++) {
      expect((await attempt("198.51.100.7")).status).toBe(401);
    }

    const blocked = await attempt("198.51.100.7");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(blocked.headers.get("cache-control")).toBe("no-store");
    expect(blocked.headers.get("referrer-policy")).toBe("no-referrer");
    expect(JSON.parse(blocked.body)).toEqual({ error: "rate_limited" });

    // A different caller is unaffected, and a live token still works there.
    expect((await attempt("203.0.113.9")).status).toBe(401);
    const valid = await fetch(`http://127.0.0.1:${harness.port}/mcp/t/${harness.token}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-forwarded-for": "203.0.113.9",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "raw-fetch-client", version: "1.0.0" },
        },
      }),
    });
    expect(valid.status).toBe(200);
    await valid.text();
  });

  it("does not spend the budget on a path token that is not token-shaped", async () => {
    for (let i = 0; i < DEFAULT_MAX_FAILURES * 4; i++) {
      const res = await fetch(`http://127.0.0.1:${harness.port}/mcp/t/fdr_x`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
      await res.text();
    }

    const client = await connectPathTokenClient(harness.port, harness.token);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    await client.close();
  });

  it("sets Cache-Control: no-store and Referrer-Policy: no-referrer on a successful MCP response", async () => {
    const res = await fetch(`http://127.0.0.1:${harness.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${harness.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "raw-fetch-client", version: "1.0.0" },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    await res.text();
  });
});

describe("MCP server end to end: writes enabled", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness(true);
  });

  afterEach(async () => {
    await harness.close();
  });

  it("creates a folder through the fake SFTPGo server when writes are enabled", async () => {
    const client = await connectBearerClient(harness.port, harness.token);

    const result = await client.callTool({ name: "create_folder", arguments: { path: "/new" } });

    expect(result.isError).not.toBe(true);
    const body = JSON.parse(textOf(result as CallToolResult)) as { created: string };
    expect(body.created).toBe("/new");

    const listing = await client.callTool({ name: "list_directory", arguments: { path: "/" } });
    const listingBody = JSON.parse(textOf(listing as CallToolResult)) as {
      entries: { name: string }[];
    };
    expect(listingBody.entries.map((e) => e.name)).toContain("new");

    await client.close();
  });

  it("moves a file through the fake SFTPGo server when writes are enabled", async () => {
    const client = await connectBearerClient(harness.port, harness.token);

    const result = await client.callTool({
      name: "move_path",
      arguments: { src: "/hello.txt", dst: "/moved.txt" },
    });

    expect(result.isError).not.toBe(true);
    const body = JSON.parse(textOf(result as CallToolResult)) as { moved: string; to: string };
    expect(body).toEqual({ moved: "/hello.txt", to: "/moved.txt", url: expect.any(String) });

    const listing = await client.callTool({ name: "list_directory", arguments: { path: "/" } });
    const listingBody = JSON.parse(textOf(listing as CallToolResult)) as {
      entries: { name: string }[];
    };
    expect(listingBody.entries.map((e) => e.name)).toContain("moved.txt");

    await client.close();
  });

  it("records MCP writes once and aggregates repeated reads by token", async () => {
    const client = await connectBearerClient(harness.port, harness.token);

    await client.callTool({ name: "create_folder", arguments: { path: "/reports" } });
    await client.callTool({
      name: "move_path",
      arguments: { src: "/hello.txt", dst: "/reports/hello.txt" },
    });
    expect(harness.activity.operations.map((row) => [row.action, row.source])).toEqual([
      ["folder.create", "mcp"],
      ["file.move", "mcp"],
    ]);
    expect(harness.activity.outcomes.every((row) => row.outcome === "success")).toBe(true);

    // Reads are reported to the aggregation journal, never as their own events.
    for (let call = 0; call < 3; call++)
      await client.callTool({
        name: "read_file_text",
        arguments: { path: "/reports/hello.txt" },
      });
    expect(harness.reads).toHaveLength(3);
    expect(new Set(harness.reads.map((read) => read.requestId)).size).toBe(3);
    expect(harness.reads[0]).toMatchObject({
      action: "file.read",
      source: "mcp",
      evidence: "server_confirmed",
      path: "/reports/hello.txt",
    });
    // The token identifies the reader across calls, and never appears in a row.
    expect(new Set(harness.reads.map((read) => read.contextHash)).size).toBe(1);
    expect(JSON.stringify(harness.reads)).not.toContain(harness.token);
    expect(harness.activity.operations.map((row) => row.action)).not.toContain("file.read");

    // Listing and searching are automatic traffic, so they stay out of history.
    await client.callTool({ name: "list_directory", arguments: { path: "/" } });
    await client.callTool({ name: "search", arguments: { query: "hello" } });
    expect(harness.activity.operations).toHaveLength(2);
    expect(harness.reads).toHaveLength(3);

    await client.close();
  });
});
