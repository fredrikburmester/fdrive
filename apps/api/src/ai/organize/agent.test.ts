import { StorageError } from "@fdrive/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpToolError } from "../../mcp/handlers.js";
import type { AiInput, AiModel, AiToolCall, AiToolSpec, AiTurn } from "../model.ts";
import {
  initialMessage,
  MAX_TURNS,
  ORGANIZE_SYSTEM_PROMPT,
  type OrganizeItem,
  type OrganizeSubmission,
  type RunOrganizeAgentOptions,
  runOrganizeAgent,
  SUBMIT_TOOL,
} from "./agent.ts";
import { OrganizeError } from "./runs.ts";
import { defineTool, type OrganizeTool, OrganizeToolError } from "./tools.ts";

/** A model that replays `turns` in order and records what it was started with and sent. */
function scriptedModel(turns: readonly AiTurn[]) {
  const queue = [...turns];
  const inputs: AiInput[] = [];
  const starts: { system: string; tools: readonly AiToolSpec[] }[] = [];
  const signals: AbortSignal[] = [];
  const model: AiModel = {
    start(options) {
      starts.push(options);
      return {
        async send(input, signal) {
          inputs.push(input);
          signals.push(signal);
          const turn = queue.shift();
          if (turn === undefined) throw new Error("the script ran out of turns");
          return turn;
        },
      };
    },
    async ping() {
      return { ok: true, message: "ok" };
    },
  };
  return { model, inputs, starts, signals };
}

function toolTurn(...toolCalls: AiToolCall[]): AiTurn {
  return { text: "", toolCalls, stop: "tool_use" };
}

function textTurn(stop: AiTurn["stop"] = "end_turn"): AiTurn {
  return { text: "Done thinking.", toolCalls: [], stop };
}

const SUBMISSION: OrganizeSubmission = {
  summary: "File the receipt.",
  moves: [{ path: "/Inbox/r.pdf", destination: "/Finance", reason: "It is a receipt." }],
  unchanged: [],
};

function submitCall(id: string, input: unknown = SUBMISSION): AiToolCall {
  return { id, name: SUBMIT_TOOL, input };
}

function echoTool(run?: (text: string, signal: AbortSignal) => Promise<string>): OrganizeTool {
  return defineTool("echo", "Repeats text.", z.object({ text: z.string() }), {
    activity: (args) => `Echoed ${args.text}`,
    run: (args, signal) => (run ? run(args.text, signal) : Promise.resolve(args.text)),
  });
}

const ITEMS: OrganizeItem[] = [
  { path: "/Inbox/r.pdf", kind: "file", size: 1536, modifiedAt: new Date("2024-03-01T10:00:00Z") },
];

function agentOptions(
  model: AiModel,
  overrides: Partial<RunOrganizeAgentOptions> = {},
): RunOrganizeAgentOptions {
  return {
    model,
    tools: [echoTool()],
    items: ITEMS,
    indexed: false,
    signal: new AbortController().signal,
    activity: () => {},
    checkAuthority: async () => {},
    ...overrides,
  };
}

function toolResults(input: AiInput | undefined) {
  if (input?.kind !== "tool_results") throw new Error(`expected tool results, got ${input?.kind}`);
  return input.results;
}

describe("initialMessage", () => {
  it("names the common parent when every item shares one", () => {
    const message = initialMessage(
      [
        { path: "/Inbox/r.pdf", kind: "file", size: 1536, modifiedAt: new Date("2024-03-01") },
        { path: "/Inbox/Old", kind: "dir", size: 0, modifiedAt: null },
      ],
      undefined,
      true,
    );

    expect(message).toBe(
      [
        "The 2 selected items, all currently in /Inbox:",
        "- /Inbox/r.pdf (1.5 KB, modified 2024-03-01)",
        "- /Inbox/Old (folder)",
        "",
        "You can read indexed text of selected files, search the drive and find similar files.",
      ].join("\n"),
    );
  });

  it("lists items from different folders without a shared heading and explains what is unavailable", () => {
    const message = initialMessage(
      [
        { path: "/Inbox/a.txt", kind: "file", size: 10, modifiedAt: null },
        { path: "/Desktop/b.txt", kind: "file", size: 20, modifiedAt: null },
      ],
      "Group by year",
      false,
    );

    expect(message).toBe(
      [
        "The 2 selected items:",
        "- /Inbox/a.txt (10 B)",
        "- /Desktop/b.txt (20 B)",
        "",
        "Extracted text and search are not available for this drive, so decide from names, types, sizes, dates and the folder structure.",
        "",
        "The person's instructions: Group by year",
      ].join("\n"),
    );
  });

  it("leaves out empty instructions", () => {
    expect(initialMessage(ITEMS, "", false)).not.toContain("instructions");
  });
});

