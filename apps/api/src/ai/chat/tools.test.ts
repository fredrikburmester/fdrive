import { createHash } from "node:crypto";
import { baseName, type Scope, type StorageProvider } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import type { IndexedFile, IndexQueries } from "@fdrive/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../../auth/principal.js";
import {
  fileInfoInScope,
  findFilesInScope,
  type McpToolDeps,
  similarFilesInScope,
} from "../../mcp/handlers.js";
import { buildIdentity } from "../../scoping/test-fixtures/index.ts";
import type { AiTool } from "../tools/tool.ts";
import { createChatReadTools, READ_CHARS, readBytes } from "./tools.ts";

vi.mock("../../mcp/handlers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../mcp/handlers.js")>()),
  fileInfoInScope: vi.fn(),
  similarFilesInScope: vi.fn(),
  findFilesInScope: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(fileInfoInScope).mockReset();
  vi.mocked(similarFilesInScope).mockReset();
  vi.mocked(findFilesInScope).mockReset();
});

const SCOPES: readonly Scope[] = [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }];

function indexedFile(id: number, path: string, extra: Partial<IndexedFile> = {}): IndexedFile {
  return {
    id,
    rootId: 1,
    path,
    name: baseName(path),
    ext: "",
    size: 10,
    mtimeNs: 0n,
    sha256: "abc",
    mime: null,
    textStatus: "done",
    textChars: 0,
    error: null,
    indexedAt: null,
    deletedAt: null,
    ...extra,
  };
}

const FILES: Record<string, IndexedFile> = {
  "alice/Inbox/scan.pdf": indexedFile(1, "alice/Inbox/scan.pdf", { textChars: 50_000 }),
  "alice/Inbox/blank.pdf": indexedFile(2, "alice/Inbox/blank.pdf", { textStatus: "empty" }),
  "alice/Inbox/note.txt": indexedFile(3, "alice/Inbox/note.txt", { sha256: null }),
};

