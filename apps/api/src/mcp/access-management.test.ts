import { createHash } from "node:crypto";
import { createRecycleFolderTrash, StorageError, withMoveToTrash } from "@fdrive/core";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createMemoryStorage } from "@fdrive/testkit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../auth/principal.ts";
import { createMetadataService } from "../metadata/service.ts";
import {
  assertMutablePath,
  canBrowsePath,
  canOrganize,
  canReadPath,
  intersectScopes,
  ordinaryPath,
  requireMode,
  tokenScopes,
  trashPathFor,
} from "./access.ts";
import {
  boundedBytes,
  decodeText,
  MAX_FILE_BYTES,
  readFile,
  readFileTextDirect,
  readStoredFile,
} from "./content.ts";
import {
  copyPath,
  createFile,
  editFile,
  fileTags,
  listTrash,
  restorePath,
  searchImages,
  setFavorite,
  trashPath,
} from "./file-tools.ts";
import {
  type McpToolDeps,
  runCreateFolder,
  runFileInfo,
  runListDirectory,
  runMovePath,
  runReadFileText,
  runSearch,
} from "./handlers.ts";
import { registerMcpTools } from "./tools.ts";

const SHA = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture(mode: "read" | "organize" | "full" = "full", paths = ["/allowed"]) {
  const base = createMemoryStorage({
    "/allowed/a.txt": "alpha",
    "/allowed/version.1/README": "no extension",
    "/hidden/secret.txt": "secret",
  });
  const clock = () => new Date("2026-09-12T10:00:00Z");
  const storage = {
    ...withMoveToTrash({ storage: base, trashPath: "/.trash", clock }),
    trash: createRecycleFolderTrash({ storage: base, trashPath: "/.trash", layout: "move" }),
  };
  const repos = createMemoryRepos();
  const account = await repos.accounts.create({ displayName: "Alice" });
  const provider = await repos.providers.ensure({
    type: "webdav",
    baseUrl: "https://storage.invalid",
  });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
  const principal: Principal = {
    accountId: account.id,
    identityId: identity.id,
    username: "alice",
    isAdmin: false,
    storage,
    tokenAccess: { mode, paths },
  };
  const metadata = createMetadataService({ ...repos });
  const deps: McpToolDeps = {
    identities: repos.identities,
    scopeResolver: {
      verifiedIndexScopes: vi.fn(async () => ({
        available: false as const,
        reason: "no_connection" as const,
      })),
    },
    indexQueries: {} as McpToolDeps["indexQueries"],
    searchService: {} as McpToolDeps["searchService"],
    publicUrl: async () => "https://drive.example",
    indexerClient: null,
    writesEnabled: false,
    trashPath: "/.trash",
    clock,
    metadata,
    onMutation: vi.fn(async (_p, change) => {
      if (change.kind === "move" || (change.kind === "restore" && change.moveMetadata))
        await metadata.onMoved(
          identity.id,
          change.path,
          change.target ?? change.path,
          change.isDir,
        );
      if (change.kind === "trash") await metadata.onTrashed(identity.id, change.path, change.isDir);
    }),
  };
  return { base, principal, deps, repos };
}
async function connected(principal: Principal, deps: McpToolDeps) {
  const server = new McpServer({ name: "fdrive-test", version: "1" });
  registerMcpTools(server, principal, deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await server.connect(a);
  await client.connect(b);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

it("enforces normalized grants, ancestor browsing and protected roots", async () => {
  const { principal, deps } = await fixture("read", ["/allowed/version.1", "/allowed/a.txt"]);
  expect(canReadPath(principal, "/allowed/version.1/../a.txt")).toBe(true);
  expect(canReadPath(principal, "/allowed-sibling")).toBe(false);
  expect(canBrowsePath(principal, "/")).toBe(true);
  expect(canBrowsePath(principal, "/hidden")).toBe(false);
  expect((await runListDirectory(deps, principal, {})).entries.map((e) => e.path)).toEqual([
    "/allowed",
  ]);
  expect(
    (await runListDirectory(deps, principal, { path: "/allowed" })).entries.map((e) => e.path),
  ).toEqual(["/allowed/a.txt", "/allowed/version.1"]);
  await expect(runListDirectory(deps, principal, { path: "/hidden" })).rejects.toThrow(
    "allowed folders",
  );
  await expect(readFile(deps, principal, "/allowed/../hidden/secret.txt")).rejects.toThrow(
    "allowed folders",
  );
  expect(() => assertMutablePath(principal, "/allowed/version.1", null)).toThrow("folder root");
  const root = { ...principal, tokenAccess: { mode: "full" as const, paths: ["/"] } };
  expect(() => assertMutablePath(root, "/", null)).toThrow("folder root");
  expect(() => assertMutablePath(root, "/allowed", "/allowed/trash")).toThrow("containing Trash");
  expect(() => ordinaryPath(deps, root, "/.trash/a")).toThrow("Trash");
  expect(trashPathFor({}, principal)).toBe(null);
  expect(trashPathFor({ trashPathForStorage: () => "/bin" }, principal)).toBe("/bin");
});

it("intersects index mappings while retaining aliases and nested shadow boundaries", async () => {
  const scopes = [
    { rootName: "home", fsPrefix: "/alice", virtualPrefix: "/" },
    { rootName: "team", fsPrefix: "/docs", virtualPrefix: "/allowed/team" },
  ] as const;
  expect(intersectScopes(scopes, ["/allowed", "/allowed/team/sub", "/allowed"])).toEqual([
    { rootName: "home", fsPrefix: "/alice/allowed", virtualPrefix: "/allowed" },
    scopes[1],
    { rootName: "team", fsPrefix: "/docs/sub", virtualPrefix: "/allowed/team/sub" },
  ]);
  expect(intersectScopes(scopes, ["/allowed/team/sub"])).toEqual([
    { rootName: "team", fsPrefix: "/docs/sub", virtualPrefix: "/allowed/team/sub" },
  ]);
  expect(intersectScopes([scopes[1]], ["/other"])).toEqual([]);
  const { principal } = await fixture();
  const { tokenAccess: _access, ...legacy } = principal;
  expect(tokenScopes(legacy, scopes)).toBe(scopes);
  expect(canOrganize(legacy, true)).toBe(true);
  expect(canOrganize(legacy, false)).toBe(false);
  expect(() => requireMode(legacy, "full")).toThrow();
});

it("reads provider-backed text, bytes and metadata without index access, including punctuation and paging", async () => {
  const { principal, deps } = await fixture("read");
  expect(
    await runReadFileText(deps, principal, { path: "/allowed/a.txt", offset: 2 }),
  ).toMatchObject({ text: "pha", sha256: SHA("alpha") });
  expect(await readFile(deps, principal, "/allowed/a.txt")).toMatchObject({
    data: Buffer.from("alpha").toString("base64"),
    encoding: "base64",
  });
  expect(await runFileInfo(deps, principal, { path: "/allowed/version.1" })).toMatchObject({
    kind: "dir",
    url: "https://drive.example/files/allowed/version.1",
  });
  expect(deps.scopeResolver.verifiedIndexScopes).not.toHaveBeenCalled();
  const first = await runListDirectory(deps, principal, { path: "/allowed", limit: 1 });
  expect(first.next_offset).toBe(1);
  expect(
    (
      await runListDirectory(deps, principal, {
        path: "/allowed",
        offset: first.next_offset,
        limit: 1,
      })
    ).entries[0]?.path,
  ).toBe("/allowed/version.1");
  expect(decodeText(new Uint8Array([255]))).toBe(null);
  expect(decodeText(new Uint8Array([0]))).toBe(null);
});

it("bounds streams even when a provider understates content size and cancels on overflow", async () => {
  const { principal, deps } = await fixture();
  const cancelled = vi.fn();
  await expect(
    boundedBytes(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(9));
        },
        cancel: cancelled,
      }),
      8,
    ),
  ).rejects.toThrow("limit");
  expect(cancelled).toHaveBeenCalled();
  const metadata = await principal.storage.statFile("/allowed/a.txt");
  const download = vi.spyOn(principal.storage, "download");
  vi.spyOn(principal.storage, "statFile").mockResolvedValueOnce({
    ...metadata,
    size: MAX_FILE_BYTES + 1,
  });
  await expect(readStoredFile(deps, principal, "/allowed/a.txt")).rejects.toThrow("limit");
  expect(download).not.toHaveBeenCalled();
  const response = await principal.storage.download("/allowed/a.txt");
  download.mockResolvedValueOnce({ ...response, contentLength: MAX_FILE_BYTES + 1 });
  await expect(readStoredFile(deps, principal, "/allowed/a.txt")).rejects.toThrow("limit");
  download.mockResolvedValueOnce({
    ...response,
    contentLength: null,
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(MAX_FILE_BYTES + 1));
        c.close();
      },
    }),
  });
  await expect(readStoredFile(deps, principal, "/allowed/a.txt")).rejects.toThrow("limit");
});

