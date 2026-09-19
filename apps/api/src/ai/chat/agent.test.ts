import type { ChatPart } from "@fdrive/contracts";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type AiInput, AiProviderError, type AiTurn } from "../model.ts";
import { type AiTool, AiToolError, defineTool } from "../tools/tool.ts";
import { defineActionTool } from "./actions.ts";
import { type ChatTurnDeps, ChatTurnError, runChatTurn } from "./agent.ts";

function scripted(turns: readonly (AiTurn | Error)[]) {
  const queue = [...turns];
  const inputs: AiInput[] = [];
  return {
    inputs,
    conversation: {
      async send(input: AiInput) {
        inputs.push(input);
        const turn = queue.shift();
        if (turn === undefined) throw new Error("script exhausted");
        if (turn instanceof Error) throw turn;
        return turn;
      },
    },
  };
}

const text = (value: string): AiTurn => ({ text: value, toolCalls: [], stop: "end_turn" });
const calls = (...toolCalls: AiTurn["toolCalls"]): AiTurn => ({
  text: "",
  toolCalls,
  stop: "tool_use",
});

function echo(run?: (text: string) => Promise<string>): AiTool {
  return defineTool("echo", "Repeats.", z.object({ text: z.string() }), {
    activity: (args) => `Echoed ${args.text}`,
    run: (args) => (run ? run(args.text) : Promise.resolve(`said ${args.text}`)),
  });
}

const trash = defineActionTool("trash_items", "Trashes.", z.object({ path: z.string() }), {
  activity: (args) => `Proposed trashing ${args.path}`,
  async verify(args) {
    if (args.path === "/bad") throw new AiToolError("Not referenced.");
    return {
      kind: "trash",
      summary: "Trash it",
      items: [{ path: args.path, kind: "file", reason: "old" }],
    };
  },
  async apply() {
    return { outcome: "done", results: [], toolResult: "done" };
  },
});

function deps(
  conversation: ChatTurnDeps["conversation"],
  overrides: Partial<ChatTurnDeps> = {},
): ChatTurnDeps & { snapshots: ChatPart[][] } {
  const snapshots: ChatPart[][] = [];
  let counter = 0;
  return {
    conversation,
    tools: new Map([["echo", echo()]]),
    actions: new Map([["trash_items", trash]]),
    signal: new AbortController().signal,
    checkAuthority: async () => {},
    onParts: async (parts) => {
      snapshots.push(structuredClone([...parts]));
    },
    ids: () => `id-${++counter}`,
    snapshots,
    ...overrides,
  };
}

