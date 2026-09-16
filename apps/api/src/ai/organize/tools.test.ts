import type { OrganizeSharing } from "@fdrive/contracts";
import { baseName, type Scope, StorageError, type StorageProvider } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import type { IndexedFile, IndexQueries } from "@fdrive/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Principal } from "../../auth/principal.js";
import { type McpToolDeps, runSearch, runSimilarFiles } from "../../mcp/handlers.js";
import { buildIdentity } from "../../scoping/test-fixtures/index.ts";
import {
  createOrganizeTools,
  EXCERPT_CHARS,
  formatSize,
  isSelectedOrInside,
  type OrganizeTool,
  OrganizeToolError,
  TREE_LISTING_BUDGET,
  TREE_MAX_LINES,
  toolSpec,
} from "./tools.ts";

vi.mock("../../mcp/handlers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../mcp/handlers.js")>()),
  runSearch: vi.fn(),
  runSimilarFiles: vi.fn(),
}));

const HOME_SCOPES: readonly Scope[] = [
  { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
];

function principalWith(storage: StorageProvider): Principal {
  return {
    accountId: "account-1",
    identityId: "identity-1",
    username: "alice",
    storage,
    isAdmin: false,
  };
}

function mcpDeps(overrides: Partial<McpToolDeps> = {}): McpToolDeps {
  return {
    indexQueries: { rootIdsByName: async () => ({ sftpgo: 1 }) } as unknown as IndexQueries,
    searchService: { search: async () => Promise.reject(new Error("unexpected search")) },
    scopeResolver: {
      verifiedIndexScopes: async () => ({ available: true, scopes: HOME_SCOPES }),
    },
    identities: { get: async () => buildIdentity() },
    publicUrl: async () => null,
    indexerClient: null,
    writesEnabled: false,
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

interface ToolsSetup {
  readonly storage?: StorageProvider;
  readonly selected?: readonly string[];
  readonly indexed?: boolean;
  readonly share?: OrganizeSharing;
  readonly mcp?: Partial<McpToolDeps>;
}

const NAMES_WITHHELD: OrganizeSharing = { contents: true, otherFileNames: false };

function toolsFor(setup: ToolsSetup = {}) {
  const storage = setup.storage ?? createMemoryStorage();
  const principal = principalWith(storage);
  const mcp = mcpDeps(setup.mcp);
  const tools = createOrganizeTools({
    mcp,
    principal,
    selected: new Set(setup.selected ?? []),
    indexed: setup.indexed ?? true,
    ...(setup.share === undefined ? {} : { share: setup.share }),
  });
  return {
    tools,
    principal,
    mcp,
    tool(name: string): OrganizeTool {
      const found = tools.find((candidate) => candidate.spec.name === name);
      if (found === undefined) throw new Error(`no tool named ${name}`);
      return found;
    },
  };
}

/** Parses `args` through the tool's schema, like the agent does, then runs it. */
function runTool(
  tool: OrganizeTool,
  args: unknown,
  signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  return tool.run(tool.schema.parse(args), signal);
}

function activityOf(tool: OrganizeTool, args: unknown): string {
  return tool.activity(tool.schema.parse(args));
}

/** Files named `<prefix><n>` (zero-padded) holding one byte each. */
function manyFiles(count: number, path: (n: string) => string): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) files[path(String(i).padStart(4, "0"))] = "x";
  return files;
}

describe("formatSize", () => {
  it("shows bytes as whole numbers", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("shows larger sizes with one decimal", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(5 * 1024 ** 2)).toBe("5.0 MB");
    expect(formatSize(2.25 * 1024 ** 3)).toBe("2.3 GB");
  });

  it("stops at terabytes", () => {
    expect(formatSize(3 * 1024 ** 4)).toBe("3.0 TB");
    expect(formatSize(2048 * 1024 ** 4)).toBe("2048.0 TB");
  });
});

describe("isSelectedOrInside", () => {
  const selected = new Set(["/Inbox/scan.pdf", "/Projects"]);

  it("matches a selected item and anything inside a selected folder", () => {
    expect(isSelectedOrInside(selected, "/Inbox/scan.pdf")).toBe(true);
    expect(isSelectedOrInside(selected, "/Projects")).toBe(true);
    expect(isSelectedOrInside(selected, "/Projects/site/index.html")).toBe(true);
  });

  it("does not match siblings, parents or look-alike prefixes", () => {
    expect(isSelectedOrInside(selected, "/Inbox")).toBe(false);
    expect(isSelectedOrInside(selected, "/Inbox/other.pdf")).toBe(false);
    expect(isSelectedOrInside(selected, "/Projects-old/a.txt")).toBe(false);
    expect(isSelectedOrInside(new Set(), "/anything")).toBe(false);
  });
});