it("uses optional byte extraction for documents and reports absent or unreachable processing", async () => {
  const { base, principal, deps } = await fixture();
  await base.upload("/allowed/a.pdf", Buffer.from("%PDF fixture"));
  await expect(readFileTextDirect(deps, principal, { path: "/allowed/a.pdf" })).rejects.toThrow(
    "unavailable",
  );
  const extractContent = vi.fn(async () => ({ text: "document text", status: "ok" }));
  const enabled = { ...deps, indexerClient: { extract: vi.fn(), extractContent } };
  expect(await readFileTextDirect(enabled, principal, { path: "/allowed/a.pdf" })).toMatchObject({
    text: "document text",
    status: "ok",
  });
  expect(extractContent).toHaveBeenCalledWith({
    name: "a.pdf",
    bytes: Buffer.from("%PDF fixture"),
  });
  await expect(
    readFileTextDirect(
      { ...deps, indexerClient: { extract: vi.fn(), extractContent: async () => null } },
      principal,
      { path: "/allowed/a.pdf" },
    ),
  ).rejects.toThrow("reachable");
});

it("organizes independently of indexing and rejects unauthorized writes, collisions and descendants", async () => {
  const { principal, deps, base } = await fixture("organize");
  await runCreateFolder(deps, principal, { path: "/allowed/new" });
  await fileTags(deps, principal, "/allowed/a.txt", ["Work"]);
  await runMovePath(deps, principal, { src: "/allowed/a.txt", dst: "/allowed/new/README" });
  expect((await fileTags(deps, principal, "/allowed/new/README")).tags[0]?.name).toBe("Work");
  expect(
    await copyPath(deps, principal, { src: "/allowed/new", dst: "/allowed/copy.1" }),
  ).toMatchObject({ to: "/allowed/copy.1" });
  expect(await new Response((await base.download("/allowed/copy.1/README")).body).text()).toBe(
    "alpha",
  );
  await expect(
    copyPath(deps, principal, { src: "/allowed/new", dst: "/allowed/new/sub" }),
  ).rejects.toThrow();
  await expect(
    runMovePath(deps, principal, { src: "/allowed/new", dst: "/hidden/escape" }),
  ).rejects.toThrow("allowed folders");
  await expect(createFile(deps, principal, { path: "/allowed/a", text: "x" })).rejects.toThrow(
    "full",
  );
  await expect(trashPath(deps, principal, "/allowed/new")).rejects.toThrow("full");
  const read = { ...principal, tokenAccess: { mode: "read" as const, paths: ["/"] } };
  await expect(runCreateFolder(deps, read, { path: "/new" })).rejects.toThrow("organize");
  await expect(copyPath(deps, read, { src: "/allowed/new", dst: "/copy" })).rejects.toThrow(
    "organize",
  );
});

