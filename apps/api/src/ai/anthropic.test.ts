import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageStreamParams,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it, vi } from "vitest";
import { type AnthropicClient, createAnthropicModel } from "./anthropic.ts";
import { AiProviderError, type AiToolSpec } from "./model.ts";

const TOOLS: AiToolSpec[] = [
  {
    name: "list_folder",
    description: "Lists a folder.",
    inputSchema: { properties: { path: { type: "string" } }, required: ["path"] },
  },
];

function message(
  content: unknown[],
  stopReason: BetaMessage["stop_reason"] = "end_turn",
): BetaMessage {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: content as BetaContentBlock[],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as BetaMessage;
}

const thinking = { type: "thinking", thinking: "Let me look.", signature: "sig-1" };
const text = (value: string) => ({ type: "text", text: value, citations: null });
const toolUse = (id: string, input: unknown) => ({
  type: "tool_use",
  id,
  name: "list_folder",
  input,
});

/** A Models API entry; by default a current model with adaptive thinking and 128k output. */
function modelInfo(
  overrides: { adaptive?: boolean; maxTokens?: number | null; noCapabilities?: true } = {},
) {
  return {
    id: "claude-opus-5",
    display_name: "Claude Opus 5",
    max_tokens: overrides.maxTokens === undefined ? 128_000 : overrides.maxTokens,
    capabilities: overrides.noCapabilities
      ? null
      : {
          thinking: {
            supported: true,
            types: { adaptive: { supported: overrides.adaptive ?? true } },
          },
        },
  };
}

/**
 * A fake SDK client that answers each streamed request with the next queued
 * message or error. Text listeners get each text block in two deltas before
 * the final message resolves, the way the real stream emits them.
 */
function fakeClient(replies: (BetaMessage | Error)[] = []) {
  const requests: BetaMessageStreamParams[] = [];
  const stream = vi.fn((params: BetaMessageStreamParams, _options: { signal: AbortSignal }) => {
    requests.push(structuredClone(params));
    const reply = replies.shift();
    const listeners: ((delta: string, snapshot: string) => void)[] = [];
    const handle = {
      on(event: string, listener: (delta: string, snapshot: string) => void) {
        if (event === "text") listeners.push(listener);
        return handle;
      },
      finalMessage: async () => {
        if (reply === undefined) throw new Error("no reply queued");
        if (reply instanceof Error) throw reply;
        for (const block of reply.content) {
          if (block.type !== "text") continue;
          const half = Math.ceil(block.text.length / 2);
          for (const listener of listeners) {
            listener(block.text.slice(0, half), block.text.slice(0, half));
            listener(block.text.slice(half), block.text);
          }
        }
        return reply;
      },
    };
    return handle;
  });
  const retrieve = vi.fn().mockResolvedValue(modelInfo());
  const client = {
    beta: { messages: { stream } },
    models: { retrieve },
  } as unknown as AnthropicClient;
  return { client, stream, retrieve, requests };
}

