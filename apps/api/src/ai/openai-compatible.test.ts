import { afterEach, describe, expect, it, vi } from "vitest";
import { AiProviderError, type AiToolSpec } from "./model.ts";
import {
  createOpenAiCompatibleModel,
  type OpenAiCompatibleModelOptions,
} from "./openai-compatible.ts";

const ROOT = "http://ollama:11434/v1";

const TOOLS: AiToolSpec[] = [
  {
    name: "list_folder",
    description: "Lists a folder.",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completion(message: Record<string, unknown>, finishReason: string | null = "stop") {
  return json({ choices: [{ finish_reason: finishReason, message }] });
}

function setup(
  replies: (Response | Error)[],
  options: Partial<Omit<OpenAiCompatibleModelOptions, "fetch">> = {},
) {
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const reply = replies.shift();
    if (reply === undefined) throw new Error("no reply queued");
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const model = createOpenAiCompatibleModel({
    baseUrl: ROOT,
    model: "llama3",
    apiKey: null,
    ...options,
    fetch: fetchImpl,
  });
  function call(index: number): { url: string; init: RequestInit; body: Record<string, unknown> } {
    const entry = fetchImpl.mock.calls[index];
    if (entry === undefined) throw new Error(`no fetch call ${index}`);
    const [url, init = {}] = entry;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    return { url: String(url), init, body };
  }
  return { model, fetchImpl, call };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

async function providerMessage(promise: Promise<unknown>): Promise<string> {
  const error = await failure(promise);
  expect(error).toBeInstanceOf(AiProviderError);
  return (error as AiProviderError).message;
}

const user = (text: string) => ({ kind: "user", text }) as const;

describe("OpenAI-compatible model", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the conversation, tools and key to the chat completions endpoint", async () => {
    const { model, call } = setup([completion({ content: "Hello" })], {
      baseUrl: `${ROOT}//`,
      apiKey: "sk-local",
    });
    const controller = new AbortController();
    const turn = await model
      .start({ system: "You organize files.", tools: TOOLS })
      .send(user("Organize."), controller.signal);

    expect(turn).toEqual({ text: "Hello", toolCalls: [], stop: "end_turn" });
    const { url, init, body } = call(0);
    expect(url).toBe(`${ROOT}/chat/completions`);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", authorization: "Bearer sk-local" },
    });
    expect(body).toEqual({
      model: "llama3",
      messages: [
        { role: "system", content: "You organize files." },
        { role: "user", content: "Organize." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "list_folder",
            description: "Lists a folder.",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
      tool_choice: "auto",
    });

    expect(init.signal?.aborted).toBe(false);
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
  });

  it("sends no authorization header without a key and no tools when there are none", async () => {
    const { model, call } = setup([completion({ content: "Hi" })]);
    await model.start({ system: "s", tools: [] }).send(user("hi"), new AbortController().signal);
    const { init, body } = call(0);
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("parses tool calls, replays them and sends tool results back", async () => {
    const { model, call } = setup([
      completion(
        {
          content: null,
          tool_calls: [
            { id: "call_1", function: { name: "list_folder", arguments: '{"path":"/"}' } },
            { id: "call_2", function: { name: "list_folder", arguments: "{not json" } },
          ],
        },
        "tool_calls",
      ),
      completion({ content: "Done." }),
    ]);
    const conversation = model.start({ system: "s", tools: TOOLS });
    const signal = new AbortController().signal;

    const first = await conversation.send(user("Organize."), signal);
    expect(first).toEqual({
      text: "",
      toolCalls: [
        { id: "call_1", name: "list_folder", input: { path: "/" } },
        { id: "call_2", name: "list_folder", input: undefined },
      ],
      stop: "tool_use",
    });
    expect(first.toolCalls[1]?.input).toBeUndefined();

    await conversation.send(
      {
        kind: "tool_results",
        results: [
          { id: "call_1", content: "[]", isError: false },
          { id: "call_2", content: "invalid arguments", isError: true },
        ],
      },
      signal,
    );
    expect(call(1).body.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "Organize." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "list_folder", arguments: '{"path":"/"}' },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "list_folder", arguments: "{not json" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "[]" },
      { role: "tool", tool_call_id: "call_2", content: "Error: invalid arguments" },
    ]);
  });

  it("sends what the person said after the tool results as a user message", async () => {
    const { model, call } = setup([
      completion(
        {
          content: null,
          tool_calls: [
            { id: "call_1", function: { name: "list_folder", arguments: '{"path":"/"}' } },
          ],
        },
        "tool_calls",
      ),
      completion({ content: "Sure." }),
    ]);
    const conversation = model.start({ system: "s", tools: TOOLS });
    const signal = new AbortController().signal;
    await conversation.send(user("Look."), signal);

    await conversation.send(
      {
        kind: "tool_results",
        results: [{ id: "call_1", content: "[]", isError: false }],
        text: "Actually, skip that and summarize.",
      },
      signal,
    );

    expect((call(1).body.messages as unknown[]).slice(-2)).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "[]" },
      { role: "user", content: "Actually, skip that and summarize." },
    ]);
  });

  it("delivers the whole reply to onText at once, and nothing for an empty reply", async () => {
    const { model } = setup([
      completion({ content: "Hello world" }),
      completion({ content: null, tool_calls: [] }, "stop"),
    ]);
    const conversation = model.start({ system: "s", tools: [] });
    const signal = new AbortController().signal;
    const onText = vi.fn();

    const first = await conversation.send(user("Hi"), signal, { onText });
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith("Hello world");
    expect(first.text).toBe("Hello world");

    await conversation.send(user("Again"), signal, { onText });
    expect(onText).toHaveBeenCalledTimes(1);
  });

  it("replays a plain assistant reply without tool calls", async () => {
    const { model, call } = setup([
      completion({ content: "First." }),
      completion({}, null),
      completion({ content: "Third." }),
    ]);
    const conversation = model.start({ system: "s", tools: [] });
    const signal = new AbortController().signal;
    await conversation.send(user("one"), signal);
    expect(await conversation.send(user("two"), signal)).toEqual({
      text: "",
      toolCalls: [],
      stop: "end_turn",
    });
    await conversation.send(user("three"), signal);
    expect(call(2).body.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "one" },
      { role: "assistant", content: "First." },
      { role: "user", content: "two" },
      { role: "assistant", content: null },
      { role: "user", content: "three" },
    ]);
  });

  it.each([
    { finishReason: "content_filter", stop: "refusal" },
    { finishReason: "length", stop: "max_tokens" },
  ])(
    "maps finish reason $finishReason to $stop and drops tool calls",
    async ({ finishReason, stop }) => {
      const { model } = setup([
        completion(
          {
            content: "partial",
            tool_calls: [{ id: "call_1", function: { name: "list_folder", arguments: "{}" } }],
          },
          finishReason,
        ),
      ]);
      expect(
        await model
          .start({ system: "s", tools: TOOLS })
          .send(user("hi"), new AbortController().signal),
      ).toEqual({ text: "partial", toolCalls: [], stop });
    },
  );

  describe("request failures", () => {
    const send = (replies: (Response | Error)[]) =>
      setup(replies)
        .model.start({ system: "s", tools: [] })
        .send(user("hi"), new AbortController().signal);

    it.each([401, 403])("reports a rejected key for status %i", async (status) => {
      expect(await providerMessage(send([json({ error: "nope" }, status)]))).toBe(
        "The AI server rejected the API key.",
      );
    });

    it("includes a trimmed, shortened body in other error responses", async () => {
      expect(
        await providerMessage(send([new Response("  model crashed \n", { status: 500 })])),
      ).toBe("The AI server returned an error (500): model crashed");
      const long = "x".repeat(500);
      expect(await providerMessage(send([new Response(long, { status: 502 })]))).toBe(
        `The AI server returned an error (502): ${"x".repeat(200)}`,
      );
    });

    it("reports an error response without a readable body", async () => {
      expect(await providerMessage(send([new Response("   ", { status: 503 })]))).toBe(
        "The AI server returned an error (503).",
      );
      const broken = new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("stream broke"));
          },
        }),
        { status: 500 },
      );
      expect(await providerMessage(send([broken]))).toBe("The AI server returned an error (500).");
    });

    it("reports an unreachable server", async () => {
      expect(await providerMessage(send([new TypeError("fetch failed")]))).toBe(
        `Could not reach the AI server at ${ROOT}.`,
      );
    });

    it("rethrows the original error once the caller has aborted", async () => {
      const controller = new AbortController();
      const abort = new DOMException("The operation was aborted.", "AbortError");
      const { model } = setup([abort]);
      controller.abort();
      expect(
        await failure(model.start({ system: "s", tools: [] }).send(user("hi"), controller.signal)),
      ).toBe(abort);
    });

    it("gives up after the configured timeout", async () => {
      const fetchImpl = vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      );
      const model = createOpenAiCompatibleModel({
        baseUrl: ROOT,
        model: "llama3",
        apiKey: null,
        fetch: fetchImpl,
        timeoutMs: 5,
      });
      expect(
        await providerMessage(
          model.start({ system: "s", tools: [] }).send(user("hi"), new AbortController().signal),
        ),
      ).toBe(`Could not reach the AI server at ${ROOT}.`);
    });

    it("reports a body that is not JSON", async () => {
      expect(await providerMessage(send([new Response("<html>oops</html>")]))).toBe(
        "The AI server sent a response that is not JSON.",
      );
    });

    it.each([
      { name: "no choices", body: { choices: [] } },
      {
        name: "a malformed tool call",
        body: { choices: [{ message: { tool_calls: [{ id: 1 }] } }] },
      },
      { name: "an unrelated object", body: { error: "busy" } },
    ])("reports a response with $name as not understood", async ({ body }) => {
      expect(await providerMessage(send([json(body)]))).toBe(
        "The AI server sent a response fdrive does not understand.",
      );
    });
  });

  describe("ping", () => {
    it("confirms the model is listed", async () => {
      const { model, call } = setup([json({ data: [{ id: "qwen3" }, { id: "llama3" }] })], {
        apiKey: "sk-local",
      });
      expect(await model.ping(new AbortController().signal)).toEqual({
        ok: true,
        message: `Connected to ${ROOT}. llama3 is available.`,
      });
      expect(call(0)).toMatchObject({
        url: `${ROOT}/models`,
        init: { method: "GET", headers: { authorization: "Bearer sk-local" } },
      });
    });

    it("fails when the server does not list the model", async () => {
      const { model } = setup([json({ data: [{ id: "qwen3" }] })]);
      expect(await model.ping(new AbortController().signal)).toEqual({
        ok: false,
        message: `Connected to ${ROOT}, but it does not list the model llama3.`,
      });
    });

    it("accepts a server whose model list it cannot read", async () => {
      const { model } = setup([json({ models: "unsupported" })]);
      expect(await model.ping(new AbortController().signal)).toEqual({
        ok: true,
        message: `Connected to ${ROOT}.`,
      });
    });

    it("reports provider errors without throwing", async () => {
      const { model } = setup([json({}, 401)]);
      expect(await model.ping(new AbortController().signal)).toEqual({
        ok: false,
        message: "The AI server rejected the API key.",
      });
    });

    it("rethrows an abort", async () => {
      const controller = new AbortController();
      const abort = new DOMException("The operation was aborted.", "AbortError");
      const { model } = setup([abort]);
      controller.abort();
      expect(await failure(model.ping(controller.signal))).toBe(abort);
    });
  });

  it("uses the global fetch when none is supplied", async () => {
    const globalFetch = vi.fn<typeof fetch>(async () => json({ data: [{ id: "llama3" }] }));
    vi.stubGlobal("fetch", globalFetch);
    const model = createOpenAiCompatibleModel({ baseUrl: ROOT, model: "llama3", apiKey: null });
    expect((await model.ping(new AbortController().signal)).ok).toBe(true);
    expect(globalFetch).toHaveBeenCalledWith(`${ROOT}/models`, expect.anything());
  });
});