it("creates/uploads exact bytes, checks stale edits, and preserves occupied targets", async () => {
  const { principal, deps, base } = await fixture();
  await createFile(deps, principal, { path: "/allowed/#?%.txt", text: "before" });
  const previous = await readFileTextDirect(deps, principal, { path: "/allowed/#?%.txt" });
  expect(previous.url).toContain("%23%3F%25.txt");
  expect(
    await editFile(deps, principal, {
      path: previous.path,
      text: "after",
      expected_sha256: previous.sha256,
    }),
  ).toMatchObject({ sha256: SHA("after") });
  await expect(
    editFile(deps, principal, {
      path: previous.path,
      text: "stale",
      expected_sha256: previous.sha256,
    }),
  ).rejects.toThrow("changed");
  await expect(
    createFile(deps, principal, { path: previous.path, text: "clobber" }),
  ).rejects.toMatchObject({ kind: "conflict" });
  await expect(
    createFile(deps, principal, { path: "/allowed/version.1", text: "clobber" }),
  ).rejects.toMatchObject({ kind: "conflict" });
  await expect(
    createFile(deps, principal, { path: "/allowed/large", text: "x".repeat(MAX_FILE_BYTES + 1) }),
  ).rejects.toThrow("limit");
  await expect(
    createFile(deps, principal, { path: "/allowed/invalid", data: "###" }),
  ).rejects.toThrow("base64");
  await createFile(deps, principal, { path: "/allowed/raw.bin", data: "AP8=" });
  expect((await readFile(deps, principal, "/allowed/raw.bin")).data).toBe("AP8=");
  await expect(
    editFile(deps, principal, {
      path: "/allowed/raw.bin",
      text: "bad",
      expected_sha256: createHash("sha256").update(Buffer.from("AP8=", "base64")).digest("hex"),
    }),
  ).rejects.toThrow("UTF-8");
  const broken = {
    ...deps,
    onMutation: async () => {
      throw new Error("database down");
    },
  };
  expect(
    await createFile(broken, principal, { path: "/allowed/done", text: "done" }),
  ).toHaveProperty("warnings");
  expect(await base.stat("/allowed/done")).toMatchObject({ kind: "file" });
});