function request(requests: BetaMessageStreamParams[], index: number): BetaMessageStreamParams {
  const params = requests[index];
  if (params === undefined) throw new Error(`no request ${index}`);
  return params;
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("Anthropic model", () => {
  it("sends the first request with caching, tools, adaptive thinking and fallbacks", async () => {
    const fake = fakeClient([message([text("Hi")])]);
    const model = createAnthropicModel({
      apiKey: "sk",
      model: "claude-opus-5",
      client: fake.client,
    });
    const controller = new AbortController();
    await model
      .start({ system: "You organize files.", tools: TOOLS })
      .send({ kind: "user", text: "Organize these." }, controller.signal);

    expect(request(fake.requests, 0)).toEqual({
      model: "claude-opus-5",
      max_tokens: 32_000,
      system: "You organize files.",
      messages: [{ role: "user", content: "Organize these." }],
      cache_control: { type: "ephemeral" },
      tools: [
        {
          name: "list_folder",
          description: "Lists a folder.",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
      thinking: { type: "adaptive" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    expect(fake.stream.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });

  it.each([
    {
      model: "claude-fable-5-1",
      info: modelInfo(),
      thinking: true,
      maxTokens: 32_000,
      fallbacks: true,
    },
    {
      model: "claude-sonnet-5",
      info: modelInfo(),
      thinking: true,
      maxTokens: 32_000,
      fallbacks: false,
    },
    {
      model: "claude-sonnet-4-5",
      info: modelInfo({ adaptive: false, maxTokens: 64_000 }),
      thinking: false,
      maxTokens: 32_000,
      fallbacks: false,
    },
    {
      model: "claude-3-haiku-20240307",
      info: modelInfo({ noCapabilities: true, maxTokens: 4_096 }),
      thinking: false,
      maxTokens: 4_096,
      fallbacks: false,
    },
    {
      model: "claude-next",
      info: modelInfo({ maxTokens: null }),
      thinking: true,
      maxTokens: 32_000,
      fallbacks: false,
    },
  ])(
    "configures thinking, output and fallbacks for $model from its model entry",
    async (expected) => {
      const fake = fakeClient([message([text("Hi")])]);
      fake.retrieve.mockResolvedValue(expected.info);
      const model = createAnthropicModel({
        apiKey: "sk",
        model: expected.model,
        client: fake.client,
      });
      await model
        .start({ system: "s", tools: [] })
        .send({ kind: "user", text: "hi" }, new AbortController().signal);

      const params = request(fake.requests, 0);
      expect(params).not.toHaveProperty("tools");
      expect(params.max_tokens).toBe(expected.maxTokens);
      if (expected.thinking) expect(params.thinking).toEqual({ type: "adaptive" });
      else expect(params).not.toHaveProperty("thinking");
      if (expected.fallbacks) {
        expect(params).toMatchObject({
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        });
      } else {
        expect(params).not.toHaveProperty("betas");
        expect(params).not.toHaveProperty("fallbacks");
      }
    },
  );

  it("replays the assistant turn unchanged and sends tool results back", async () => {
    const firstContent = [thinking, text("Looking around."), toolUse("toolu_1", { path: "/" })];
    const fake = fakeClient([message(firstContent, "tool_use"), message([text("Done.")])]);
    const conversation = createAnthropicModel({
      apiKey: "sk",
      model: "claude-opus-5",
      client: fake.client,
    }).start({ system: "s", tools: TOOLS });
    const signal = new AbortController().signal;

    const first = await conversation.send({ kind: "user", text: "Organize." }, signal);
    expect(first).toEqual({
      text: "Looking around.",
      toolCalls: [{ id: "toolu_1", name: "list_folder", input: { path: "/" } }],
      stop: "tool_use",
    });

    const second = await conversation.send(
      {
        kind: "tool_results",
        results: [
          { id: "toolu_1", content: "[]", isError: false },
          { id: "toolu_2", content: "not found", isError: true },
        ],
      },
      signal,
    );
    expect(second).toEqual({ text: "Done.", toolCalls: [], stop: "end_turn" });
    expect(fake.retrieve).toHaveBeenCalledTimes(1);
    expect(fake.retrieve).toHaveBeenCalledWith("claude-opus-5", {}, { signal });
    expect(request(fake.requests, 1).messages).toEqual([
      { role: "user", content: "Organize." },
      { role: "assistant", content: firstContent },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "[]", is_error: false },
          { type: "tool_result", tool_use_id: "toolu_2", content: "not found", is_error: true },
        ],
      },
    ]);
  });

  it("adds what the person said after the tool results, in the same turn", async () => {
    const fake = fakeClient([
      message([toolUse("toolu_1", { path: "/" })], "tool_use"),
      message([text("Sure.")]),
    ]);
    const conversation = createAnthropicModel({
      apiKey: "sk",
      model: "claude-opus-5",
      client: fake.client,
    }).start({ system: "s", tools: TOOLS });
    const signal = new AbortController().signal;
    await conversation.send({ kind: "user", text: "Look." }, signal);

    await conversation.send(
      {
        kind: "tool_results",
        results: [{ id: "toolu_1", content: "[]", isError: false }],
        text: "Actually, skip that and summarize.",
      },
      signal,
    );

    expect(request(fake.requests, 1).messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "[]", is_error: false },
        { type: "text", text: "Actually, skip that and summarize." },
      ],
    });
  });

  it("replays stored history as plain messages before the new one", async () => {
    const fake = fakeClient([message([text("Still here.")])]);
    const conversation = createAnthropicModel({
      apiKey: "sk",
      model: "claude-opus-5",
      client: fake.client,
    }).start({
      system: "s",
      tools: [],
      history: [
        { role: "user", text: "What is this?" },
        { role: "assistant", text: "An invoice." },
      ],
    });

    await conversation.send({ kind: "user", text: "And now?" }, new AbortController().signal);

    expect(request(fake.requests, 0).messages).toEqual([
      { role: "user", content: "What is this?" },
      { role: "assistant", content: "An invoice." },
      { role: "user", content: "And now?" },
    ]);
  });

  it("streams text deltas to onText before the turn resolves", async () => {
    const fake = fakeClient([message([thinking, text("Hello"), text("world")])]);
    const conversation = createAnthropicModel({
      apiKey: "sk",
      model: "claude-opus-5",
      client: fake.client,
    }).start({ system: "s", tools: [] });
    const deltas: string[] = [];

    const turn = await conversation.send(
      { kind: "user", text: "Hi" },
      new AbortController().signal,
      { onText: (delta) => deltas.push(delta) },
    );

    expect(deltas).toEqual(["Hel", "lo", "wor", "ld"]);
    expect(turn.text).toBe("Hello\nworld");
  });

  it.each([
    {
      name: "joins text blocks for a finished turn",
      reply: message([thinking, text("One."), text("Two.")], "end_turn"),
      turn: { text: "One.\nTwo.", toolCalls: [], stop: "end_turn" },
    },
    {
      name: "drops tool calls from a refusal",
      reply: message([text("I can't help."), toolUse("toolu_1", {})], "refusal"),
      turn: { text: "I can't help.", toolCalls: [], stop: "refusal" },
    },
    {
      name: "drops tool calls from a turn cut off at max tokens",
      reply: message([toolUse("toolu_1", {})], "max_tokens"),
      turn: { text: "", toolCalls: [], stop: "max_tokens" },
    },
    {
      name: "reports tool use whenever the turn holds tool calls",
      reply: message([toolUse("toolu_1", { path: "/a" })], "pause_turn"),
      turn: {
        text: "",
        toolCalls: [{ id: "toolu_1", name: "list_folder", input: { path: "/a" } }],
        stop: "tool_use",
      },
    },
  ])("$name", async ({ reply, turn }) => {
    const fake = fakeClient([reply]);
    const conversation = createAnthropicModel({
      apiKey: "sk",
      model: "claude-sonnet-5",
      client: fake.client,
    }).start({ system: "s", tools: TOOLS });
    expect(
      await conversation.send({ kind: "user", text: "hi" }, new AbortController().signal),
    ).toEqual(turn);
  });

  describe("errors", () => {
    const headers = new Headers();

    it.each([
      {
        name: "an authentication error",
        error: new Anthropic.AuthenticationError(401, {}, "bad key", headers),
        message: "Anthropic rejected the API key.",
      },
      {
        name: "a permission error",
        error: new Anthropic.PermissionDeniedError(403, {}, "denied", headers),
        message: "Anthropic rejected the API key.",
      },
      {
        name: "an unknown model",
        error: new Anthropic.NotFoundError(404, {}, "no model", headers),
        message: "Anthropic does not recognize this model.",
      },
      {
        name: "rate limiting",
        error: new Anthropic.RateLimitError(429, {}, "slow down", headers),
        message: "Anthropic is rate limiting requests. Try again in a minute.",
      },
      {
        name: "a connection failure",
        error: new Anthropic.APIConnectionError({ message: "socket hang up" }),
        message: "Could not reach Anthropic.",
      },
      {
        name: "a server error",
        error: new Anthropic.InternalServerError(500, {}, "overloaded", headers),
        message: "Anthropic returned an error (500).",
      },
      {
        name: "an API error without a status",
        error: new Anthropic.APIError(undefined, undefined, "odd", undefined),
        message: "Anthropic returned an error (unknown).",
      },
    ])("maps $name to a safe provider error", async ({ error, message: expected }) => {
      const fake = fakeClient([error]);
      const conversation = createAnthropicModel({
        apiKey: "sk-secret",
        model: "claude-opus-5",
        client: fake.client,
      }).start({ system: "s", tools: [] });
      const thrown = await failure(
        conversation.send({ kind: "user", text: "hi" }, new AbortController().signal),
      );
      expect(thrown).toBeInstanceOf(AiProviderError);
      expect((thrown as AiProviderError).message).toBe(expected);
    });

    it("maps a model lookup failure before sending anything", async () => {
      const fake = fakeClient([message([text("never sent")])]);
      fake.retrieve.mockRejectedValue(new Anthropic.NotFoundError(404, {}, "no model", headers));
      const conversation = createAnthropicModel({
        apiKey: "sk",
        model: "claude-typo",
        client: fake.client,
      }).start({ system: "s", tools: [] });
      const thrown = await failure(
        conversation.send({ kind: "user", text: "hi" }, new AbortController().signal),
      );
      expect((thrown as AiProviderError).message).toBe("Anthropic does not recognize this model.");
      expect(fake.stream).not.toHaveBeenCalled();
    });

    it.each([
      { name: "a user abort", error: new Anthropic.APIUserAbortError() },
      { name: "a non-SDK error", error: new TypeError("boom") },
    ])("rethrows $name unchanged", async ({ error }) => {
      const fake = fakeClient([error]);
      const conversation = createAnthropicModel({
        apiKey: "sk",
        model: "claude-opus-5",
        client: fake.client,
      }).start({ system: "s", tools: [] });
      expect(
        await failure(
          conversation.send({ kind: "user", text: "hi" }, new AbortController().signal),
        ),
      ).toBe(error);
    });
  });

  describe("ping", () => {
    it("names the model when it is available", async () => {
      const fake = fakeClient();
      fake.retrieve.mockResolvedValue({ id: "claude-opus-5", display_name: "Claude Opus 5" });
      const model = createAnthropicModel({
        apiKey: "sk",
        model: "claude-opus-5",
        client: fake.client,
      });
      const signal = new AbortController().signal;
      expect(await model.ping(signal)).toEqual({
        ok: true,
        message: "Connected to Anthropic. Claude Opus 5 is available.",
      });
      expect(fake.retrieve).toHaveBeenCalledWith("claude-opus-5", {}, { signal });
    });

    it("reports a provider failure without throwing", async () => {
      const fake = fakeClient();
      fake.retrieve.mockRejectedValue(
        new Anthropic.AuthenticationError(401, {}, "bad", new Headers()),
      );
      const model = createAnthropicModel({
        apiKey: "sk",
        model: "claude-opus-5",
        client: fake.client,
      });
      expect(await model.ping(new AbortController().signal)).toEqual({
        ok: false,
        message: "Anthropic rejected the API key.",
      });
    });

    it("rethrows failures that are not provider errors", async () => {
      const fake = fakeClient();
      const abort = new Anthropic.APIUserAbortError();
      fake.retrieve.mockRejectedValue(abort);
      const model = createAnthropicModel({
        apiKey: "sk",
        model: "claude-opus-5",
        client: fake.client,
      });
      expect(await failure(model.ping(new AbortController().signal))).toBe(abort);
    });
  });

  it("builds the official SDK client when none is supplied", () => {
    const model = createAnthropicModel({ apiKey: "x", model: "m" });
    expect(model.start).toBeTypeOf("function");
    expect(model.ping).toBeTypeOf("function");
  });
});
