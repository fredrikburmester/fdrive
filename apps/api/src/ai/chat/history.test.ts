import type { ChatMessage } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { buildHistory, formatUserMessage } from "./history.ts";

function message(
  role: ChatMessage["role"],
  parts: ChatMessage["parts"],
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: `${role}-${Math.random()}`,
    role,
    parts,
    references: [],
    location: null,
    createdAt: "2026-09-18T10:00:00.000Z",
    ...extra,
  };
}

describe("formatUserMessage", () => {
  it("lists what was attached and where the person is before their words", () => {
    expect(
      formatUserMessage(
        "What are these?",
        [{ path: "/Inbox/a.pdf", detail: "file, 1.0 KB" }, { path: "/Docs" }],
        "/Inbox",
      ),
    ).toBe(
      [
        "Attached to this message:",
        "- /Inbox/a.pdf (file, 1.0 KB)",
        "- /Docs",
        "",
        "The person is looking at /Inbox.",
        "",
        "What are these?",
      ].join("\n"),
    );
  });

  it("is just the words when nothing else is known", () => {
    expect(formatUserMessage("Hi", [], null)).toBe("Hi");
  });
});

describe("buildHistory", () => {
  it("replays text, references and locations, ending with the assistant", () => {
    const history = buildHistory([
      message("user", [{ kind: "text", text: "What is this?" }], {
        references: ["/a.pdf"],
        location: "/",
      }),
      message("assistant", [{ kind: "text", text: "An invoice." }]),
      message("user", [{ kind: "text", text: "Thanks" }]),
      message("assistant", []),
    ]);

    expect(history).toEqual([
      {
        role: "user",
        text: "Attached to this message:\n- /a.pdf\n\nThe person is looking at /.\n\nWhat is this?",
      },
      { role: "assistant", text: "An invoice." },
    ]);
  });

  it("merges consecutive messages of one role", () => {
    expect(
      buildHistory([
        message("user", [{ kind: "text", text: "One" }]),
        message("user", [{ kind: "text", text: "Two" }]),
        message("assistant", [{ kind: "text", text: "Both." }]),
      ]),
    ).toEqual([
      { role: "user", text: "One\n\nTwo" },
      { role: "assistant", text: "Both." },
    ]);
  });

  it("keeps tool calls only for the most recent replies and summarizes cards and failures", () => {
    const tool = {
      kind: "tool" as const,
      id: "t1",
      name: "read_file",
      activity: "Read a.txt",
      input: '{"path":"/a.txt"}',
      output: "hello",
      state: "done" as const,
    };
    const history = buildHistory(
      [
        message("user", [{ kind: "text", text: "First" }]),
        message("assistant", [tool, { kind: "text", text: "Old." }]),
        message("user", [{ kind: "text", text: "Second" }]),
        message("assistant", [
          { ...tool, state: "failed", output: "boom" },
          {
            kind: "action",
            id: "a1",
            state: "applied",
            outcome: "Moved 2 items.",
            proposal: { kind: "move", summary: "s", suggestions: [], unchanged: [] },
          },
          {
            kind: "action",
            id: "a2",
            state: "pending",
            proposal: {
              kind: "trash",
              summary: "s",
              items: [{ path: "/x", kind: "file", reason: "r" }],
            },
          },
          {
            kind: "action",
            id: "a3",
            state: "declined",
            proposal: {
              kind: "write",
              summary: "s",
              path: "/n.md",
              mode: "create",
              text: "t",
              expectedSha256: null,
            },
          },
          { kind: "error", message: "Stopped." },
        ]),
      ],
      { toolWindow: 1 },
    );

    expect(history[1]).toEqual({ role: "assistant", text: "Old." });
    expect(history[3]?.text).toBe(
      [
        '[Called read_file({"path":"/a.txt"}) which failed: boom]',
        "[Proposed to move 0 items; applied: Moved 2 items..]",
        "[Proposed to move 1 items to Trash; still waiting for the person.]",
        "[Proposed to create /n.md; declined by the person.]",
        "[The reply stopped: Stopped.]",
      ].join("\n"),
    );
  });

  it("shortens long tool output", () => {
    const history = buildHistory([
      message("user", [{ kind: "text", text: "Go" }]),
      message("assistant", [
        {
          kind: "tool",
          id: "t",
          name: "list_folder",
          activity: "",
          input: "{}",
          output: "x".repeat(2000),
          state: "done",
        },
      ]),
    ]);

    expect(history[1]?.text).toMatch(/^\[Called list_folder\(\{\}\): x{1500}…\]$/);
  });
});