it("restores only authorized Trash entries and preserves tags/favorites through move and alternate restore", async () => {
  const { principal, deps, base } = await fixture();
  await fileTags(deps, principal, "/allowed/a.txt", ["Work", "Work"]);
  await setFavorite(deps, principal, { path: "/allowed/a.txt", favorite: true });
  await principal.storage.deleteFile("/hidden/secret.txt");
  await trashPath(deps, principal, "/allowed/a.txt");
  const listing = await listTrash(deps, principal, {});
  expect(listing.entries).toHaveLength(1);
  const id = listing.entries[0]?.id ?? "missing";
  await expect(
    restorePath(deps, principal, { id, target: "/hidden/restored.txt" }),
  ).rejects.toThrow("allowed folders");
  const all = await principal.storage.trash?.list({ limit: 100 });
  const hidden = all?.entries.find((e) => e.originalPath.startsWith("/hidden"));
  await expect(restorePath(deps, principal, { id: hidden?.id ?? "missing" })).rejects.toThrow(
    "allowed folders",
  );
  expect(await restorePath(deps, principal, { id, target: "/allowed/restored.txt" })).toMatchObject(
    { restored: "/allowed/restored.txt" },
  );
  expect((await fileTags(deps, principal, "/allowed/restored.txt")).tags[0]?.name).toBe("Work");
  await setFavorite(deps, principal, { path: "/allowed/restored.txt", favorite: false });
  expect(await fileTags(deps, principal, "/allowed/restored.txt", [])).toMatchObject({ tags: [] });
  await expect(restorePath(deps, principal, { id })).rejects.toThrow("listing");
  await expect(
    trashPath({ ...deps, trashPath: null }, principal, "/allowed/restored.txt"),
  ).rejects.toThrow("no file was deleted");
  expect(await base.stat("/allowed/restored.txt")).toMatchObject({ kind: "file" });
  await trashPath(deps, principal, "/allowed/version.1");
  const folder = (await listTrash(deps, principal, { offset: 0, limit: 1 })).entries[0];
  expect(await restorePath(deps, principal, { id: folder?.id ?? "missing" })).toMatchObject({
    restored: "/allowed/version.1",
  });
});

it("preserves search availability and passes grants to visual search", async () => {
  const { principal, deps } = await fixture("read");
  const search = vi.fn(async () => ({
    query: "red",
    hits: [],
    partial: true,
    unavailable: false,
    tookMs: 1,
  }));
  expect(await searchImages(deps, principal, { query: "red" })).toMatchObject({
    unavailable: true,
  });
  expect(
    await searchImages({ ...deps, imageSearchService: { search } }, principal, { query: "red" }),
  ).toMatchObject({ partial: true });
  expect(search).toHaveBeenCalledWith(
    expect.objectContaining({ scopes: [], trashPath: "/.trash" }),
  );
  const searchService = {
    search: vi.fn(async () => ({ sections: { files: [] }, partial: true, degraded: true })),
  } as unknown as McpToolDeps["searchService"];
  expect(await runSearch({ ...deps, searchService }, principal, { query: "red" })).toMatchObject({
    partial: true,
    degraded: true,
  });
});

