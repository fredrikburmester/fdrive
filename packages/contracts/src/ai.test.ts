import { describe, expect, it } from "vitest";
import {
  AiSettings,
  AiSettingsUpdateRequest,
  AiStatusResponse,
  Chat,
  ChatActionRequest,
  ChatCreateRequest,
  ChatMessageRequest,
  ChatPart,
  ChatRenameRequest,
  DEFAULT_AI_MODEL,
  MAX_CHAT_REFERENCES,
  MAX_ORGANIZE_ITEMS,
  OrganizeRequest,
  OrganizeRun,
} from "./ai";

const update = {
  revision: 0,
  organize: true,
  chat: true,
  assist: false,
  provider: "anthropic",
  model: "claude-opus-5",
  baseUrl: null,
} as const;

describe("AiSettingsUpdateRequest", () => {
  it("accepts Anthropic without a base URL and trims a new key", () => {
    expect(AiSettingsUpdateRequest.parse({ ...update, apiKey: "  sk-ant-1  " })).toEqual({
      ...update,
      apiKey: "sk-ant-1",
    });
    expect(AiSettingsUpdateRequest.parse({ ...update, apiKey: null }).apiKey).toBeNull();
    expect(AiSettingsUpdateRequest.parse(update).apiKey).toBeUndefined();
  });

  it("requires a base URL only for OpenAI-compatible servers", () => {
    expect(
      AiSettingsUpdateRequest.safeParse({ ...update, baseUrl: "https://api.example/v1" }).success,
    ).toBe(false);
    expect(
      AiSettingsUpdateRequest.safeParse({ ...update, provider: "openai_compatible" }).success,
    ).toBe(false);
    expect(
      AiSettingsUpdateRequest.safeParse({
        ...update,
        provider: "openai_compatible",
        model: "llama3.1",
        baseUrl: "http://ollama:11434/v1",
      }).success,
    ).toBe(true);
  });

  it("rejects blank models, blank keys, non-http URLs and unknown fields", () => {
    expect(AiSettingsUpdateRequest.safeParse({ ...update, model: "  " }).success).toBe(false);
    expect(AiSettingsUpdateRequest.safeParse({ ...update, apiKey: " " }).success).toBe(false);
    expect(
      AiSettingsUpdateRequest.safeParse({
        ...update,
        provider: "openai_compatible",
        baseUrl: "file:///etc/passwd",
      }).success,
    ).toBe(false);
    expect(AiSettingsUpdateRequest.safeParse({ ...update, hasApiKey: true }).success).toBe(false);
  });

  it("carries the TypeSafe key separately, and needs the assist flag", () => {
    expect(
      AiSettingsUpdateRequest.parse({ ...update, assistApiKey: "  ts-1  " }).assistApiKey,
    ).toBe("ts-1");
    expect(
      AiSettingsUpdateRequest.parse({ ...update, assistApiKey: null }).assistApiKey,
    ).toBeNull();
    expect(AiSettingsUpdateRequest.parse(update).assistApiKey).toBeUndefined();
    expect(AiSettingsUpdateRequest.safeParse({ ...update, assistApiKey: " " }).success).toBe(false);
    const { assist: _assist, ...withoutAssist } = update;
    expect(AiSettingsUpdateRequest.safeParse(withoutAssist).success).toBe(false);
  });
});

describe("AI responses", () => {
  it("never carries a key, only whether one is saved", () => {
    const settings = { ...update, hasApiKey: true, hasAssistKey: true };
    expect(AiSettings.parse({ ...settings, apiKey: "secret", assistApiKey: "secret" })).toEqual(
      settings,
    );
    expect(
      AiStatusResponse.parse({ provider: null, organize: false, chat: false, assist: false }),
    ).toEqual({ provider: null, organize: false, chat: false, assist: false });
    expect(DEFAULT_AI_MODEL.anthropic).toBe("claude-opus-5");
  });
});

describe("OrganizeRequest", () => {
  it("bounds the selection and trims instructions", () => {
    const paths = Array.from({ length: MAX_ORGANIZE_ITEMS }, (_, index) => `/inbox/${index}`);
    expect(OrganizeRequest.parse({ paths, instructions: "  by year " }).instructions).toBe(
      "by year",
    );
    expect(OrganizeRequest.safeParse({ paths: [...paths, "/x"] }).success).toBe(false);
    expect(OrganizeRequest.safeParse({ paths: [] }).success).toBe(false);
    expect(OrganizeRequest.safeParse({ paths: ["/a"], scope: "/" }).success).toBe(false);
  });

  it("carries an optional, exact sharing choice", () => {
    expect(OrganizeRequest.parse({ paths: ["/a"] }).share).toBeUndefined();
    expect(
      OrganizeRequest.parse({ paths: ["/a"], share: { contents: false, otherFileNames: true } })
        .share,
    ).toEqual({ contents: false, otherFileNames: true });
    for (const share of [
      { contents: false },
      { contents: "no", otherFileNames: true },
      { contents: true, otherFileNames: true, instructions: true },
    ])
      expect(OrganizeRequest.safeParse({ paths: ["/a"], share }).success).toBe(false);
  });
});

