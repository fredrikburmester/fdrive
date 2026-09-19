import type { Chat, ChatPart } from "@fdrive/contracts";
import { type Scope, StorageError, type StorageProvider, type TrashProvider } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import type { IndexQueries, Repos } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../../auth/principal.js";
import { ApiHttpError } from "../../errors.js";
import { createEventBus } from "../../events/bus.js";
import type { McpToolDeps } from "../../mcp/handlers.js";
import { createMetadataService } from "../../metadata/service.js";
import { buildIdentity } from "../../scoping/test-fixtures/index.ts";
import type { AiInput, AiModel, AiStartOptions, AiTurn } from "../model.ts";
import type { ResolvedAiConfig } from "../settings.ts";
import { type ChatService, createChatService, titleFrom } from "./service.ts";

const CONFIG: ResolvedAiConfig = {
  provider: "anthropic",
  model: "claude-opus-5",
  baseUrl: null,
  apiKey: "sk",
  organize: true,
  chat: true,
};
const HOME_SCOPES: readonly Scope[] = [
  { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
];

/** A model whose replies come from a queue; a hanging reply waits for its signal. */
function scriptedModel() {
  const queue: (AiTurn | Error | "hang")[] = [];
  const inputs: AiInput[] = [];
  const starts: AiStartOptions[] = [];
  const model: AiModel = {
    start(options) {
      starts.push(options);
      return {
        async send(input, signal) {
          inputs.push(input);
          const next = queue.shift();
          if (next === undefined) throw new Error("script exhausted");
          if (next === "hang")
            return new Promise((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          if (next instanceof Error) throw next;
          return next;
        },
      };
    },
    async ping() {
      return { ok: true, message: "ok" };
    },
  };
  return { model, queue, inputs, starts };
}

const text = (value: string): AiTurn => ({ text: value, toolCalls: [], stop: "end_turn" });
const call = (id: string, name: string, input: unknown): AiTurn => ({
  text: "",
  toolCalls: [{ id, name, input }],
  stop: "tool_use",
});

interface Setup {
  readonly repos: Repos;
  readonly storage: StorageProvider;
  readonly principal: Principal;
  readonly other: Principal;
  readonly service: ChatService;
  readonly script: ReturnType<typeof scriptedModel>;
  readonly unexpected: ReturnType<typeof vi.fn>;
  /** A second API process sharing the database but nothing in memory. */
  restart(): ChatService;
  /** Whether the login's Trash is configured; can be switched off mid-test. */
  readonly trash: { enabled: boolean };
}

async function setup(
  options: {
    files?: Record<string, string>;
    trash?: boolean;
    limits?: Record<string, number>;
    aiOff?: boolean;
    chatOff?: boolean;
    noIdentity?: boolean;
  } = {},
): Promise<Setup> {
  const repos = createMemoryRepos();
  const account = await repos.accounts.create({ displayName: null });
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://a" });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
  const bob = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "bob",
  });
  const base = createMemoryStorage(
    options.files ?? {
      "/Inbox/a.txt": "hello",
      "/Inbox/b.txt": "world",
      "/Docs/readme.md": "# Hi",
    },
  );
  const storage: StorageProvider = options.trash
    ? Object.assign(base, { trash: {} as TrashProvider })
    : base;
  const principal: Principal = {
    accountId: account.id,
    identityId: identity.id,
    username: "alice",
    storage,
    isAdmin: false,
  };
  const other: Principal = { ...principal, identityId: bob.id, username: "bob" };
  const script = scriptedModel();
  const mcp: McpToolDeps = {
    indexQueries: { rootIdsByName: async () => ({}) } as unknown as IndexQueries,
    searchService: { search: async () => Promise.reject(new Error("unexpected")) },
    scopeResolver: {
      verifiedIndexScopes: async () => ({ available: false, reason: "no_connection" as const }),
    },
    identities: {
      get: async () => (options.noIdentity ? null : buildIdentity({ id: identity.id })),
    },
    publicUrl: async () => null,
    indexerClient: null,
    writesEnabled: false,
    clock: () => new Date("2026-09-18T10:00:00.000Z"),
    metadata: createMetadataService(repos),
    ...(options.trash ? { trashPathForStorage: () => (trash.enabled ? "/.Trash" : null) } : {}),
  };
  const trash = { enabled: true };
  void HOME_SCOPES;
  const unexpected = vi.fn();
  let counter = 0;
  const build = () =>
    createChatService({
      settings: {
        resolved: async () =>
          options.aiOff ? null : options.chatOff ? { ...CONFIG, chat: false } : CONFIG,
      },
      modelFor: () => script.model,
      chats: repos.aiChats,
      mcp,
      fs: {
        bus: createEventBus(),
        clock: () => new Date(),
        metadata: createMetadataService(repos),
      },
      clock: () => new Date(),
      ids: () => `id-${++counter}`,
      limits: { turnDeadlineMs: 2000, ...options.limits },
      onUnexpectedError: unexpected,
    });
  return {
    repos,
    storage,
    principal,
    other,
    service: build(),
    script,
    unexpected,
    restart: build,
    trash,
  };
}

async function chatWith(
  s: Setup,
  text: string,
  references: string[] = [],
  service = s.service,
): Promise<Chat> {
  const chat = await service.create(s.principal, {});
  return service.send(s.principal, chat.id, { text, references, location: "/Inbox" });
}

function lastParts(chat: Chat): ChatPart[] {
  return chat.messages.at(-1)?.parts ?? [];
}

describe("titleFrom", () => {
  it("uses the first non-empty line, shortened", () => {
    expect(titleFrom("\n  What are these?  \nmore")).toBe("What are these?");
    expect(titleFrom("x".repeat(80))).toBe(`${"x".repeat(59)}…`);
    expect(titleFrom("   ")).toBe("New chat");
  });
});

describe("chat service", () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
  });

  it("creates, lists, renames and deletes chats scoped to the caller", async () => {
    const created = await s.service.create(s.principal, {
      share: { contents: false, otherFileNames: true },
    });
    expect(created).toMatchObject({
      title: "New chat",
      state: "idle",
      share: { contents: false, otherFileNames: true },
      references: [],
      messages: [],
    });
    expect((await s.service.list(s.principal)).chats.map((chat) => chat.id)).toEqual([created.id]);
    expect((await s.service.list(s.other)).chats).toEqual([]);
    await expect(s.service.get(s.other, created.id)).rejects.toMatchObject({ kind: "not_found" });
    await expect(s.service.rename(s.other, created.id, { title: "x" })).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(s.service.delete(s.other, created.id)).rejects.toMatchObject({
      kind: "not_found",
    });
    expect((await s.service.rename(s.principal, created.id, { title: "Taxes" })).title).toBe(
      "Taxes",
    );
    await s.service.delete(s.principal, created.id);
    await expect(s.service.get(s.principal, created.id)).rejects.toBeInstanceOf(ApiHttpError);
  });

  it("keeps only the most recent chats when a new one is created", async () => {
    const limited = await setup({ limits: { maxChats: 2 } });
    const first = await limited.service.create(limited.principal, {});
    await limited.service.create(limited.principal, {});
    await limited.service.create(limited.principal, {});
    expect((await limited.service.list(limited.principal)).chats).toHaveLength(2);
    await expect(limited.service.get(limited.principal, first.id)).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("answers a message, telling the model what was attached and where the person is", async () => {
    s.script.queue.push(text("Two small text files."));

    const running = await chatWith(s, "What are these?", ["/Inbox/a.txt", "/Inbox/b.txt"]);
    expect(running.state).toBe("running");
    expect(running.title).toBe("What are these?");
    expect(running.references.map((reference) => reference.path)).toEqual([
      "/Inbox/a.txt",
      "/Inbox/b.txt",
    ]);
    await s.service.settled(running.id);

    const done = await s.service.get(s.principal, running.id);
    expect(done.state).toBe("idle");
    expect(done.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(done.messages[0]).toMatchObject({
      references: ["/Inbox/a.txt", "/Inbox/b.txt"],
      location: "/Inbox",
      parts: [{ kind: "text", text: "What are these?" }],
    });
    expect(lastParts(done)).toEqual([{ kind: "text", text: "Two small text files." }]);
    expect(s.script.inputs[0]).toEqual({
      kind: "user",
      text: [
        "Attached to this message:",
        "- /Inbox/a.txt (file, 5 B, modified 1970-01-01)",
        "- /Inbox/b.txt (file, 5 B, modified 1970-01-01)",
        "",
        "The person is looking at /Inbox.",
        "",
        "What are these?",
      ].join("\n"),
    });
    const start = s.script.starts[0];
    expect(start?.history).toEqual([]);
    expect(start?.tools.map((tool) => tool.name)).toEqual([
      "folder_tree",
      "list_folder",
      "read_file",
      "file_info",
      "move_items",
      "write_text_file",
    ]);
  });

  it("refuses references that do not exist, are in Trash or exceed the limit", async () => {
    const chat = await s.service.create(s.principal, {});
    await expect(
      s.service.send(s.principal, chat.id, { text: "x", references: ["/nope.txt"] }),
    ).rejects.toMatchObject({ kind: "bad_request", message: "/nope.txt does not exist." });
    await expect(
      s.service.send(s.principal, chat.id, { text: "x", references: ["/bad\0"] }),
    ).rejects.toMatchObject({ kind: "bad_request" });
    const limited = await setup({ limits: { maxReferences: 1 } });
    const small = await limited.service.create(limited.principal, {});
    await expect(
      limited.service.send(limited.principal, small.id, {
        text: "x",
        references: ["/Inbox/a.txt", "/Inbox/b.txt"],
      }),
    ).rejects.toMatchObject({ kind: "bad_request" });
    const trashed = await setup({ trash: true });
    const t = await trashed.service.create(trashed.principal, {});
    await expect(
      trashed.service.send(trashed.principal, t.id, { text: "x", references: ["/.Trash/x"] }),
    ).rejects.toMatchObject({
      kind: "bad_request",
      message: "Items in Trash cannot be referenced.",
    });
    expect((await s.service.get(s.principal, chat.id)).messages).toEqual([]);
  });

  it("lets the model read a referenced file and refuses one that is not referenced", async () => {
    s.script.queue.push(
      call("c1", "read_file", { path: "/Inbox/a.txt" }),
      call("c2", "read_file", { path: "/Inbox/b.txt" }),
      text("It says hello."),
    );

    const chat = await chatWith(s, "Read it", ["/Inbox/a.txt"]);
    await s.service.settled(chat.id);

    const parts = lastParts(await s.service.get(s.principal, chat.id));
    expect(parts[0]).toMatchObject({
      kind: "tool",
      name: "read_file",
      activity: "Read a.txt",
      state: "done",
    });
    expect((parts[0] as ChatPart & { kind: "tool" }).output).toMatch(
      /^\/Inbox\/a\.txt \(5 characters, sha256 [0-9a-f]{64}\)\n\nhello$/,
    );
    expect(parts[1]).toMatchObject({
      kind: "tool",
      state: "failed",
      output: expect.stringContaining("/Inbox/b.txt is not referenced"),
    });
    expect(parts[2]).toEqual({ kind: "text", text: "It says hello." });
  });

  it("holds a trash card for the person, applies it with their edits and then lets the model continue", async () => {
    const t = await setup({ trash: true });
    t.script.queue.push(
      call("c1", "trash_items", {
        summary: "Remove both.",
        items: [
          { path: "/Inbox/a.txt", reason: "empty" },
          { path: "/Inbox/b.txt", reason: "empty" },
        ],
      }),
      text("Done, a.txt is in the Trash."),
    );

    const chat = await chatWith(t, "Remove these", ["/Inbox"]);
    await t.service.settled(chat.id);
    const waiting = await t.service.get(t.principal, chat.id);
    expect(waiting.state).toBe("awaiting_approval");
    const card = lastParts(waiting)[0];
    expect(card).toMatchObject({
      kind: "action",
      state: "pending",
      proposal: {
        kind: "trash",
        summary: "Remove both.",
        items: [
          { path: "/Inbox/a.txt", kind: "file" },
          { path: "/Inbox/b.txt", kind: "file" },
        ],
      },
    });
    if (card?.kind !== "action") throw new Error("expected a card");
    await expect(
      t.service.act(t.other, chat.id, card.id, { decision: "apply" }),
    ).rejects.toMatchObject({ kind: "not_found" });

    const resumed = await t.service.act(t.principal, chat.id, card.id, {
      decision: "apply",
      edits: { paths: ["/Inbox/a.txt", "/elsewhere.txt"] },
    });
    expect(resumed.state).toBe("running");
    await t.service.settled(chat.id);

    const done = await t.service.get(t.principal, chat.id);
    expect(done.state).toBe("idle");
    expect(lastParts(done)).toEqual([
      {
        kind: "action",
        id: card.id,
        state: "applied",
        outcome: "Moved 1 item to Trash.",
        results: [{ path: "/Inbox/a.txt", ok: true }],
        proposal: card.proposal,
      },
      { kind: "text", text: "Done, a.txt is in the Trash." },
    ]);
    expect(t.script.inputs[1]).toEqual({
      kind: "tool_results",
      results: [{ id: "c1", isError: false, content: "Trashed /Inbox/a.txt" }],
    });
    await expect(t.storage.stat("/Inbox/a.txt")).rejects.toMatchObject({ kind: "not_found" });
    await expect(t.storage.stat("/Inbox/b.txt")).resolves.toBeDefined();
    await expect(
      t.service.act(t.principal, chat.id, card.id, { decision: "apply" }),
    ).rejects.toMatchObject({ kind: "conflict" });
    await expect(
      t.service.act(t.principal, chat.id, "nope", { decision: "apply" }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("does not offer trash without a configured Trash, and tells the model when declined", async () => {
    s.script.queue.push(
      call("c1", "move_items", {
        summary: "File it.",
        moves: [{ path: "/Inbox/a.txt", destination: "/Docs", reason: "docs" }],
      }),
      text("Ok, left as is."),
    );
    const chat = await chatWith(s, "Move it", ["/Inbox/a.txt"]);
    await s.service.settled(chat.id);
    expect(s.script.starts[0]?.tools.map((tool) => tool.name)).not.toContain("trash_items");
    const card = lastParts(await s.service.get(s.principal, chat.id))[0];
    if (card?.kind !== "action") throw new Error("expected a card");
    expect(card.proposal).toMatchObject({
      kind: "move",
      suggestions: [
        {
          path: "/Inbox/a.txt",
          destination: "/Docs",
          target: "/Docs/a.txt",
          conflict: false,
          newFolder: false,
        },
      ],
    });

    await s.service.act(s.principal, chat.id, card.id, { decision: "decline" });
    await s.service.settled(chat.id);

    expect(lastParts(await s.service.get(s.principal, chat.id))).toEqual([
      {
        kind: "action",
        id: card.id,
        state: "declined",
        outcome: "Not applied.",
        proposal: card.proposal,
      },
      { kind: "text", text: "Ok, left as is." },
    ]);
    expect(s.script.inputs[1]).toEqual({
      kind: "tool_results",
      results: [{ id: "c1", isError: false, content: "The person did not apply this." }],
    });
    await expect(s.storage.stat("/Inbox/a.txt")).resolves.toBeDefined();
  });

  it("applies a move card with the person's own destinations", async () => {
    s.script.queue.push(
      call("c1", "move_items", {
        summary: "File it.",
        moves: [{ path: "/Inbox/a.txt", destination: "/Docs", reason: "docs" }],
      }),
      text("Moved."),
    );
    const chat = await chatWith(s, "Move it", ["/Inbox/a.txt"]);
    await s.service.settled(chat.id);
    const card = lastParts(await s.service.get(s.principal, chat.id))[0];
    if (card?.kind !== "action") throw new Error("expected a card");

    await s.service.act(s.principal, chat.id, card.id, {
      decision: "apply",
      edits: { moves: [{ path: "/Inbox/a.txt", target: "/Archive/2024/a.txt" }] },
    });
    await s.service.settled(chat.id);

    expect(lastParts(await s.service.get(s.principal, chat.id))[0]).toMatchObject({
      state: "applied",
      outcome: "Moved 1 item.",
      results: [{ path: "/Inbox/a.txt", ok: true, target: "/Archive/2024/a.txt" }],
    });
    await expect(s.storage.stat("/Archive/2024/a.txt")).resolves.toBeDefined();
    // The reference followed the move.
    expect((await s.service.get(s.principal, chat.id)).references).toEqual([
      { path: "/Archive/2024/a.txt", missing: false },
    ]);
  });

  it("declines pending cards when a new message arrives and sends both in one turn", async () => {
    s.script.queue.push(
      {
        text: "",
        toolCalls: [
          { id: "c1", name: "list_folder", input: { path: "/Inbox" } },
          {
            id: "c2",
            name: "move_items",
            input: {
              summary: "s",
              moves: [{ path: "/Inbox/a.txt", destination: "/Docs", reason: "r" }],
            },
          },
        ],
        stop: "tool_use",
      },
      text("Understood, nothing moved."),
    );
    const chat = await chatWith(s, "Tidy", ["/Inbox/a.txt"]);
    await s.service.settled(chat.id);
    expect((await s.service.get(s.principal, chat.id)).state).toBe("awaiting_approval");

    await s.service.send(s.principal, chat.id, { text: "Never mind." });
    await s.service.settled(chat.id);

    const done = await s.service.get(s.principal, chat.id);
    expect(done.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(done.messages[1]?.parts[1]).toMatchObject({
      kind: "action",
      state: "declined",
      outcome: "Not applied: a newer message arrived.",
    });
    expect(s.script.inputs[1]).toEqual({
      kind: "tool_results",
      results: [
        { id: "c1", isError: false, content: expect.stringContaining("/Inbox: 2 entries") },
        { id: "c2", isError: false, content: "The person did not apply this." },
      ],
      text: "Never mind.",
    });
    expect(done.state).toBe("idle");
  });

  it("stops a reply on cancel and reports a reply the model could not finish", async () => {
    s.script.queue.push("hang");
    const chat = await chatWith(s, "Think hard");
    const cancelled = await s.service.cancel(s.principal, chat.id);
    expect(cancelled.state).toBe("idle");
    expect(lastParts(cancelled)).toEqual([{ kind: "error", message: "Stopped." }]);

    s.script.queue.push(new Error("boom"));
    await s.service.send(s.principal, chat.id, { text: "Again" });
    await s.service.settled(chat.id);
    expect(lastParts(await s.service.get(s.principal, chat.id))).toEqual([
      { kind: "error", message: "Something went wrong while answering. Try again." },
    ]);
    expect(s.unexpected).toHaveBeenCalledWith(new Error("boom"));
    expect(s.script.starts).toHaveLength(2);
    expect(s.script.starts[1]?.history).toEqual([
      { role: "user", text: "The person is looking at /Inbox.\n\nThink hard" },
      { role: "assistant", text: "[The reply stopped: Stopped.]" },
    ]);
  });

  it("stops the reply in progress when the same login sends elsewhere, and times a reply out", async () => {
    s.script.queue.push("hang", text("Second."));
    const first = await chatWith(s, "First");
    const second = await chatWith(s, "Second");
    await s.service.settled(second.id);
    expect(lastParts(await s.service.get(s.principal, first.id))).toEqual([
      { kind: "error", message: "A newer message replaced this reply." },
    ]);
    expect(lastParts(await s.service.get(s.principal, second.id))).toEqual([
      { kind: "text", text: "Second." },
    ]);

    const slow = await setup({ limits: { turnDeadlineMs: 20 } });
    slow.script.queue.push("hang");
    const chat = await chatWith(slow, "Slow");
    await slow.service.settled(chat.id);
    expect(lastParts(await slow.service.get(slow.principal, chat.id))).toEqual([
      { kind: "error", message: "The reply took too long and was stopped." },
    ]);
  });

  it("closes a full chat and refuses the next message", async () => {
    const limited = await setup({ limits: { maxMessages: 2 } });
    limited.script.queue.push(text("Hi."));
    const chat = await chatWith(limited, "Hello");
    await limited.service.settled(chat.id);
    expect((await limited.service.get(limited.principal, chat.id)).state).toBe("closed");
    await expect(
      limited.service.send(limited.principal, chat.id, { text: "More" }),
    ).rejects.toMatchObject({ kind: "conflict" });
  });

  it("rebuilds the conversation from the transcript after a restart and still applies a card", async () => {
    const t = await setup({ trash: true });
    t.script.queue.push(
      call("c1", "trash_items", {
        summary: "Remove it.",
        items: [{ path: "/Inbox/a.txt", reason: "old" }],
      }),
    );
    const chat = await chatWith(t, "Remove it", ["/Inbox/a.txt"]);
    await t.service.settled(chat.id);
    const card = lastParts(await t.service.get(t.principal, chat.id))[0];
    if (card?.kind !== "action") throw new Error("expected a card");

    const restarted = t.restart();
    const applied = await restarted.act(t.principal, chat.id, card.id, { decision: "apply" });
    expect(applied.state).toBe("idle");
    expect(lastParts(applied)[0]).toMatchObject({
      state: "applied",
      outcome: "Moved 1 item to Trash.",
    });
    await expect(t.storage.stat("/Inbox/a.txt")).rejects.toMatchObject({ kind: "not_found" });

    t.script.queue.push(text("Yes, it is gone."));
    await restarted.send(t.principal, chat.id, { text: "Is it gone?" });
    await restarted.settled(chat.id);
    expect(t.script.starts).toHaveLength(2);
    expect(t.script.starts[1]?.history).toEqual([
      {
        role: "user",
        text: "Attached to this message:\n- /Inbox/a.txt\n\nThe person is looking at /Inbox.\n\nRemove it",
      },
      {
        role: "assistant",
        text: "[Proposed to move 1 items to Trash; applied: Moved 1 item to Trash..]",
      },
    ]);
    expect(t.script.inputs.at(-1)).toEqual({ kind: "user", text: "Is it gone?" });
    expect((await restarted.get(t.principal, chat.id)).references).toEqual([
      { path: "/Inbox/a.txt", missing: true },
    ]);
  });

  it("refuses to apply while a reply is being written and when the session ended", async () => {
    s.script.queue.push("hang");
    const chat = await chatWith(s, "Wait");
    await expect(
      s.service.act(s.principal, chat.id, "x", { decision: "decline" }),
    ).rejects.toMatchObject({ kind: "conflict" });
    await s.service.cancel(s.principal, chat.id);

    const ended = await setup();
    ended.script.queue.push(
      call("c1", "move_items", {
        summary: "s",
        moves: [{ path: "/Inbox/a.txt", destination: "/Docs", reason: "r" }],
      }),
    );
    const gone: Principal = { ...ended.principal, verifyAuthority: async () => false };
    const c = await ended.service.create(gone, {});
    await ended.service.send(ended.principal, c.id, { text: "Move", references: ["/Inbox/a.txt"] });
    await ended.service.settled(c.id);
    const card = lastParts(await ended.service.get(ended.principal, c.id))[0];
    if (card?.kind !== "action") throw new Error("expected a card");
    await expect(
      ended.service.act(gone, c.id, card.id, { decision: "apply" }),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("is unavailable while an administrator has chat turned off", async () => {
    const off = await setup({ chatOff: true });
    await expect(off.service.create(off.principal, {})).rejects.toMatchObject({
      kind: "unsupported",
      message: "Chat is turned off. An administrator can turn it on under System > AI.",
    });
    const chat = await off.repos.aiChats.create({
      identityId: off.principal.identityId,
      title: "t",
      share: { contents: true, otherFileNames: true },
    });
    await expect(off.service.send(off.principal, chat.id, { text: "x" })).rejects.toMatchObject({
      kind: "unsupported",
    });
  });

  it("is unavailable until an administrator sets AI up", async () => {
    const off = await setup({ aiOff: true });
    await expect(off.service.create(off.principal, {})).rejects.toMatchObject({
      kind: "unsupported",
    });
    const chat = await off.repos.aiChats.create({
      identityId: off.principal.identityId,
      title: "t",
      share: { contents: true, otherFileNames: true },
    });
    await expect(off.service.send(off.principal, chat.id, { text: "x" })).rejects.toMatchObject({
      kind: "unsupported",
    });
  });

  it("treats a login without an identity row as unindexed and stops a live chat on delete", async () => {
    const lone = await setup({ noIdentity: true });
    lone.script.queue.push(text("Hi."));
    const chat = await chatWith(lone, "Hello");
    await lone.service.settled(chat.id);
    expect(lone.script.starts[0]?.tools.map((tool) => tool.name)).not.toContain("duplicates_of");
    expect((await lone.service.cancel(lone.principal, chat.id)).state).toBe("idle");
    await lone.service.delete(lone.principal, chat.id);
    await expect(lone.service.get(lone.principal, chat.id)).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("passes on storage failures other than a missing reference", async () => {
    const chat = await s.service.create(s.principal, {});
    vi.spyOn(s.storage, "stat").mockRejectedValueOnce(new StorageError("forbidden", "denied"));
    await expect(
      s.service.send(s.principal, chat.id, { text: "x", references: ["/Inbox/a.txt"] }),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("declines stored cards on a new message after a restart, and refuses a card whose tool is gone", async () => {
    const t = await setup({ trash: true });
    t.script.queue.push(
      call("c1", "trash_items", { summary: "s", items: [{ path: "/Inbox/a.txt", reason: "r" }] }),
    );
    const chat = await chatWith(t, "Remove it", ["/Inbox/a.txt"]);
    await t.service.settled(chat.id);
    const card = lastParts(await t.service.get(t.principal, chat.id))[0];
    if (card?.kind !== "action") throw new Error("expected a card");

    const restarted = t.restart();
    t.trash.enabled = false;
    await expect(
      restarted.act(t.principal, chat.id, card.id, { decision: "apply" }),
    ).rejects.toMatchObject({
      kind: "conflict",
      message: "That action is no longer available for this login.",
    });

    t.script.queue.push(text("Ok."));
    await restarted.send(t.principal, chat.id, { text: "Forget it" });
    await restarted.settled(chat.id);
    const done = await restarted.get(t.principal, chat.id);
    expect(done.messages[1]?.parts[0]).toMatchObject({
      kind: "action",
      state: "declined",
      outcome: "Not applied: a newer message arrived.",
    });
    expect(t.script.inputs.at(-1)).toEqual({ kind: "user", text: "Forget it" });
  });
});