describe("SDK tool discovery and calls", () => {
  it.each(["read", "organize", "full"] as const)(
    "exposes and enforces %s permissions",
    async (mode) => {
      const { principal, deps } = await fixture(mode);
      const { client, close } = await connected(principal, deps);
      try {
        const tools = (await client.listTools()).tools;
        const names = tools.map((t) => t.name);
        expect(names.includes("create_folder")).toBe(mode !== "read");
        expect(names.includes("create_file")).toBe(mode === "full");
        expect(names.includes("trash_path")).toBe(mode === "full");
        expect(tools.find((t) => t.name === "read_file")?.annotations?.readOnlyHint).toBe(true);
        expect((await client.callTool({ name: "capabilities", arguments: {} })).isError).not.toBe(
          true,
        );
        expect(
          (await client.callTool({ name: "read_file_text", arguments: { path: "/allowed/a.txt" } }))
            .isError,
        ).not.toBe(true);
        expect(
          (await client.callTool({ name: "read_file", arguments: { path: "/hidden/secret.txt" } }))
            .isError,
        ).toBe(true);
        if (mode === "read")
          expect(
            (await client.callTool({ name: "create_folder", arguments: { path: "/allowed/new" } }))
              .isError,
          ).toBe(true);
        if (mode === "full") {
          expect(
            (
              await client.callTool({
                name: "upload_file",
                arguments: { path: "/allowed/new.png", data: "aW1hZ2U=" },
              })
            ).isError,
          ).not.toBe(true);
          const image = await client.callTool({
            name: "read_image",
            arguments: { path: "/allowed/new.png" },
          });
          expect(image.content).toContainEqual(
            expect.objectContaining({ type: "image", mimeType: "image/png" }),
          );
          expect(
            (await client.callTool({ name: "read_image", arguments: { path: "/allowed/a.txt" } }))
              .isError,
          ).toBe(true);
        }
      } finally {
        await close();
      }
    },
  );
  it("keeps new direct read tools away from legacy tokens", async () => {
    const { principal, deps } = await fixture();
    const { tokenAccess: _access, ...legacy } = principal;
    const { client, close } = await connected(legacy, deps);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("read_file");
      await expect(readFile(deps, legacy, "/allowed/a.txt")).rejects.toThrow(
        "explicit permissions",
      );
      await expect(runReadFileText(deps, legacy, { path: "/allowed/a.txt" })).rejects.toThrow();
      await expect(runReadFileText(deps, legacy, { path: "/.trash/secret" })).rejects.toThrow(
        "Trash",
      );
    } finally {
      await close();
    }
  });
});

it("serializes concurrent MCP edits and releases the lock after a stale request", async () => {
  const { principal, deps } = await fixture();
  const outcomes = await Promise.allSettled(
    ["first", "second"].map((text) =>
      editFile(deps, principal, { path: "/allowed/a.txt", text, expected_sha256: SHA("alpha") }),
    ),
  );
  expect(outcomes.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
  expect(
    await editFile(deps, principal, {
      path: "/allowed/a.txt",
      text: "third",
      expected_sha256: SHA("first"),
    }),
  ).toMatchObject({ sha256: SHA("third") });
});

it("executes all advertised management tools through the MCP SDK", async () => {
  const { principal, deps } = await fixture();
  const visual = {
    ...deps,
    imageSearchService: {
      search: async () => ({
        query: "red",
        hits: [
          {
            path: "/allowed/a.txt",
            name: "a.txt",
            ext: "txt",
            mime: "text/plain",
            size: 5,
            modifiedAt: new Date(0).toISOString(),
            score: 1,
          },
        ],
        unavailable: false,
        tookMs: 0,
      }),
    },
  };
  const { client, close } = await connected(principal, visual);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const content = result.content as { text: string }[];
    return JSON.parse(content[0]?.text ?? "{}");
  };
  try {
    await call("create_folder", { path: "/allowed/sdk" });
    await call("create_file", { path: "/allowed/sdk/a.txt", text: "initial" });
    await call("edit_file", {
      path: "/allowed/sdk/a.txt",
      text: "edited",
      expected_sha256: SHA("initial"),
    });
    await call("copy_path", { src: "/allowed/sdk/a.txt", dst: "/allowed/sdk/copy.txt" });
    await call("move_path", { src: "/allowed/sdk/copy.txt", dst: "/allowed/sdk/moved.txt" });
    await call("set_file_tags", { path: "/allowed/sdk/moved.txt", names: ["SDK"] });
    expect((await call("file_tags", { path: "/allowed/sdk/moved.txt" })).tags[0].name).toBe("SDK");
    await call("set_favorite", { path: "/allowed/sdk/moved.txt", favorite: true });
    await call("trash_path", { path: "/allowed/sdk/moved.txt" });
    const listing = await call("list_trash", {});
    await call("restore_path", { id: listing.entries[0].id });
    expect((await call("search_images", { query: "red", limit: 1 })).hits[0].url).toBe(
      "https://drive.example/view/allowed/a.txt",
    );
  } finally {
    await close();
  }
});