describe("toolSpec", () => {
  it("drops the $schema key and marks defaulted fields optional", () => {
    const spec = toolSpec(
      "example",
      "An example.",
      z.object({ path: z.string(), depth: z.number().default(2) }),
    );

    expect(spec.name).toBe("example");
    expect(spec.description).toBe("An example.");
    expect(spec.inputSchema).not.toHaveProperty("$schema");
    expect(spec.inputSchema).toMatchObject({
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" }, depth: { type: "number", default: 2 } },
    });
  });
});

describe("createOrganizeTools", () => {
  it("offers only the folder tools when the identity is not indexed", () => {
    const { tools } = toolsFor({ indexed: false });

    expect(tools.map((tool) => tool.spec.name)).toEqual(["folder_tree", "list_folder"]);
  });

  it("adds excerpts, search and similarity when the identity is indexed", () => {
    const { tools } = toolsFor({ indexed: true });

    expect(tools.map((tool) => tool.spec.name)).toEqual([
      "folder_tree",
      "list_folder",
      "read_excerpts",
      "search_drive",
      "similar_files",
    ]);
    for (const tool of tools) {
      expect(tool.spec.description.length).toBeGreaterThan(0);
      expect(tool.spec.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("leaves out excerpts when the person does not share contents, keeping search and similarity", () => {
    const { tools } = toolsFor({ indexed: true, share: { contents: false, otherFileNames: true } });

    expect(tools.map((tool) => tool.spec.name)).toEqual([
      "folder_tree",
      "list_folder",
      "search_drive",
      "similar_files",
    ]);
  });

  it("says in the folder tools' descriptions when other file names are withheld", () => {
    const { tool } = toolsFor({ share: NAMES_WITHHELD });

    expect(tool("folder_tree").spec.description).toContain(
      "File names outside the selection are not shared",
    );
    expect(tool("list_folder").spec.description).toContain("Other files are counted, not named");
    expect(tool("read_excerpts")).toBeDefined();
  });
});

describe("folder_tree", () => {
  const tree = () =>
    createMemoryStorage({
      "/notes.md": "hi",
      "/Finance/budget.xlsx": "x",
      "/Finance/Receipts/r1.pdf": "x",
      "/Inbox/scan001.pdf": "x",
      "/Inbox/todo.txt": "x",
      "/Photos/2024/img.jpg": "x",
      "/Projects/site/index.html": "x",
    });

  it("defaults to the drive root, two levels deep", () => {
    const { tool } = toolsFor();
    const folderTree = tool("folder_tree");

    expect(folderTree.schema.parse({})).toEqual({ path: "/", depth: 2 });
    expect(folderTree.spec.inputSchema).not.toHaveProperty("required");
    expect(activityOf(folderTree, {})).toBe("Looked through /");
    expect(() => folderTree.schema.parse({ depth: 5 })).toThrow();
  });

  it("renders nested folders with counts, sample names and the selection, without opening selected folders", async () => {
    const storage = tree();
    const list = vi.spyOn(storage, "list");
    const { tool } = toolsFor({ storage, selected: ["/Inbox/scan001.pdf", "/Projects"] });

    const output = await runTool(tool("folder_tree"), {});

    expect(output).toBe(
      [
        "/ 4 folders, 1 files: notes.md",
        "  Finance/ 1 folders, 1 files: budget.xlsx",
        "    Receipts/",
        "  Inbox/ 0 folders, 2 files: scan001.pdf (selected), todo.txt",
        "  Photos/ 1 folders, 0 files",
        "    2024/",
        "  Projects/ (selected)",
      ].join("\n"),
    );
    expect(list.mock.calls.map(([path]) => path).sort()).toEqual([
      "/",
      "/Finance",
      "/Inbox",
      "/Photos",
    ]);
  });

  it("labels a starting subfolder by its full path and shows the level beyond depth by name only", async () => {
    const { tool } = toolsFor({ storage: tree() });

    const output = await runTool(tool("folder_tree"), { path: "Finance/", depth: 1 });

    expect(output).toBe(["/Finance/ 1 folders, 1 files: budget.xlsx", "  Receipts/"].join("\n"));
  });

  it("does not open a selected starting folder", async () => {
    const storage = tree();
    const list = vi.spyOn(storage, "list");
    const { tool } = toolsFor({ storage, selected: ["/Projects"] });

    expect(await runTool(tool("folder_tree"), { path: "/Projects" })).toBe("/Projects/ (selected)");
    expect(list).not.toHaveBeenCalled();
  });

  it("names only selected files when other file names are withheld, keeping every count", async () => {
    const storage = tree();
    const { tool } = toolsFor({
      storage,
      selected: ["/Inbox/scan001.pdf", "/Projects"],
      share: NAMES_WITHHELD,
    });

    const output = await runTool(tool("folder_tree"), {});

    expect(output).toBe(
      [
        "/ 4 folders, 1 files",
        "  Finance/ 1 folders, 1 files",
        "    Receipts/",
        "  Inbox/ 0 folders, 2 files: scan001.pdf (selected), … +1",
        "  Photos/ 1 folders, 0 files",
        "    2024/",
        "  Projects/ (selected)",
      ].join("\n"),
    );
    expect(output).not.toContain("notes.md");
    expect(output).not.toContain("todo.txt");
  });

  it("shows at most six sample file names", async () => {
    const storage = createMemoryStorage(manyFiles(9, (n) => `/Bulk/f${n}.txt`));
    const { tool } = toolsFor({ storage });

    const output = await runTool(tool("folder_tree"), { path: "/Bulk" });

    expect(output).toBe(
      "/Bulk/ 0 folders, 9 files: f0000.txt, f0001.txt, f0002.txt, f0003.txt, f0004.txt, f0005.txt, … +3",
    );
  });

  it("hides Trash from the tree and refuses to start inside it", async () => {
    const storage = createMemoryStorage({ "/.Trash/old.txt": "x", "/Docs/a.txt": "x" });
    const list = vi.spyOn(storage, "list");
    const { tool } = toolsFor({ storage, mcp: { trashPathForStorage: () => "/.Trash" } });

    expect(await runTool(tool("folder_tree"), {})).toBe(
      ["/ 1 folders, 0 files", "  Docs/ 0 folders, 1 files: a.txt"].join("\n"),
    );
    expect(list.mock.calls.map(([path]) => path)).not.toContain("/.Trash");
    await expect(runTool(tool("folder_tree"), { path: "/.Trash" })).rejects.toThrow(
      new OrganizeToolError("That folder is the Trash."),
    );
    await expect(runTool(tool("folder_tree"), { path: "/.Trash/nested" })).rejects.toBeInstanceOf(
      OrganizeToolError,
    );
  });

  it("falls back to the configured Trash path when the storage has none of its own", async () => {
    const storage = createMemoryStorage({ "/.Trash/old.txt": "x" });
    const { tool } = toolsFor({
      storage,
      mcp: { trashPathForStorage: () => null, trashPath: "/.Trash" },
    });

    await expect(runTool(tool("folder_tree"), { path: "/.Trash" })).rejects.toThrow(
      "That folder is the Trash.",
    );
  });

  it("opens a folder named like Trash when no Trash is configured", async () => {
    const storage = createMemoryStorage({ "/.Trash/old.txt": "x" });
    const { tool } = toolsFor({ storage });

    expect(await runTool(tool("folder_tree"), { path: "/.Trash" })).toBe(
      "/.Trash/ 0 folders, 1 files: old.txt",
    );
  });

  it("reports folders that cannot be listed inline", async () => {
    const memory = createMemoryStorage({ "/Locked/a.txt": "x", "/Odd/b.txt": "x" });
    const storage: StorageProvider = {
      ...memory,
      list: async (path) => {
        if (path === "/Locked") throw new StorageError("forbidden", "permission denied");
        if (path === "/Odd") throw "not an Error";
        return memory.list(path);
      },
    };
    const { tool } = toolsFor({ storage });

    expect(await runTool(tool("folder_tree"), {})).toBe(
      [
        "/ 2 folders, 0 files",
        "  Locked/ (permission denied)",
        "  Odd/ (could not be listed)",
      ].join("\n"),
    );
    expect(await runTool(tool("folder_tree"), { path: "/Missing" })).toBe(
      "/Missing/ (not found: /Missing)",
    );
  });

  it(`stops opening folders after ${TREE_LISTING_BUDGET} listings`, async () => {
    const storage = createMemoryStorage(manyFiles(200, (n) => `/d${n}/x.txt`));
    const list = vi.spyOn(storage, "list");
    const { tool } = toolsFor({ storage });

    const lines = (await runTool(tool("folder_tree"), { depth: 3 })).split("\n");

    expect(list).toHaveBeenCalledTimes(TREE_LISTING_BUDGET);
    expect(lines[0]).toBe("/ 200 folders, 0 files");
    expect(lines[1]).toBe("  d0000/ 0 folders, 1 files: x.txt");
    expect(lines[TREE_LISTING_BUDGET - 1]).toBe("  d0148/ 0 folders, 1 files: x.txt");
    expect(lines[TREE_LISTING_BUDGET]).toBe("  d0149/");
    expect(lines).toHaveLength(202);
    expect(lines.at(-1)).toBe(
      `(Stopped opening folders after ${TREE_LISTING_BUDGET}; call folder_tree on a subfolder for more.)`,
    );
  });

  it(`truncates output after ${TREE_MAX_LINES} lines`, async () => {
    const storage = createMemoryStorage(manyFiles(1000, (n) => `/d${n}/x.txt`));
    const { tool } = toolsFor({ storage });

    const lines = (await runTool(tool("folder_tree"), { depth: 1 })).split("\n");

    expect(lines).toHaveLength(TREE_MAX_LINES + 1);
    expect(lines[TREE_MAX_LINES - 1]).toBe("  d0798/");
    expect(lines.at(-1)).toBe("(Output truncated; call folder_tree on a subfolder for more.)");
  });

  it("rejects a path that is not valid", async () => {
    const { tool } = toolsFor();

    await expect(runTool(tool("folder_tree"), { path: "/bad\0path" })).rejects.toThrow(
      new OrganizeToolError('"/bad\0path" is not a valid path.'),
    );
  });

  it("stops when the run is cancelled", async () => {
    const storage = tree();
    const list = vi.spyOn(storage, "list");
    const { tool } = toolsFor({ storage });
    const controller = new AbortController();
    controller.abort();

    await expect(runTool(tool("folder_tree"), {}, controller.signal)).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
  });
});

describe("list_folder", () => {
  it("lists folders first, then files with size and date, marking the selection", async () => {
    const storage = createMemoryStorage({
      "/Mixed/zeta.txt": "hello",
      "/Mixed/Beta/x.txt": "x",
      "/Mixed/alpha.pdf": "a".repeat(2048),
      "/Mixed/Archive/y.txt": "y",
      "/Mixed/beta.txt": "b",
    });
    const { tool } = toolsFor({ storage, selected: ["/Mixed/Beta", "/Mixed/zeta.txt"] });
    const listFolder = tool("list_folder");

    expect(activityOf(listFolder, { path: "/Mixed" })).toBe("Opened /Mixed");
    expect(await runTool(listFolder, { path: "Mixed" })).toBe(
      [
        "/Mixed: 5 entries",
        "Archive/",
        "Beta/ (selected)",
        "alpha.pdf (2.0 KB, 1970-01-01)",
        "beta.txt (1 B, 1970-01-01)",
        "zeta.txt (5 B, 1970-01-01) (selected)",
      ].join("\n"),
    );
  });

  it("counts other files instead of naming them when other file names are withheld", async () => {
    const storage = createMemoryStorage({
      "/Mixed/zeta.txt": "hello",
      "/Mixed/Beta/x.txt": "x",
      "/Mixed/alpha.pdf": "a".repeat(2048),
      "/Mixed/Archive/y.txt": "y",
      "/Mixed/beta.txt": "b",
    });
    const { tool } = toolsFor({
      storage,
      selected: ["/Mixed/Beta", "/Mixed/zeta.txt"],
      share: NAMES_WITHHELD,
    });

    expect(await runTool(tool("list_folder"), { path: "/Mixed" })).toBe(
      [
        "/Mixed: 5 entries",
        "Archive/",
        "Beta/ (selected)",
        "zeta.txt (5 B, 1970-01-01) (selected)",
        "(2 other files, names not shared)",
      ].join("\n"),
    );
    const { tool: single } = toolsFor({
      storage: createMemoryStorage({ "/One/only.txt": "x" }),
      share: NAMES_WITHHELD,
    });
    expect(await runTool(single("list_folder"), { path: "/One" })).toBe(
      "/One: 1 entries\n(1 other file, names not shared)",
    );
  });

  it("leaves Trash out and refuses to list it", async () => {
    const storage = createMemoryStorage({
      "/.Trash/old.txt": "x",
      "/Docs/a.txt": "x",
      "/top.txt": "x",
    });
    const { tool } = toolsFor({ storage, mcp: { trashPath: "/.Trash" } });

    expect(await runTool(tool("list_folder"), { path: "/" })).toBe(
      ["/: 2 entries", "Docs/", "top.txt (1 B, 1970-01-01)"].join("\n"),
    );
    await expect(runTool(tool("list_folder"), { path: "/.Trash/x" })).rejects.toThrow(
      new OrganizeToolError("That folder is the Trash."),
    );
  });

  it("pages long folders", async () => {
    const storage = createMemoryStorage(manyFiles(250, (n) => `/Big/f${n}.txt`));
    const { tool } = toolsFor({ storage });

    const first = (await runTool(tool("list_folder"), { path: "/Big" })).split("\n");
    expect(first[0]).toBe("/Big: 250 entries");
    expect(first).toHaveLength(202);
    expect(first[200]).toBe("f0199.txt (1 B, 1970-01-01)");
    expect(first.at(-1)).toBe("(More: call again with offset 200.)");

    const second = (await runTool(tool("list_folder"), { path: "/Big", offset: 200 })).split("\n");
    expect(second[0]).toBe("/Big: 250 entries");
    expect(second[1]).toBe("f0200.txt (1 B, 1970-01-01)");
    expect(second).toHaveLength(51);
  });

  it("opens a folder whose accents the model encoded differently", async () => {
    const stored = "/Work/Husarö".normalize("NFD");
    const storage = createMemoryStorage({ [`${stored}/Dokument/old.pdf`]: "x" });
    const { tool } = toolsFor({ storage });

    expect(await runTool(tool("list_folder"), { path: "/Work/Husarö".normalize("NFC") })).toBe(
      [`${stored}: 1 entries`, "Dokument/"].join("\n"),
    );
    expect(
      await runTool(tool("folder_tree"), { path: "/Work/Husarö".normalize("NFC"), depth: 1 }),
    ).toBe(`${stored}/ 1 folders, 0 files\n  Dokument/`);
  });

  it("rejects an invalid path and passes storage errors through", async () => {
    const { tool } = toolsFor();

    await expect(runTool(tool("list_folder"), { path: "\0" })).rejects.toBeInstanceOf(
      OrganizeToolError,
    );
    await expect(runTool(tool("list_folder"), { path: "/Missing" })).rejects.toBeInstanceOf(
      StorageError,
    );
  });
});

describe("read_excerpts", () => {
  /** "/Inbox" maps onto alice's indexed home; "/Archive" onto a root the index has not seen. */
  const EXCERPT_SCOPES: readonly Scope[] = [
    { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/Inbox" },
    { rootName: "archive", fsPrefix: "/", virtualPrefix: "/Archive" },
  ];

  const SELECTED = [
    "/Inbox/scan.pdf",
    "/Inbox/blank.pdf",
    "/Inbox/Folder",
    "/Inbox/private.pdf",
    "/Inbox/unindexed.pdf",
    "/Inbox/moved.pdf",
    "/Archive/old.pdf",
    "/Loose.pdf",
  ];

  function indexedFile(id: number, path: string, textStatus = "done"): IndexedFile {
    return {
      id,
      rootId: 1,
      path,
      name: baseName(path),
      ext: ".pdf",
      size: 10,
      mtimeNs: 0n,
      sha256: null,
      mime: null,
      textStatus,
      textChars: 0,
      error: null,
      indexedAt: null,
      deletedAt: null,
    };
  }

  const FILES: Record<string, IndexedFile> = {
    "alice/scan.pdf": indexedFile(1, "alice/scan.pdf"),
    "alice/blank.pdf": indexedFile(2, "alice/blank.pdf", "empty"),
    "alice/Folder/inner.txt": indexedFile(3, "alice/Folder/inner.txt"),
    "alice/private.pdf": indexedFile(4, "alice/private.pdf"),
    // The row that answers for this path claims to live elsewhere.
    "alice/moved.pdf": indexedFile(5, "alice/elsewhere/moved.pdf"),
  };

  const TEXT: Record<number, string> = {
    1: "  Invoice from ACME  ",
    2: "   ",
    3: "inner text",
    4: "secret",
  };

  function excerptSetup(overrides: Partial<McpToolDeps> = {}) {
    const memory = createMemoryStorage({
      "/Inbox/scan.pdf": "x",
      "/Inbox/blank.pdf": "x",
      "/Inbox/Folder/inner.txt": "x",
      "/Inbox/private.pdf": "x",
      "/Inbox/moved.pdf": "x",
    });
    const storage: StorageProvider = {
      ...memory,
      download: async (path, opts) => {
        if (path === "/Inbox/private.pdf") throw new StorageError("forbidden", "denied");
        return memory.download(path, opts);
      },
    };
    const fileByPath = vi.fn(async (rootId: number, path: string) => {
      expect(rootId).toBe(1);
      return FILES[path] ?? null;
    });
    const fileTextPrefix = vi.fn(async (id: number, chars: number) => {
      expect(chars).toBe(EXCERPT_CHARS);
      return TEXT[id] ?? "";
    });
    const identitiesGet = vi.fn(async () => buildIdentity());
    const setup = toolsFor({
      storage,
      selected: SELECTED,
      mcp: {
        indexQueries: {
          rootIdsByName: async () => ({ sftpgo: 1 }),
          fileByPath,
          fileTextPrefix,
        } as unknown as IndexQueries,
        identities: { get: identitiesGet },
        scopeResolver: {
          verifiedIndexScopes: async () => ({ available: true, scopes: EXCERPT_SCOPES }),
        },
        ...overrides,
      },
    });
    return { ...setup, fileByPath, fileTextPrefix, identitiesGet };
  }

  it("accepts between 1 and 25 paths and describes what it reads", () => {
    const { tool } = excerptSetup();
    const readExcerpts = tool("read_excerpts");

    expect(activityOf(readExcerpts, { paths: ["/Inbox/scan.pdf"] })).toBe("Read scan.pdf");
    expect(activityOf(readExcerpts, { paths: ["/a", "/b"] })).toBe("Read 2 files");
    expect(() => readExcerpts.schema.parse({ paths: [] })).toThrow();
    expect(() =>
      readExcerpts.schema.parse({ paths: Array.from({ length: 26 }, (_, i) => `/f${i}`) }),
    ).toThrow();
  });

  it("returns the trimmed start of each selected file's text, including files inside a selected folder", async () => {
    const { tool } = excerptSetup();

    const output = await runTool(tool("read_excerpts"), {
      paths: ["Inbox/scan.pdf", "/Inbox/blank.pdf", "/Inbox/Folder/inner.txt"],
    });

    expect(output).toBe(
      [
        "### /Inbox/scan.pdf\nInvoice from ACME",
        "### /Inbox/blank.pdf\n(No extracted text; status: empty.)",
        "### /Inbox/Folder/inner.txt\ninner text",
      ].join("\n\n"),
    );
  });

  it("reads a selected file whose accents the model encoded differently", async () => {
    const stored = "/Inbox/Årsmöte.pdf".normalize("NFD");
    const memory = createMemoryStorage({ [stored]: "x" });
    const fileByPath = vi.fn(async (_rootId: number, path: string) =>
      path === `alice/${baseName(stored)}` ? indexedFile(6, path) : null,
    );
    const { tool } = toolsFor({
      storage: memory,
      selected: [stored],
      mcp: {
        indexQueries: {
          rootIdsByName: async () => ({ sftpgo: 1 }),
          fileByPath,
          fileTextPrefix: async () => "Protokoll",
        } as unknown as IndexQueries,
        scopeResolver: {
          verifiedIndexScopes: async () => ({ available: true, scopes: EXCERPT_SCOPES }),
        },
      },
    });

    expect(await runTool(tool("read_excerpts"), { paths: [stored.normalize("NFC")] })).toBe(
      `### ${stored}\nProtokoll`,
    );
  });

  it("refuses paths that are invalid or outside the selection", async () => {
    const { tool, fileByPath } = excerptSetup();

    const output = await runTool(tool("read_excerpts"), {
      paths: ["/bad\0path", "/Inbox/other.pdf", "/Inbox"],
    });

    expect(output).toBe(
      [
        "### /bad\0path\n(Not a valid path.)",
        "### /Inbox/other.pdf\n(Not a selected item; only selected items can be read.)",
        "### /Inbox\n(Not a selected item; only selected items can be read.)",
      ].join("\n\n"),
    );
    expect(fileByPath).not.toHaveBeenCalled();
  });

  it("reports selected files it cannot tie to a readable index row as not indexed", async () => {
    const { tool, fileTextPrefix } = excerptSetup();

    const output = await runTool(tool("read_excerpts"), {
      paths: [
        "/Loose.pdf",
        "/Archive/old.pdf",
        "/Inbox/unindexed.pdf",
        "/Inbox/moved.pdf",
        "/Inbox/private.pdf",
      ],
    });

    expect(output).toBe(
      [
        "### /Loose.pdf\n(Not indexed.)",
        "### /Archive/old.pdf\n(Not indexed.)",
        "### /Inbox/unindexed.pdf\n(Not indexed.)",
        "### /Inbox/moved.pdf\n(Not indexed.)",
        "### /Inbox/private.pdf\n(Not indexed.)",
      ].join("\n\n"),
    );
    expect(fileTextPrefix).not.toHaveBeenCalled();
  });

  it("resolves the identity's scope once across calls", async () => {
    const { tool, identitiesGet } = excerptSetup();
    const readExcerpts = tool("read_excerpts");

    await runTool(readExcerpts, { paths: ["/Inbox/scan.pdf"] });
    await runTool(readExcerpts, { paths: ["/Inbox/blank.pdf"] });

    expect(identitiesGet).toHaveBeenCalledTimes(1);
  });

  const UNAVAILABLE = "Extracted text is not available for this drive.";

  it("is not available when the identity no longer exists", async () => {
    const verifiedIndexScopes = vi.fn();
    const { tool, fileByPath } = excerptSetup({
      identities: { get: async () => null },
      scopeResolver: { verifiedIndexScopes },
    });

    expect(await runTool(tool("read_excerpts"), { paths: ["/Inbox/scan.pdf"] })).toBe(UNAVAILABLE);
    expect(verifiedIndexScopes).not.toHaveBeenCalled();
    expect(fileByPath).not.toHaveBeenCalled();
  });

  it("is not available when the identity's index scopes are unverified", async () => {
    const { tool } = excerptSetup({
      scopeResolver: {
        verifiedIndexScopes: async () => ({ available: false, reason: "indexer_unreachable" }),
      },
    });

    expect(await runTool(tool("read_excerpts"), { paths: ["/Inbox/scan.pdf"] })).toBe(UNAVAILABLE);
  });

  it("is not available when none of the scopes land on an indexed root", async () => {
    const { tool } = excerptSetup({
      indexQueries: { rootIdsByName: async () => ({}) } as unknown as IndexQueries,
    });

    expect(await runTool(tool("read_excerpts"), { paths: ["/Inbox/scan.pdf"] })).toBe(UNAVAILABLE);
  });
});

function searchHit(path: string) {
  return {
    path,
    url: path,
    name: baseName(path),
    ext: ".pdf",
    size_bytes: 1,
    modified: "2026-01-01T00:00:00.000Z",
    score: 1,
    snippets: [],
  };
}

function similarHit(path: string) {
  return {
    path,
    url: path,
    name: baseName(path),
    ext: ".pdf",
    size_bytes: 1,
    modified: "2026-01-01T00:00:00.000Z",
    sha256: null,
    text_status: "done",
    text_chars: 0,
    similarity: 0.9,
  };
}

describe("search_drive", () => {
  beforeEach(() => {
    vi.mocked(runSearch).mockReset();
  });

  it("describes the search and requires a query", () => {
    const { tool } = toolsFor();

    expect(activityOf(tool("search_drive"), { query: "invoice" })).toBe("Searched for “invoice”");
    expect(() => tool("search_drive").schema.parse({ query: "" })).toThrow();
  });

  it("says so when search is unavailable", async () => {
    vi.mocked(runSearch).mockResolvedValue({
      query: "invoice",
      results: [],
      available: false,
      unavailable: true,
    });
    const { tool } = toolsFor();

    expect(await runTool(tool("search_drive"), { query: "invoice" })).toBe(
      "Search is not available right now.",
    );
  });

  it("groups hits by folder, busiest first, leaving out the selection", async () => {
    vi.mocked(runSearch).mockResolvedValue({
      query: "invoice",
      results: [
        searchHit("/Finance/2023/a.pdf"),
        searchHit("/Inbox/invoice.pdf"),
        searchHit("/Finance/2024/b.pdf"),
        searchHit("/Finance/2024/c.pdf"),
        searchHit("/Projects/site/invoice.html"),
        searchHit("/Finance/2024/d.pdf"),
        searchHit("/Finance/2024/e.pdf"),
        searchHit("/Finance/2024/f.pdf"),
        searchHit("/Finance/2024/g.pdf"),
      ],
    });
    const { tool, mcp, principal } = toolsFor({ selected: ["/Inbox/invoice.pdf", "/Projects"] });

    const output = await runTool(tool("search_drive"), { query: "invoice" });

    expect(output).toBe(
      [
        "/Finance/2024: 6 matches (b.pdf, c.pdf, d.pdf, e.pdf, f.pdf)",
        "/Finance/2023: 1 match (a.pdf)",
      ].join("\n"),
    );
    expect(runSearch).toHaveBeenCalledWith(mcp, principal, { query: "invoice", limit: 50 });
  });

  it("reports only counts per folder when other file names are withheld", async () => {
    vi.mocked(runSearch).mockResolvedValue({
      query: "invoice",
      results: [
        searchHit("/Finance/2023/a.pdf"),
        searchHit("/Finance/2024/b.pdf"),
        searchHit("/Finance/2024/c.pdf"),
      ],
    });
    const { tool } = toolsFor({ share: NAMES_WITHHELD });

    expect(await runTool(tool("search_drive"), { query: "invoice" })).toBe(
      ["/Finance/2024: 2 matches", "/Finance/2023: 1 match"].join("\n"),
    );
  });

  it("reports when every hit is part of the selection", async () => {
    vi.mocked(runSearch).mockResolvedValue({
      query: "invoice",
      results: [searchHit("/Inbox/invoice.pdf")],
    });
    const { tool } = toolsFor({ selected: ["/Inbox/invoice.pdf"] });

    expect(await runTool(tool("search_drive"), { query: "invoice" })).toBe(
      "No related files outside the selection.",
    );
  });
});

describe("similar_files", () => {
  beforeEach(() => {
    vi.mocked(runSimilarFiles).mockReset();
  });

  it("describes the comparison", () => {
    const { tool } = toolsFor();

    expect(activityOf(tool("similar_files"), { path: "/Inbox/scan.pdf" })).toBe(
      "Compared scan.pdf with similar files",
    );
  });

  it("only compares selected items", async () => {
    const { tool } = toolsFor({ selected: ["/Inbox/scan.pdf"] });

    await expect(runTool(tool("similar_files"), { path: "/Finance/a.pdf" })).rejects.toThrow(
      new OrganizeToolError("Only selected items can be compared."),
    );
    await expect(runTool(tool("similar_files"), { path: "/bad\0" })).rejects.toBeInstanceOf(
      OrganizeToolError,
    );
    expect(runSimilarFiles).not.toHaveBeenCalled();
  });

  it("compares a selected file whose accents the model encoded differently", async () => {
    const stored = "/Drop/Kårstämma.pdf".normalize("NFD");
    vi.mocked(runSimilarFiles).mockResolvedValue({ path: stored, results: [] });
    const { tool, mcp, principal } = toolsFor({
      storage: createMemoryStorage({ [stored]: "x" }),
      selected: [stored],
    });

    await runTool(tool("similar_files"), { path: stored.normalize("NFC") });

    expect(runSimilarFiles).toHaveBeenCalledWith(mcp, principal, { path: stored, limit: 20 });
  });

  it("groups similar files by folder, leaving out the selection", async () => {
    vi.mocked(runSimilarFiles).mockResolvedValue({
      path: "/Inbox/Scans/scan.pdf",
      results: [
        similarHit("/Finance/Receipts/r1.pdf"),
        similarHit("/Inbox/Scans/other.pdf"),
        similarHit("/Finance/Receipts/r2.pdf"),
        similarHit("/Taxes/2024.pdf"),
      ],
    });
    const { tool, mcp, principal } = toolsFor({ selected: ["/Inbox/Scans"] });

    const output = await runTool(tool("similar_files"), { path: "Inbox/Scans/scan.pdf" });

    expect(output).toBe(
      ["/Finance/Receipts: 2 matches (r1.pdf, r2.pdf)", "/Taxes: 1 match (2024.pdf)"].join("\n"),
    );
    expect(runSimilarFiles).toHaveBeenCalledWith(mcp, principal, {
      path: "/Inbox/Scans/scan.pdf",
      limit: 20,
    });
  });
});