function setup(
  options: {
    indexed?: boolean;
    share?: { contents: boolean; otherFileNames: boolean };
    metadata?: McpToolDeps["metadata"];
  } = {},
) {
  const storage: StorageProvider = createMemoryStorage({
    "/Inbox/note.txt": "hello world",
    "/Inbox/big.txt": "x".repeat(READ_CHARS + 10),
    "/Inbox/scan.pdf": "%PDF-1.4 binary",
    "/Inbox/blank.pdf": "%PDF",
    "/Inbox/bytes.bin": "\0\x01\x02",
    "/Inbox/Sub/inner.md": "# Inner",
    "/Other/secret.txt": "s",
  });
  const principal: Principal = {
    accountId: "acct",
    identityId: "id",
    username: "alice",
    storage,
    isAdmin: false,
  };
  const fileTextPrefix = vi.fn(async (id: number, chars: number) =>
    id === 1 ? "scan text ".repeat(6000).slice(0, chars) : "",
  );
  const mcp: McpToolDeps = {
    indexQueries: {
      rootIdsByName: async () => ({ sftpgo: 1 }),
      fileByPath: async (_rootId: number, path: string) => FILES[path] ?? null,
      fileTextPrefix,
    } as unknown as IndexQueries,
    searchService: { search: async () => Promise.reject(new Error("unexpected")) },
    scopeResolver: {
      verifiedIndexScopes: async () =>
        options.indexed === false
          ? ({ available: false, reason: "no_connection" } as const)
          : ({ available: true, scopes: SCOPES } as const),
    },
    identities: { get: async () => buildIdentity() },
    publicUrl: async () => null,
    indexerClient: null,
    writesEnabled: false,
    clock: () => new Date("2026-09-18T10:00:00.000Z"),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
  const tools = createChatReadTools({
    mcp,
    principal,
    focus: {
      paths: new Set(["/Inbox"]),
      adjective: "referenced",
      group: "the references",
      openFolders: true,
    },
    indexed: options.indexed ?? true,
    ...(options.share ? { share: options.share } : {}),
  });
  const tool = (name: string): AiTool => {
    const found = tools.find((candidate) => candidate.spec.name === name);
    if (found === undefined) throw new Error(`no tool ${name}`);
    return found;
  };
  const run = (name: string, args: unknown) =>
    tool(name).run(tool(name).schema.parse(args), new AbortController().signal);
  return { tools, tool, run, fileTextPrefix };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("createChatReadTools", () => {
  it("offers reading only when contents are shared and copies only when indexed", () => {
    expect(setup().tools.map((tool) => tool.spec.name)).toEqual([
      "read_file",
      "file_info",
      "duplicates_of",
    ]);
    expect(
      setup({ share: { contents: false, otherFileNames: true } }).tools.map(
        (tool) => tool.spec.name,
      ),
    ).toEqual(["file_info", "duplicates_of"]);
    expect(setup({ indexed: false }).tools.map((tool) => tool.spec.name)).toEqual([
      "read_file",
      "file_info",
    ]);
  });
});

describe("read_file", () => {
  it("returns a text file's content with its hash, paging long files", async () => {
    const { run, tool } = setup();
    expect(tool("read_file").activity({ path: "/Inbox/note.txt", offset: 0 })).toBe(
      "Read note.txt",
    );

    expect(await run("read_file", { path: "/Inbox/note.txt" })).toBe(
      `/Inbox/note.txt (11 characters, sha256 ${sha("hello world")})\n\nhello world`,
    );
    expect(await run("read_file", { path: "/Inbox/Sub/inner.md" })).toContain("# Inner");

    const first = await run("read_file", { path: "/Inbox/big.txt" });
    expect(first).toContain(`(More: call again with offset ${READ_CHARS}.)`);
    const rest = await run("read_file", { path: "/Inbox/big.txt", offset: READ_CHARS });
    expect(rest.endsWith("xxxxxxxxxx")).toBe(true);
    expect(rest).not.toContain("More:");
  });

  it("falls back to extracted index text for documents and binaries", async () => {
    const { run, fileTextPrefix } = setup();

    const first = await run("read_file", { path: "/Inbox/scan.pdf" });
    expect(first).toMatch(
      /^\/Inbox\/scan\.pdf \(50000 characters of extracted text\)\n\nscan text /,
    );
    expect(first).toContain(`(More: call again with offset ${READ_CHARS}.)`);
    expect(fileTextPrefix).toHaveBeenCalledWith(1, READ_CHARS);
    await run("read_file", { path: "/Inbox/scan.pdf", offset: 45_000 });
    expect(fileTextPrefix).toHaveBeenLastCalledWith(1, 45_000 + READ_CHARS);

    expect(await run("read_file", { path: "/Inbox/blank.pdf" })).toBe(
      "/Inbox/blank.pdf: no extracted text (status: empty).",
    );
    expect(await run("read_file", { path: "/Inbox/bytes.bin" })).toContain(
      "no extracted text is available",
    );
    expect(await setup({ indexed: false }).run("read_file", { path: "/Inbox/scan.pdf" })).toContain(
      "no extracted text is available",
    );
  });

  it("refuses folders and files outside the references", async () => {
    const { run } = setup();
    await expect(run("read_file", { path: "/Inbox" })).rejects.toThrow(/is a folder/);
    await expect(run("read_file", { path: "/Other/secret.txt" })).rejects.toThrow(/not referenced/);
    await expect(run("read_file", { path: "/bad\0" })).rejects.toThrow(/not a valid path/);
  });
});

describe("file_info", () => {
  it("describes a file with its tags, index state and identical copies", async () => {
    vi.mocked(fileInfoInScope).mockResolvedValueOnce({
      identical_copies: ["/Archive/note.txt", "/Old/note.txt"],
    } as never);
    const metadata = {
      decorate: vi.fn(async (_identity: string, entries: unknown[]) =>
        entries.map((entry) => ({
          ...(entry as object),
          meta: { tagIds: ["t1"], favorite: true },
        })),
      ),
      listTags: vi.fn(async () => [
        { id: "t1", name: "Work", color: null },
        { id: "t2", name: "Other", color: null },
      ]),
    } as unknown as NonNullable<McpToolDeps["metadata"]>;
    const { run } = setup({ metadata });

    expect(await run("file_info", { path: "/Inbox/note.txt" })).toBe(
      [
        "/Inbox/note.txt",
        "kind: file",
        "size: 11 B (11 bytes)",
        "modified: 1970-01-01T00:00:00.000Z",
        "tags: Work",
        "favorite: yes",
        "index: done",
        "identical copies: /Archive/note.txt, /Old/note.txt",
      ].join("\n"),
    );
    expect(metadata.decorate).toHaveBeenCalledWith("id", [
      expect.objectContaining({ path: "/Inbox/note.txt", kind: "file" }),
    ]);
  });

  it("describes folders and unindexed files without copies, hiding names when they are withheld", async () => {
    vi.mocked(fileInfoInScope).mockResolvedValueOnce({
      identical_copies: ["/Archive/scan.pdf", "/Archive/x.pdf", "/Old/scan.pdf"],
    } as never);
    const { run } = setup({ share: { contents: true, otherFileNames: false } });

    expect(await run("file_info", { path: "/Inbox" })).toBe(
      ["/Inbox", "kind: folder", "modified: unknown"].join("\n"),
    );
    expect(await run("file_info", { path: "/Inbox/bytes.bin" })).toContain(
      "index: not indexed, so no content hash or copies",
    );
    expect(await run("file_info", { path: "/Inbox/scan.pdf" })).toContain(
      "identical copies: 2 in /Archive, 1 in /Old",
    );
  });
});

describe("duplicates_of", () => {
  it("reports identical, similar and same-named files, leaving the file itself out", async () => {
    vi.mocked(fileInfoInScope).mockResolvedValueOnce({
      identical_copies: ["/Archive/scan.pdf"],
    } as never);
    vi.mocked(similarFilesInScope).mockResolvedValueOnce({
      path: "/Inbox/scan.pdf",
      results: [
        { path: "/Inbox/scan.pdf", similarity: 1 },
        { path: "/Archive/scan.pdf", similarity: 0.99 },
        { path: "/Docs/scan-2023.pdf", similarity: 0.8712 },
      ],
    } as never);
    vi.mocked(findFilesInScope).mockResolvedValueOnce({
      results: [
        { path: "/Inbox/scan.pdf" },
        { path: "/Backup/scan.pdf" },
        { path: "/Backup/scan.pdf.bak" },
        { path: "/Archive/scan.pdf" },
      ],
    } as never);
    const { run, tool } = setup();
    expect(tool("duplicates_of").activity({ path: "/Inbox/scan.pdf" })).toBe(
      "Looked for copies of scan.pdf",
    );

    expect(await run("duplicates_of", { path: "/Inbox/scan.pdf" })).toBe(
      [
        "/Inbox/scan.pdf",
        "identical content: /Archive/scan.pdf",
        "similar content: /Docs/scan-2023.pdf (87%)",
        "same name elsewhere: /Backup/scan.pdf",
      ].join("\n"),
    );
    expect(vi.mocked(findFilesInScope).mock.calls.at(-1)?.[3]).toEqual({
      name_contains: "scan.pdf",
      limit: 20,
    });
  });

  it("says so for a file the index does not know", async () => {
    const { run } = setup();
    expect(await run("duplicates_of", { path: "/Inbox/bytes.bin" })).toContain("is not indexed");
  });
});

describe("readBytes", () => {
  function storageWith(contentLength: number | null, bytes: Uint8Array) {
    return {
      download: async () => ({
        contentLength,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      }),
    } as unknown as StorageProvider;
  }
  const deps = (storage: StorageProvider) =>
    ({ principal: { storage } }) as unknown as Parameters<typeof readBytes>[0];

  it("gives up on files the provider reports as too large, or that turn out too large", async () => {
    const signal = new AbortController().signal;
    expect(await readBytes(deps(storageWith(20, new Uint8Array(20))), "/x", 10, signal)).toBeNull();
    expect(
      await readBytes(deps(storageWith(null, new Uint8Array(20))), "/x", 10, signal),
    ).toBeNull();
    const read = await readBytes(
      deps(storageWith(null, new Uint8Array([104, 105]))),
      "/x",
      10,
      signal,
    );
    expect(read?.bytes.toString()).toBe("hi");
  });
});

describe("file_info: edge cases", () => {
  it("names no copies as none and describes its activity", async () => {
    vi.mocked(fileInfoInScope).mockResolvedValueOnce({ identical_copies: [] } as never);
    const { run, tool } = setup({ share: { contents: true, otherFileNames: false } });
    expect(tool("file_info").activity({ path: "/Inbox/note.txt" })).toBe("Looked at note.txt");
    expect(await run("file_info", { path: "/Inbox/note.txt" })).toContain("identical copies: none");
  });

  it("passes unexpected index failures through", async () => {
    vi.mocked(fileInfoInScope).mockRejectedValueOnce(new Error("db down"));
    const { run } = setup();
    await expect(run("file_info", { path: "/Inbox/note.txt" })).rejects.toThrow("db down");
  });
});