it("handles cancellation, unavailable metadata and post-restore failures without lying about the storage result", async () => {
  const { principal, deps, base } = await fixture();
  expect(
    await boundedBytes(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1]));
          c.close();
        },
        cancel() {
          throw new Error("cancel failed");
        },
      }),
      2,
    ),
  ).toEqual(Buffer.from([1]));
  const refusing = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(3));
    },
    cancel() {
      throw new Error("cancel failed");
    },
  });
  await expect(boundedBytes(refusing, 2)).rejects.toThrow("limit");
  const { metadata: _metadata, ...missing } = deps;
  await expect(fileTags(missing, principal, "/allowed/a.txt")).rejects.toThrow("unavailable");
  const root = { ...principal, tokenAccess: { mode: "organize" as const, paths: ["/"] } };
  await expect(copyPath(deps, root, { src: "/", dst: "/copy" })).rejects.toThrow(
    "containing Trash",
  );
  await copyPath(deps, principal, { src: "/allowed/a.txt", dst: "/allowed/a.txt" });
  expect(deps.onMutation).not.toHaveBeenCalled();
  await trashPath(deps, principal, "/allowed/a.txt");
  const id = (await listTrash(deps, principal, {})).entries[0]?.id ?? "missing";
  const stat = principal.storage.stat;
  principal.storage.stat = async (path) => {
    if (path === "/allowed/a.txt") throw new StorageError("upstream_unavailable", "probe failed");
    return stat(path);
  };
  const restored = await restorePath(
    {
      ...deps,
      onMutation: async () => {
        throw new Error("metadata failed");
      },
    },
    principal,
    { id, target: "/allowed/recovered.txt" },
  );
  expect(restored.warnings).toHaveLength(2);
  expect(await base.stat("/allowed/recovered.txt")).toMatchObject({ kind: "file" });
});

it("keeps capabilities available when index mapping fails", async () => {
  const { principal, deps } = await fixture("read");
  const { client, close } = await connected(principal, {
    ...deps,
    scopeResolver: {
      verifiedIndexScopes: async () => {
        throw new Error("indexer unreachable");
      },
    },
  });
  try {
    const response = await client.callTool({ name: "capabilities", arguments: {} });
    expect(response.isError).not.toBe(true);
    expect(JSON.stringify(response.content)).toContain("index mapping unavailable");
  } finally {
    await close();
  }
});

it("pages multiple Trash entries and reuses existing tag names without creating duplicates", async () => {
  const { principal, deps, base } = await fixture();
  const initial = await fileTags(deps, principal, "/allowed/a.txt", ["Work"]);
  const repeated = await fileTags(deps, principal, "/allowed/a.txt", ["Work"]);
  expect(repeated.tags).toEqual(initial.tags);
  expect(await deps.metadata?.listTags(principal.accountId)).toHaveLength(1);
  await base.upload("/allowed/b.txt", Buffer.from("second"));
  await trashPath(deps, principal, "/allowed/a.txt");
  await trashPath(deps, principal, "/allowed/b.txt");
  const first = await listTrash(deps, principal, { limit: 1 });
  expect(first.next_offset).toBe(1);
  const second = await listTrash(deps, principal, { limit: 1, offset: first.next_offset });
  expect(second.entries).toHaveLength(1);
  expect(first.entries[0]?.id).not.toBe(second.entries[0]?.id);
  expect(second).not.toHaveProperty("next_offset");
});

it("passes only the token’s mapped folders to indexed text and image search", async () => {
  const { principal, deps } = await fixture("read", ["/allowed/version.1"]);
  const scopes = [{ rootName: "disk", fsPrefix: "/alice", virtualPrefix: "/" }];
  const search = vi.fn(async () => ({ sections: { files: [] }, unavailable: false }));
  const images = vi.fn(async () => ({ query: "q", hits: [], tookMs: 0, unavailable: false }));
  const indexed: McpToolDeps = {
    ...deps,
    scopeResolver: { verifiedIndexScopes: async () => ({ available: true, scopes }) },
    searchService: { search } as unknown as McpToolDeps["searchService"],
    imageSearchService: { search: images },
  };
  await runSearch(indexed, principal, { query: "q" });
  await searchImages(indexed, principal, { query: "q" });
  for (const callback of [search, images])
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: [
          {
            rootName: "disk",
            fsPrefix: "/alice/allowed/version.1",
            virtualPrefix: "/allowed/version.1",
          },
        ],
      }),
    );
});
