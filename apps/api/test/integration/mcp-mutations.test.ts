import { createRecycleFolderTrash, withMoveToTrash } from "@fdrive/core";
import { createSftpgoClient, createSftpgoStorageProvider } from "@fdrive/sftpgo";
import { startSftpgo } from "@fdrive/testkit";
import { createWebdavClient, createWebdavStorageProvider } from "@fdrive/webdav";
import { type ServerType, serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AppHono } from "../../src/app.ts";
import { createLoginLimiter } from "../../src/auth/login-limiter.ts";
import type { Principal } from "../../src/auth/principal.ts";
import type { McpToolDeps } from "../../src/mcp/handlers.ts";
import { registerMcpRoutes } from "../../src/mcp/routes.ts";
import { buildIdentity } from "../../src/scoping/test-fixtures/index.ts";
import { generateApiToken } from "../../src/tokens/token-format.ts";

let sftp: Awaited<ReturnType<typeof startSftpgo>>;
let server: ServerType;
let client: Client;
let principal: Principal;
let revoked = false;
let indexAvailable = true;

beforeAll(async () => {
  sftp = await startSftpgo({
    users: [{ username: "alice", password: "mcp-fixture-only", permissions: { "/": ["*"] } }],
    folders: [],
    files: { alice: { "/source.txt": "source", "/destination.txt": "keep destination" } },
  });
  const upstream = createSftpgoClient({ baseUrl: sftp.baseUrl });
  const upstreamToken = await upstream.login({ username: "alice", password: "mcp-fixture-only" });
  principal = {
    accountId: "account-1",
    identityId: "identity-1",
    username: "alice",
    isAdmin: false,
    storage: createSftpgoStorageProvider({
      client: upstream,
      withToken: (fn) => fn(upstreamToken.accessToken),
    }),
  };
  const token = generateApiToken();
  const app = new Hono() as AppHono;
  registerMcpRoutes(app, {
    resolveToken: async (raw) => (raw === token && !revoked ? principal : null),
    limiter: createLoginLimiter({ clock: () => new Date() }),
    clientIp: () => "127.0.0.1",
    toolDeps: {
      identities: { get: async () => buildIdentity() },
      scopeResolver: {
        verifiedIndexScopes: async () =>
          indexAvailable
            ? {
                available: true,
                scopes: [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }],
              }
            : { available: false, reason: "provider_mismatch" },
      },
      indexQueries: {
        rootIdsByName: async () => ({ sftpgo: 1 }),
        recordMove: async () => {
          throw new Error("injected audit failure");
        },
      } as unknown as McpToolDeps["indexQueries"],
      searchService: {} as McpToolDeps["searchService"],
      publicUrl: async () => "https://fdrive.example.com",
      indexerClient: null,
      trashPathForStorage: (storage) => (storage.trash === undefined ? null : "/.trash"),
      writesEnabled: true,
      clock: () => new Date(),
    },
  });
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
  });
  client = new Client({ name: "fdrive-integration", version: "1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
});

afterAll(async () => {
  await client?.close();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await sftp?.stop();
});

it("preserves occupied targets, reports completed writes truthfully, and rejects a revoked token", async () => {
  expect((await client.listTools()).tools.some((tool) => tool.name === "move_path")).toBe(true);
  const conflict = await client.callTool({
    name: "move_path",
    arguments: { src: "/source.txt", dst: "/destination.txt" },
  });
  expect(conflict.isError).toBe(true);
  expect(
    await new Response((await principal.storage.download("/destination.txt")).body).text(),
  ).toBe("keep destination");
  const moved = await client.callTool({
    name: "move_path",
    arguments: { src: "/source.txt", dst: "/renamed.txt" },
  });
  expect(moved.isError).not.toBe(true);
  expect(moved.content).toEqual([
    { type: "text", text: expect.stringContaining("move history could not be recorded") },
  ]);
  expect(await new Response((await principal.storage.download("/renamed.txt")).body).text()).toBe(
    "source",
  );
  await expect(principal.storage.stat("/source.txt")).rejects.toMatchObject({ kind: "not_found" });
  revoked = true;
  await expect(client.callTool({ name: "list_directory", arguments: {} })).rejects.toThrow();
});

it("runs full file management over real WebDAV without indexed roots and enforces folder grants", async () => {
  revoked = false;
  indexAvailable = false;
  const base = createWebdavStorageProvider({
    client: createWebdavClient({ baseUrl: sftp.webdavUrl }),
    credential: async () => ({ username: "alice", password: "mcp-fixture-only" }),
  });
  principal = {
    ...principal,
    tokenAccess: { mode: "full", paths: ["/mcp"] },
    storage: {
      ...withMoveToTrash({ storage: base, trashPath: "/.trash", clock: () => new Date() }),
      trash: createRecycleFolderTrash({ storage: base, trashPath: "/.trash", layout: "move" }),
    },
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const content = result.content as { type: string; text: string }[];
    return JSON.parse(content[0]?.text ?? "{}");
  };
  await call("create_folder", { path: "/mcp" });
  const created = await call("create_file", { path: "/mcp/notes #%.txt", text: "original" });
  const read = await call("read_file_text", { path: created.created });
  expect(read.text).toBe("original");
  await call("edit_file", { path: created.created, text: "updated", expected_sha256: read.sha256 });
  const stale = await client.callTool({
    name: "edit_file",
    arguments: { path: created.created, text: "stale", expected_sha256: read.sha256 },
  });
  expect(stale.isError).toBe(true);
  await call("copy_path", { src: created.created, dst: "/mcp/copy.txt" });
  await call("move_path", { src: "/mcp/copy.txt", dst: "/mcp/README" });
  expect((await call("file_info", { path: "/mcp/README" })).kind).toBe("file");
  await call("trash_path", { path: "/mcp/README" });
  const trash = await call("list_trash", {});
  expect(trash.entries).toHaveLength(1);
  await call("restore_path", { id: trash.entries[0].id });
  expect(await new Response((await base.download("/mcp/README")).body).text()).toBe("updated");
  expect(
    (await client.callTool({ name: "read_file", arguments: { path: "/destination.txt" } })).isError,
  ).toBe(true);
  expect(
    (
      await client.callTool({
        name: "move_path",
        arguments: { src: "/mcp/README", dst: "/escape" },
      })
    ).isError,
  ).toBe(true);
  expect(await new Response((await base.download("/destination.txt")).body).text()).toBe(
    "keep destination",
  );
});