describe("runChatTurn", () => {
  it("records text and executed tool calls, then finishes when the model stops", async () => {
    const { conversation, inputs } = scripted([
      {
        text: "Let me look.",
        toolCalls: [{ id: "c1", name: "echo", input: { text: "hi" } }],
        stop: "tool_use",
      },
      text("Done."),
    ]);
    const parts: ChatPart[] = [];
    const turnDeps = deps(conversation);

    const end = await runChatTurn(turnDeps, { kind: "user", text: "Go" }, parts);

    expect(end).toEqual({ kind: "done" });
    expect(parts).toEqual([
      { kind: "text", text: "Let me look." },
      {
        kind: "tool",
        id: "c1",
        name: "echo",
        activity: "Echoed hi",
        input: '{"text":"hi"}',
        output: "said hi",
        state: "done",
      },
      { kind: "text", text: "Done." },
    ]);
    expect(inputs[1]).toEqual({
      kind: "tool_results",
      results: [{ id: "c1", isError: false, content: "said hi" }],
    });
    // Every change was reported: the text, the finished tool, the final text.
    expect(turnDeps.snapshots.map((snapshot) => snapshot.length)).toEqual([1, 2, 3]);
    expect(turnDeps.snapshots[1]?.[1]).toMatchObject({ state: "done" });
  });

  it("marks a failed tool call and answers unknown tools without stopping", async () => {
    const { conversation, inputs } = scripted([
      calls(
        { id: "c1", name: "echo", input: { text: "x" } },
        { id: "c2", name: "nope", input: {} },
      ),
      text("Ok."),
    ]);
    const failing = echo(async () => {
      throw new AiToolError("That folder is the Trash.");
    });
    const parts: ChatPart[] = [];

    await runChatTurn(
      deps(conversation, { tools: new Map([["echo", failing]]) }),
      { kind: "user", text: "Go" },
      parts,
    );

    expect(parts[0]).toMatchObject({
      kind: "tool",
      state: "failed",
      output: "That folder is the Trash.",
    });
    expect(inputs[1]).toEqual({
      kind: "tool_results",
      results: [
        { id: "c1", isError: true, content: "That folder is the Trash." },
        { id: "c2", isError: true, content: "There is no tool named nope." },
      ],
    });
  });

  it("verifies an action into a pending card and ends the turn holding the other results", async () => {
    const { conversation, inputs } = scripted([
      calls(
        { id: "c1", name: "echo", input: { text: "x" } },
        { id: "c2", name: "trash_items", input: { path: "/old.txt" } },
      ),
    ]);
    const parts: ChatPart[] = [];

    const end = await runChatTurn(deps(conversation), { kind: "user", text: "Remove it" }, parts);

    expect(end).toEqual({
      kind: "awaiting",
      pending: [
        {
          actionId: "id-1",
          callId: "c2",
          tool: "trash_items",
          proposal: {
            kind: "trash",
            summary: "Trash it",
            items: [{ path: "/old.txt", kind: "file", reason: "old" }],
          },
        },
      ],
      held: [{ id: "c1", isError: false, content: "said x" }],
    });
    expect(parts[1]).toEqual({
      kind: "action",
      id: "id-1",
      state: "pending",
      proposal: {
        kind: "trash",
        summary: "Trash it",
        items: [{ path: "/old.txt", kind: "file", reason: "old" }],
      },
    });
    expect(inputs).toHaveLength(1);
  });

  it("reports an action that cannot be proposed as a failed tool call and keeps going", async () => {
    const { conversation, inputs } = scripted([
      calls(
        { id: "c1", name: "trash_items", input: { path: "/bad" } },
        { id: "c2", name: "trash_items", input: {} },
      ),
      text("Sorry."),
    ]);
    const parts: ChatPart[] = [];

    const end = await runChatTurn(deps(conversation), { kind: "user", text: "Remove" }, parts);

    expect(end).toEqual({ kind: "done" });
    expect(parts[0]).toMatchObject({
      kind: "tool",
      name: "trash_items",
      activity: "Proposed trashing /bad",
      output: "Not referenced.",
      state: "failed",
    });
    expect(parts[1]).toMatchObject({ kind: "tool", state: "failed", activity: "" });
    expect(inputs[1]).toEqual({
      kind: "tool_results",
      results: [
        { id: "c1", isError: true, content: "Not referenced." },
        { id: "c2", isError: true, content: expect.stringMatching(/^Invalid arguments: path: /) },
      ],
    });
  });

  it.each([
    {
      name: "a refusal",
      turn: { text: "", toolCalls: [], stop: "refusal" } as AiTurn,
      message: "The AI provider declined this request.",
    },
    {
      name: "a cut-off answer",
      turn: { text: "Half", toolCalls: [], stop: "max_tokens" } as AiTurn,
      message: "The assistant's answer was cut off. Ask for less at once.",
    },
    {
      name: "a provider failure",
      turn: new AiProviderError("Could not reach Anthropic."),
      message: "Could not reach Anthropic.",
    },
  ])("turns $name into a readable error", async ({ turn, message }) => {
    const { conversation } = scripted([turn]);
    const parts: ChatPart[] = [];

    await expect(
      runChatTurn(deps(conversation), { kind: "user", text: "Go" }, parts),
    ).rejects.toEqual(new ChatTurnError(message));
    // Text that arrived before the cut-off stays.
    if (turn instanceof Error) expect(parts).toEqual([]);
    else if (turn.text) expect(parts).toEqual([{ kind: "text", text: turn.text }]);
  });

  it("gives up after too many steps", async () => {
    const { conversation } = scripted(
      Array.from({ length: 3 }, () => calls({ id: "c", name: "echo", input: { text: "x" } })),
    );

    await expect(
      runChatTurn(deps(conversation, { maxTurns: 2 }), { kind: "user", text: "Go" }, []),
    ).rejects.toEqual(
      new ChatTurnError("The assistant needed too many steps. Ask for less at once."),
    );
  });

  it("checks authority before every provider call and stops when cancelled", async () => {
    const controller = new AbortController();
    const checkAuthority = vi.fn(async () => {});
    const { conversation } = scripted([
      calls({ id: "c", name: "echo", input: { text: "x" } }),
      text("Done"),
    ]);
    const tool = echo(async () => {
      controller.abort();
      return "late";
    });

    await expect(
      runChatTurn(
        deps(conversation, {
          signal: controller.signal,
          checkAuthority,
          tools: new Map([["echo", tool]]),
        }),
        { kind: "user", text: "Go" },
        [],
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(checkAuthority).toHaveBeenCalledTimes(1);
  });
});

describe("runChatTurn: edge cases", () => {
  it("shows empty arguments for input that cannot be serialized", async () => {
    const { conversation } = scripted([
      calls({ id: "c1", name: "nope", input: { n: 1n } }),
      text("Ok."),
    ]);
    const parts: ChatPart[] = [];

    await runChatTurn(deps(conversation), { kind: "user", text: "Go" }, parts);

    expect(parts[0]).toMatchObject({ kind: "tool", name: "nope", input: "", state: "failed" });
  });

  it("lets a verification failure through once the run was cancelled", async () => {
    const controller = new AbortController();
    const aborting = defineActionTool("trash_items", "t", z.object({}), {
      activity: () => "",
      async verify() {
        controller.abort();
        throw new Error("late");
      },
      async apply() {
        return { outcome: "", results: [], toolResult: "" };
      },
    });
    const { conversation } = scripted([calls({ id: "c1", name: "trash_items", input: {} })]);

    await expect(
      runChatTurn(
        deps(conversation, {
          signal: controller.signal,
          actions: new Map([["trash_items", aborting]]),
        }),
        { kind: "user", text: "Go" },
        [],
      ),
    ).rejects.toThrow("late");
  });
});