describe("runOrganizeAgent", () => {
  it("starts the conversation with the system prompt, the tools and the submit tool", async () => {
    const { model, starts, inputs } = scriptedModel([toolTurn(submitCall("s1"))]);

    await runOrganizeAgent(agentOptions(model, { instructions: "Be brief", indexed: true }));

    expect(starts).toHaveLength(1);
    expect(starts[0]?.system).toBe(ORGANIZE_SYSTEM_PROMPT);
    expect(starts[0]?.tools.map((tool) => tool.name)).toEqual(["echo", SUBMIT_TOOL]);
    expect(starts[0]?.tools[1]?.inputSchema).toMatchObject({
      type: "object",
      required: ["summary", "moves", "unchanged"],
    });
    expect(inputs[0]).toEqual({
      kind: "user",
      text: initialMessage(ITEMS, "Be brief", true),
    });
  });

  it("runs a tool call, records its activity and sends the result back", async () => {
    const { model, inputs, signals } = scriptedModel([
      toolTurn({ id: "c1", name: "echo", input: { text: "hello" } }),
      toolTurn(submitCall("s1")),
    ]);
    const activity = vi.fn();
    const controller = new AbortController();
    const run = vi.fn(async (text: string, signal: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      return `echo: ${text}`;
    });

    const submission = await runOrganizeAgent(
      agentOptions(model, { tools: [echoTool(run)], activity, signal: controller.signal }),
    );

    expect(submission).toEqual(SUBMISSION);
    expect(activity).toHaveBeenCalledWith("Echoed hello");
    expect(toolResults(inputs[1])).toEqual([{ id: "c1", isError: false, content: "echo: hello" }]);
    expect(signals.every((signal) => signal === controller.signal)).toBe(true);
  });

  it("runs every call in a turn and returns results in call order", async () => {
    const { model, inputs } = scriptedModel([
      toolTurn(
        { id: "c1", name: "echo", input: { text: "one" } },
        { id: "c2", name: "echo", input: { text: "two" } },
      ),
      toolTurn(submitCall("s1")),
    ]);
    const activity = vi.fn();

    await runOrganizeAgent(agentOptions(model, { activity }));

    expect(toolResults(inputs[1])).toEqual([
      { id: "c1", isError: false, content: "one" },
      { id: "c2", isError: false, content: "two" },
    ]);
    expect(activity.mock.calls).toEqual([["Echoed one"], ["Echoed two"]]);
  });

  it("returns an error result for a tool that does not exist", async () => {
    const { model, inputs } = scriptedModel([
      toolTurn({ id: "c1", name: "delete_everything", input: {} }),
      toolTurn(submitCall("s1")),
    ]);

    await runOrganizeAgent(agentOptions(model));

    expect(toolResults(inputs[1])).toEqual([
      { id: "c1", isError: true, content: "There is no tool named delete_everything." },
    ]);
  });

  it("returns the validation issues for invalid arguments without running the tool", async () => {
    const run = vi.fn(async () => "ran");
    const activity = vi.fn();
    const { model, inputs } = scriptedModel([
      toolTurn(
        { id: "c1", name: "echo", input: { text: 42 } },
        { id: "c2", name: "echo", input: undefined },
      ),
      toolTurn(submitCall("s1")),
    ]);

    await runOrganizeAgent(agentOptions(model, { tools: [echoTool(run)], activity }));

    expect(toolResults(inputs[1])).toEqual([
      {
        id: "c1",
        isError: true,
        content: "Invalid arguments: text: Invalid input: expected string, received number",
      },
      {
        id: "c2",
        isError: true,
        content: "Invalid arguments: input: Invalid input: expected object, received undefined",
      },
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
  });

  it("returns safe messages for tool failures", async () => {
    const failures: Record<string, unknown> = {
      organize: new OrganizeToolError("That folder is the Trash."),
      mcp: new McpToolError("file is not indexed"),
      storage: new StorageError("forbidden", "permission denied"),
      other: new Error("connection string postgres://secret"),
    };
    const { model, inputs } = scriptedModel([
      toolTurn(
        ...Object.keys(failures).map((text) => ({ id: text, name: "echo", input: { text } })),
      ),
      toolTurn(submitCall("s1")),
    ]);
    const tool = echoTool(async (text) => {
      throw failures[text];
    });

    await runOrganizeAgent(agentOptions(model, { tools: [tool] }));

    expect(toolResults(inputs[1])).toEqual([
      { id: "organize", isError: true, content: "That folder is the Trash." },
      { id: "mcp", isError: true, content: "file is not indexed" },
      { id: "storage", isError: true, content: "Storage error (forbidden): permission denied" },
      { id: "other", isError: true, content: "The tool failed." },
    ]);
  });

  it("rethrows a tool failure once the run has been cancelled", async () => {
    const controller = new AbortController();
    const failure = new Error("aborted mid-listing");
    const { model, inputs } = scriptedModel([
      toolTurn({ id: "c1", name: "echo", input: { text: "x" } }),
    ]);
    const tool = echoTool(async () => {
      controller.abort();
      throw failure;
    });

    await expect(
      runOrganizeAgent(agentOptions(model, { tools: [tool], signal: controller.signal })),
    ).rejects.toBe(failure);
    expect(inputs).toHaveLength(1);
  });

  it("asks again when the submission is invalid", async () => {
    const { model, inputs } = scriptedModel([
      toolTurn(submitCall("s1", { summary: "Plan", moves: "all of them" })),
      toolTurn(submitCall("s2")),
    ]);

    const submission = await runOrganizeAgent(agentOptions(model));

    const [result] = toolResults(inputs[1]);
    expect(result?.id).toBe("s1");
    expect(result?.isError).toBe(true);
    expect(result?.content).toMatch(/^Invalid suggestions: moves: .+; unchanged: .+$/);
    expect(submission).toEqual(SUBMISSION);
    expect(inputs).toHaveLength(2);
  });

  it("returns a valid submission right away, even alongside other calls", async () => {
    const activity = vi.fn();
    const { model, inputs } = scriptedModel([
      toolTurn({ id: "c1", name: "echo", input: { text: "last look" } }, submitCall("s1")),
    ]);

    const submission = await runOrganizeAgent(agentOptions(model, { activity }));

    expect(submission).toEqual(SUBMISSION);
    expect(activity).toHaveBeenCalledWith("Echoed last look");
    expect(inputs).toHaveLength(1);
  });

  it("keeps the first of several valid submissions in one turn", async () => {
    const second: OrganizeSubmission = { summary: "Second", moves: [], unchanged: [] };
    const { model } = scriptedModel([toolTurn(submitCall("s1"), submitCall("s2", second))]);

    expect(await runOrganizeAgent(agentOptions(model))).toEqual(SUBMISSION);
  });

  it("fails when the provider refuses", async () => {
    const { model } = scriptedModel([textTurn("refusal")]);

    await expect(runOrganizeAgent(agentOptions(model))).rejects.toThrow(
      new OrganizeError("The AI provider declined this request."),
    );
  });

  it("fails when the answer is cut off", async () => {
    const { model } = scriptedModel([textTurn("max_tokens")]);

    const error = await runOrganizeAgent(agentOptions(model)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OrganizeError);
    expect((error as Error).message).toBe(
      "The assistant's answer was cut off. Try fewer items at once.",
    );
  });

  it("nudges the model to submit when it stops without calling a tool", async () => {
    const { model, inputs } = scriptedModel([textTurn(), textTurn(), toolTurn(submitCall("s1"))]);

    expect(await runOrganizeAgent(agentOptions(model))).toEqual(SUBMISSION);
    const nudge = {
      kind: "user",
      text: "Call submit_suggestions with your suggestions to finish.",
    };
    expect(inputs.slice(1)).toEqual([nudge, nudge]);
  });

  it("fails after the model stops without submitting three times", async () => {
    const { model, inputs } = scriptedModel([textTurn(), textTurn(), textTurn()]);

    await expect(runOrganizeAgent(agentOptions(model))).rejects.toThrow(
      new OrganizeError("The assistant stopped without suggesting anything. Try again."),
    );
    expect(inputs).toHaveLength(3);
  });

  it("fails when the model needs more turns than allowed", async () => {
    const echo = { id: "c1", name: "echo", input: { text: "again" } };
    const { model, inputs } = scriptedModel([toolTurn(echo), toolTurn(echo), toolTurn(echo)]);

    await expect(runOrganizeAgent(agentOptions(model, { maxTurns: 2 }))).rejects.toThrow(
      new OrganizeError("The assistant needed too many steps. Try fewer items at once."),
    );
    expect(inputs).toHaveLength(2);
  });

  it(`allows ${MAX_TURNS} turns by default`, async () => {
    const echo = { id: "c1", name: "echo", input: { text: "again" } };
    const { model, inputs } = scriptedModel(
      Array.from({ length: MAX_TURNS + 1 }, () => toolTurn(echo)),
    );

    await expect(runOrganizeAgent(agentOptions(model))).rejects.toThrow(OrganizeError);
    expect(inputs).toHaveLength(MAX_TURNS);
  });

  it("does not send anything once the run is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const checkAuthority = vi.fn(async () => {});
    const { model, inputs } = scriptedModel([toolTurn(submitCall("s1"))]);

    await expect(
      runOrganizeAgent(agentOptions(model, { signal: controller.signal, checkAuthority })),
    ).rejects.toThrow();
    expect(inputs).toHaveLength(0);
    expect(checkAuthority).not.toHaveBeenCalled();
  });

  it("checks authority before every turn and stops when it is lost", async () => {
    const lost = new OrganizeError("Your session ended. Sign in and try again.");
    const checkAuthority = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(lost);
    const echo = { id: "c1", name: "echo", input: { text: "x" } };
    const { model, inputs } = scriptedModel([toolTurn(echo), toolTurn(echo), toolTurn(echo)]);

    await expect(runOrganizeAgent(agentOptions(model, { checkAuthority }))).rejects.toBe(lost);
    expect(checkAuthority).toHaveBeenCalledTimes(3);
    expect(inputs).toHaveLength(2);
  });
});
