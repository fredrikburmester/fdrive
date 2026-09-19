import { createHash } from "node:crypto";
import type { ChatActionProposal } from "@fdrive/contracts";
import type { StorageProvider, TrashProvider } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import type { IndexQueries } from "@fdrive/db";
import { describe, expect, it, vi } from "vitest";
import { activityFixture } from "../../../test/activity-fixture.js";
import type { Principal } from "../../auth/principal.js";
import { type BusEvent, createEventBus } from "../../events/bus.js";
import type { McpToolDeps } from "../../mcp/handlers.js";
import { buildIdentity } from "../../scoping/test-fixtures/index.ts";
import { type ActionTool, createChatActionTools, MAX_WRITE_BYTES } from "./action-tools.ts";

const IDENTITY = "223e4567-e89b-42d3-a456-426614174000";
const CONVERSATION = "323e4567-e89b-42d3-a456-426614174000";

function setup(
  options: { files?: Record<string, string>; referenced?: string[]; trash?: boolean } = {},
) {
  const base = createMemoryStorage(
    options.files ?? {
      "/Inbox/a.txt": "hello",
      "/Inbox/scan.pdf": "%PDF",
      "/Docs/readme.md": "# Hi",
      "/Docs/taken.txt": "x",
    },
  );
  const storage: StorageProvider = options.trash
    ? Object.assign(base, { trash: {} as TrashProvider })
    : base;
  const principal: Principal = {
    accountId: "a",
    identityId: IDENTITY,
    username: "alice",
    storage,
    isAdmin: false,
  };
  const mcp: McpToolDeps = {
    indexQueries: {} as IndexQueries,
    searchService: { search: async () => Promise.reject(new Error("unexpected")) },
    scopeResolver: {
      verifiedIndexScopes: async () => ({ available: false, reason: "no_connection" as const }),
    },
    identities: { get: async () => buildIdentity() },
    publicUrl: async () => null,
    indexerClient: null,
    writesEnabled: false,
    clock: () => new Date("2026-09-18T10:00:00.000Z"),
    ...(options.trash ? { trashPathForStorage: () => "/.Trash" } : {}),
  };
  const bus = createEventBus();
  const events: BusEvent[] = [];
  bus.subscribe({ identityId: IDENTITY }, (event) => events.push(event));
  const activity = activityFixture(() => new Date("2026-09-18T10:00:00.000Z"));
  const tools = createChatActionTools({
    mcp,
    principal,
    focus: {
      paths: new Set(options.referenced ?? ["/Inbox", "/Docs/readme.md"]),
      adjective: "referenced",
      group: "the references",
      openFolders: true,
    },
    indexed: false,
    conversationId: CONVERSATION,
    fs: {
      bus,
      clock: () => new Date("2026-09-18T10:00:00.000Z"),
      activity: activity.service,
      ...(options.trash ? { trashPathForStorage: () => "/.Trash" } : {}),
    },
  });
  const tool = (name: string): ActionTool => {
    const found = tools.find((candidate) => candidate.spec.name === name);
    if (found === undefined) throw new Error(`no tool ${name}`);
    return found;
  };
  const verify = (name: string, args: unknown) =>
    tool(name).verify(tool(name).schema.parse(args), new AbortController().signal);
  const apply = (
    name: string,
    proposal: ChatActionProposal,
    edits?: Parameters<ActionTool["apply"]>[1],
  ) => tool(name).apply(proposal, edits, new AbortController().signal);
  return { storage, tools, tool, verify, apply, events, activity };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("createChatActionTools", () => {
  it("offers trash only where the login has a Trash", () => {
    expect(setup().tools.map((tool) => tool.spec.name)).toEqual(["move_items", "write_text_file"]);
    expect(setup({ trash: true }).tools.map((tool) => tool.spec.name)).toEqual([
      "move_items",
      "trash_items",
      "write_text_file",
    ]);
  });
});

describe("move_items", () => {
  it("verifies moves like Organize does and applies the ones the person kept", async () => {
    const { verify, apply, storage, events, tool } = setup();
    expect(
      tool("move_items").activity({
        summary: "",
        moves: [{ path: "/Inbox/a.txt", destination: "/x", reason: "" }],
      }),
    ).toBe("Proposed moving a.txt");

    const proposal = await verify("move_items", {
      summary: "File them.",
      moves: [
        { path: "/Inbox/a.txt", destination: "/Docs", reason: "It is a note." },
        { path: "/Inbox/scan.pdf", destination: "/Archive/2024", reason: "Old scan." },
        { path: "/Inbox/a.txt", destination: "/Inbox", reason: "Same folder." },
      ],
    });
    expect(proposal).toMatchObject({
      kind: "move",
      summary: "File them.",
      suggestions: [
        { path: "/Inbox/a.txt", target: "/Docs/a.txt", conflict: false, newFolder: false },
        { path: "/Inbox/scan.pdf", target: "/Archive/2024/scan.pdf", newFolder: true },
      ],
    });

    const outcome = await apply("move_items", proposal, {
      moves: [
        { path: "/Inbox/a.txt", target: "/Docs/notes/a.txt" },
        { path: "/Docs/readme.md", target: "/elsewhere.md" },
      ],
    });
    expect(outcome).toEqual({
      outcome: "Moved 1 item.",
      results: [{ path: "/Inbox/a.txt", ok: true, target: "/Docs/notes/a.txt" }],
      toolResult: "Moved /Inbox/a.txt to /Docs/notes/a.txt",
    });
    await expect(storage.stat("/Docs/notes/a.txt")).resolves.toBeDefined();
    await expect(storage.stat("/Docs/readme.md")).resolves.toBeDefined();
    expect(events.map((event) => event.type === "fs" && event.op)).toEqual(["mkdir", "move"]);
  });

  it("applies every non-conflicting suggestion by default and reports failures", async () => {
    const { verify, apply, storage } = setup({
      files: { "/Inbox/a.txt": "a", "/Docs/a.txt": "taken" },
    });
    const proposal = await verify("move_items", {
      summary: "s",
      moves: [{ path: "/Inbox/a.txt", destination: "/Docs", reason: "r" }],
    });
    expect(proposal).toMatchObject({ kind: "move", suggestions: [{ conflict: true }] });

    expect(await apply("move_items", proposal)).toEqual({
      outcome: "Nothing was moved.",
      results: [],
      toolResult: "The person kept no moves.",
    });
    await storage.upload("/Docs/b.txt", Buffer.from("b"), { overwrite: false, contentLength: 1 });
    const forced = await apply("move_items", proposal, {
      moves: [{ path: "/Inbox/a.txt", target: "/Docs/a.txt" }],
    });
    expect(forced.outcome).toBe("Moved 0 of 1 items.");
    expect(forced.results[0]).toMatchObject({ ok: false, path: "/Inbox/a.txt" });
  });

  it("refuses items outside the references and proposals with nothing usable", async () => {
    const { verify } = setup();
    await expect(
      verify("move_items", {
        summary: "s",
        moves: [{ path: "/Docs/taken.txt", destination: "/Inbox", reason: "r" }],
      }),
    ).rejects.toThrow(/not referenced/);
    await expect(
      verify("move_items", {
        summary: "s",
        moves: [{ path: "/Inbox/a.txt", destination: "/Inbox", reason: "r" }],
      }),
    ).rejects.toThrow(/^Nothing could be proposed: \/Inbox\/a\.txt: /);
  });
});

describe("trash_items", () => {
  it("verifies referenced items with their kinds and trashes the ones kept", async () => {
    const { verify, apply, storage, events } = setup({
      trash: true,
      referenced: ["/Inbox", "/Docs"],
    });

    const proposal = await verify("trash_items", {
      summary: "Old.",
      items: [
        { path: "/Inbox/a.txt", reason: "empty" },
        { path: "/Docs", reason: "unused" },
        { path: "/Inbox/a.txt", reason: "again" },
      ],
    });
    expect(proposal).toEqual({
      kind: "trash",
      summary: "Old.",
      items: [
        { path: "/Inbox/a.txt", kind: "file", reason: "empty" },
        { path: "/Docs", kind: "dir", reason: "unused" },
      ],
    });

    const outcome = await apply("trash_items", proposal, {
      paths: ["/Inbox/a.txt", "/Inbox/scan.pdf"],
    });
    expect(outcome).toEqual({
      outcome: "Moved 1 item to Trash.",
      results: [{ path: "/Inbox/a.txt", ok: true }],
      toolResult: "Trashed /Inbox/a.txt",
    });
    await expect(storage.stat("/Inbox/a.txt")).rejects.toMatchObject({ kind: "not_found" });
    await expect(storage.stat("/Docs")).resolves.toBeDefined();
    expect(events.map((event) => event.type === "fs" && event.op)).toEqual(["delete"]);
    expect(await apply("trash_items", proposal, { paths: [] })).toMatchObject({
      outcome: "Nothing was trashed.",
    });
  });

  it("refuses the root, the Trash and items that are not referenced", async () => {
    const { verify } = setup({ trash: true, referenced: ["/"] });
    await expect(
      verify("trash_items", { summary: "s", items: [{ path: "/", reason: "r" }] }),
    ).rejects.toThrow(/root/);
    await expect(
      verify("trash_items", { summary: "s", items: [{ path: "/.Trash/x", reason: "r" }] }),
    ).rejects.toThrow(/Trash/);
    const narrow = setup({ trash: true, referenced: ["/Docs"] });
    await expect(
      narrow.verify("trash_items", {
        summary: "s",
        items: [{ path: "/Inbox/a.txt", reason: "r" }],
      }),
    ).rejects.toThrow(/not referenced/);
  });
});

describe("write_text_file", () => {
  it("proposes a new text file beside a referenced item and creates it", async () => {
    const { verify, apply, storage, events } = setup({ referenced: ["/Inbox/scan.pdf"] });

    const proposal = await verify("write_text_file", {
      summary: "A readable version.",
      path: "/Inbox/scan.md",
      mode: "create",
      text: "# Scan\n\nHello.",
    });
    expect(proposal).toEqual({
      kind: "write",
      summary: "A readable version.",
      path: "/Inbox/scan.md",
      mode: "create",
      text: "# Scan\n\nHello.",
      expectedSha256: null,
    });

    expect(await apply("write_text_file", proposal, { path: "/Inbox/scan-notes.md" })).toEqual({
      outcome: "Created /Inbox/scan-notes.md.",
      results: [{ path: "/Inbox/scan-notes.md", ok: true, target: "/Inbox/scan-notes.md" }],
      toolResult: "Created /Inbox/scan-notes.md.",
    });
    expect((await storage.stat("/Inbox/scan-notes.md")).size).toBe(14);
    expect(events.map((event) => event.type === "fs" && event.op)).toEqual(["create"]);
    // A second apply of the same card finds the name taken and reports it instead of throwing.
    expect(
      await apply("write_text_file", proposal, { path: "/Inbox/scan-notes.md" }),
    ).toMatchObject({
      results: [{ path: "/Inbox/scan-notes.md", ok: false }],
    });
  });

  it("replaces a referenced text file only with the hash it was read at", async () => {
    const { verify, apply, storage, events } = setup();
    const current = sha("# Hi");

    await expect(
      verify("write_text_file", {
        summary: "s",
        path: "/Docs/readme.md",
        mode: "replace",
        text: "new",
      }),
    ).rejects.toThrow(/Read the file first/);
    await expect(
      verify("write_text_file", {
        summary: "s",
        path: "/Docs/readme.md",
        mode: "replace",
        text: "new",
        expected_sha256: "stale",
      }),
    ).rejects.toThrow(/changed since it was read/);
    const proposal = await verify("write_text_file", {
      summary: "Friendlier.",
      path: "/Docs/readme.md",
      mode: "replace",
      text: "# Hello there",
      expected_sha256: current,
    });
    expect(proposal).toMatchObject({ kind: "write", mode: "replace", expectedSha256: current });

    await storage.upload("/Docs/readme.md", Buffer.from("# Edited meanwhile"), {
      overwrite: true,
      contentLength: 18,
    });
    const stale = await apply("write_text_file", proposal);
    expect(stale.results[0]).toMatchObject({
      ok: false,
      message: expect.stringMatching(/changed since it was read/),
    });

    await storage.upload("/Docs/readme.md", Buffer.from("# Hi"), {
      overwrite: true,
      contentLength: 4,
    });
    expect(await apply("write_text_file", proposal)).toMatchObject({
      outcome: "Replaced /Docs/readme.md.",
    });
    expect(events.map((event) => event.type === "fs" && event.op)).toEqual(["update"]);
  });

  it("refuses binary names, places outside the references, taken names and oversized text", async () => {
    const { verify, tool } = setup({ referenced: ["/Inbox/a.txt"] });
    await expect(
      verify("write_text_file", {
        summary: "s",
        path: "/Inbox/new.pdf",
        mode: "create",
        text: "x",
      }),
    ).rejects.toThrow(/not a text file/);
    await expect(
      verify("write_text_file", { summary: "s", path: "/Docs/new.md", mode: "create", text: "x" }),
    ).rejects.toThrow(/not next to a referenced item/);
    await expect(
      verify("write_text_file", { summary: "s", path: "/Inbox/a.txt", mode: "create", text: "x" }),
    ).rejects.toMatchObject({ kind: "conflict" });
    await expect(
      verify("write_text_file", {
        summary: "s",
        path: "/Inbox/scan.pdf",
        mode: "replace",
        text: "x",
        expected_sha256: "s",
      }),
    ).rejects.toThrow(/not a text file/);
    expect(() =>
      tool("write_text_file").schema.parse({
        summary: "s",
        path: "/Inbox/big.txt",
        mode: "create",
        text: "x".repeat(MAX_WRITE_BYTES + 1),
      }),
    ).toThrow();
    expect(
      tool("write_text_file").activity({
        summary: "",
        path: "/Inbox/a.txt",
        mode: "replace",
        text: "",
      }),
    ).toBe("Rewrote a.txt");
  });
});

describe("action tools: edge cases", () => {
  const trashProposal: ChatActionProposal = { kind: "trash", summary: "s", items: [] };
  const moveProposal: ChatActionProposal = {
    kind: "move",
    summary: "s",
    suggestions: [],
    unchanged: [],
  };

  it("refuses a card of another kind", async () => {
    const { apply } = setup({ trash: true });
    await expect(apply("move_items", trashProposal)).rejects.toThrow("not a move proposal");
    await expect(apply("trash_items", moveProposal)).rejects.toThrow("not a trash proposal");
    await expect(apply("write_text_file", moveProposal)).rejects.toThrow("not a write proposal");
  });

  it("moves every non-conflicting suggestion by default and skips an unusable edited target", async () => {
    const { verify, apply, storage } = setup();
    const proposal = await verify("move_items", {
      summary: "s",
      moves: [{ path: "/Inbox/a.txt", destination: "/Docs", reason: "r" }],
    });

    expect(
      await apply("move_items", proposal, { moves: [{ path: "/Inbox/a.txt", target: "/bad\0" }] }),
    ).toMatchObject({ outcome: "Nothing was moved." });
    expect(await apply("move_items", proposal)).toMatchObject({ outcome: "Moved 1 item." });
    await expect(storage.stat("/Docs/a.txt")).resolves.toBeDefined();
  });

  it("describes a single trashed item", () => {
    const { tool } = setup({ trash: true });
    expect(
      tool("trash_items").activity({ summary: "", items: [{ path: "/Inbox/a.txt", reason: "" }] }),
    ).toBe("Proposed trashing a.txt");
  });

  it("refuses writes to invalid, trashed, folder, oversized and binary targets", async () => {
    const big = "x".repeat(MAX_WRITE_BYTES + 1);
    const { verify } = setup({
      trash: true,
      referenced: ["/Docs", "/Inbox"],
      files: { "/Docs/readme.md": "# Hi", "/Inbox/big.txt": big, "/Inbox/bytes.bin": "\0\x01\x02" },
    });
    await expect(
      verify("write_text_file", { summary: "s", path: "/bad\0", mode: "create", text: "x" }),
    ).rejects.toThrow(/not a valid path/);
    await expect(
      verify("write_text_file", { summary: "s", path: "/.Trash/x.md", mode: "create", text: "x" }),
    ).rejects.toThrow(/Trash/);
    await expect(
      verify("write_text_file", {
        summary: "s",
        path: "/Docs",
        mode: "replace",
        text: "x",
        expected_sha256: "s",
      }),
    ).rejects.toThrow(/is a folder/);
    await expect(
      verify("write_text_file", {
        summary: "s",
        path: "/Inbox/big.txt",
        mode: "replace",
        text: "x",
        expected_sha256: "s",
      }),
    ).rejects.toThrow(/larger than/);
    await expect(
      verify("write_text_file", {
        summary: "s",
        path: "/Inbox/bytes.bin",
        mode: "replace",
        text: "x",
        expected_sha256: "s",
      }),
    ).rejects.toThrow(/not a UTF-8 text file/);
  });

  it("reports a storage failure while writing instead of throwing", async () => {
    const { verify, apply, storage } = setup({ referenced: ["/Inbox/a.txt"] });
    const proposal = await verify("write_text_file", {
      summary: "s",
      path: "/Inbox/new.md",
      mode: "create",
      text: "x",
    });
    vi.spyOn(storage, "upload").mockRejectedValueOnce(new Error("disk full"));

    expect(await apply("write_text_file", proposal)).toEqual({
      outcome: "It failed.",
      results: [{ path: "/Inbox/new.md", ok: false, message: "It failed." }],
      toolResult: "Could not write /Inbox/new.md: It failed.",
    });
  });
});

describe("history for approved chat actions", () => {
  it("records only what the person applied, as the account acting through the chat", async () => {
    const { verify, apply, activity } = setup();

    const proposal = await verify("move_items", {
      summary: "File them.",
      moves: [
        { path: "/Inbox/a.txt", destination: "/Docs", reason: "A note." },
        { path: "/Inbox/scan.pdf", destination: "/Archive", reason: "Old scan." },
      ],
    });
    expect(activity.operations).toEqual([]);

    await apply("move_items", proposal, {
      moves: [{ path: "/Inbox/a.txt", target: "/Docs/a.txt" }],
    });

    expect(activity.operations).toHaveLength(1);
    expect(activity.operations[0]).toMatchObject({
      action: "file.move",
      source: "ai",
      requested: {
        path: "/Inbox/a.txt",
        targetPath: "/Docs/a.txt",
        conversationId: CONVERSATION,
      },
    });
    expect(activity.outcomes.at(-1)).toMatchObject({ outcome: "success" });
  });

  it("records a trash and a written file with the same provenance", async () => {
    const { verify, apply, activity } = setup({ trash: true, referenced: ["/Inbox/a.txt"] });

    await apply(
      "trash_items",
      await verify("trash_items", {
        summary: "Clear it.",
        items: [{ path: "/Inbox/a.txt", reason: "Done with it." }],
      }),
    );
    await apply(
      "write_text_file",
      await verify("write_text_file", {
        summary: "Note it.",
        path: "/Inbox/new.md",
        mode: "create",
        text: "x",
      }),
    );

    expect(activity.operations.map((operation) => [operation.action, operation.source])).toEqual([
      ["file.trash", "ai"],
      ["file.create", "ai"],
    ]);
    expect(activity.operations.every((o) => o.requested.conversationId === CONVERSATION)).toBe(
      true,
    );
  });

  it("records a failed write rather than a silent one", async () => {
    const { verify, apply, storage, activity } = setup({ referenced: ["/Inbox/a.txt"] });
    const proposal = await verify("write_text_file", {
      summary: "s",
      path: "/Inbox/new.md",
      mode: "create",
      text: "x",
    });
    vi.spyOn(storage, "upload").mockRejectedValueOnce(new Error("disk full"));

    await apply("write_text_file", proposal);

    expect(activity.outcomes.at(-1)).toMatchObject({
      action: "file.create",
      outcome: "unknown",
      errorCode: "outcome_unconfirmed",
    });
  });
});