describe("OrganizeRun", () => {
  it("parses a finished run with its proposal", () => {
    const run = {
      id: "run-1",
      state: "done",
      createdAt: "2026-09-15T10:00:00.000Z",
      updatedAt: "2026-09-15T10:01:00.000Z",
      itemCount: 2,
      activity: ["Looked through /"],
      proposal: {
        summary: "Receipts go to Finance.",
        suggestions: [
          {
            path: "/inbox/receipt.pdf",
            kind: "file",
            destination: "/Finance/Receipts",
            target: "/Finance/Receipts/receipt.pdf",
            reason: "A grocery receipt.",
            newFolder: true,
            conflict: false,
          },
        ],
        unchanged: [{ path: "/inbox/notes.txt", reason: "Unclear." }],
      },
    };
    expect(OrganizeRun.parse(run)).toEqual(run);
    expect(OrganizeRun.safeParse({ ...run, state: "queued" }).success).toBe(false);
  });
});

describe("chat requests", () => {
  it("bounds a message, its references and the location", () => {
    expect(
      ChatMessageRequest.parse({
        text: "  What is this?  ",
        references: ["/a.pdf"],
        location: null,
      }),
    ).toEqual({ text: "What is this?", references: ["/a.pdf"], location: null });
    expect(ChatMessageRequest.safeParse({ text: "   " }).success).toBe(false);
    expect(ChatMessageRequest.safeParse({ text: "x".repeat(8001) }).success).toBe(false);
    expect(
      ChatMessageRequest.safeParse({
        text: "x",
        references: Array.from({ length: MAX_CHAT_REFERENCES + 1 }, (_, i) => `/f${i}`),
      }).success,
    ).toBe(false);
    expect(ChatMessageRequest.safeParse({ text: "x", extra: true }).success).toBe(false);
  });

  it("takes a decision with optional edits", () => {
    expect(ChatActionRequest.parse({ decision: "decline" })).toEqual({ decision: "decline" });
    expect(
      ChatActionRequest.parse({
        decision: "apply",
        edits: { moves: [{ path: "/a", target: "/b/a" }], mode: "create" },
      }),
    ).toEqual({
      decision: "apply",
      edits: { moves: [{ path: "/a", target: "/b/a" }], mode: "create" },
    });
    expect(ChatActionRequest.safeParse({ decision: "maybe" }).success).toBe(false);
    expect(ChatActionRequest.safeParse({ decision: "decline", edits: {} }).success).toBe(false);
    expect(ChatRenameRequest.safeParse({ title: " " }).success).toBe(false);
    expect(ChatCreateRequest.parse({})).toEqual({});
  });
});

describe("Chat", () => {
  it("accepts a transcript with every kind of part and card", () => {
    const chat = Chat.parse({
      id: "c",
      title: "Taxes",
      createdAt: "2026-09-18T10:00:00.000Z",
      updatedAt: "2026-09-18T10:00:00.000Z",
      lastMessageAt: "2026-09-18T10:00:00.000Z",
      state: "awaiting_approval",
      share: { contents: true, otherFileNames: false },
      references: [{ path: "/a.pdf", missing: false }],
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [{ kind: "text", text: "Hi" }],
          references: ["/a.pdf"],
          location: "/",
          createdAt: "2026-09-18T10:00:00.000Z",
        },
        {
          id: "m2",
          role: "assistant",
          parts: [
            {
              kind: "tool",
              id: "t",
              name: "read_file",
              activity: "Read a.pdf",
              input: "{}",
              output: "text",
              state: "done",
            },
            {
              kind: "action",
              id: "a",
              state: "pending",
              proposal: {
                kind: "write",
                summary: "Rewrite",
                path: "/a.md",
                mode: "create",
                text: "# Hi",
                expectedSha256: null,
              },
            },
            { kind: "error", message: "Stopped." },
          ],
          references: [],
          location: null,
          createdAt: "2026-09-18T10:00:01.000Z",
        },
      ],
    });
    expect(chat.messages[1]?.parts).toHaveLength(3);
    expect(
      ChatPart.safeParse({ kind: "action", id: "a", state: "pending", proposal: { kind: "nope" } })
        .success,
    ).toBe(false);
  });
});
