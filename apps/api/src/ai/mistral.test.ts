import { afterEach, describe, expect, it, vi } from "vitest";
import { createMistralModel, MISTRAL_API_URL, type MistralModelOptions } from "./mistral.ts";
import { AiProviderError, type AiToolSpec } from "./model.ts";

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
  return json({
    id: "cmpl-1",
    object: "chat.completion",
    model: "mistral-large-latest",
    choices: [
      { index: 0, finish_reason: finishReason, message: { role: "assistant", ...message } },
    ],
  });
}

const thinking = (text: string) => ({ type: "thinking", thinking: [{ type: "text", text }] });

function call(id: string, path: string) {
  return {
    id,
    type: "function",
    function: { name: "list_folder", arguments: `{"path":"${path}"}` },
  };
}

type Message = Record<string, unknown>;

const ORDER: Record<string, readonly string[]> = {
  system: ["user", "assistant", "system"],
  user: ["assistant", "system", "user"],
  assistant: ["assistant", "user", "tool"],
  tool: ["assistant", "tool", "user"],
};

/**
 * The serving checks Mistral's API applies before generating, transcribed
 * from mistral-common's `MistralRequestValidator`: role order, tool results
 * paired with pending calls by id, function names, assistant chunk types and
 * the last role. Returns the error Mistral would answer with, or null.
 */
function mistralViolation(messages: readonly Message[]): string | null {
  const pending = new Set<string>();
  let previous: string | null = null;
  for (const message of messages) {
    const role = String(message.role);
    if (previous !== null && !ORDER[previous]?.includes(role))
      return `Unexpected role '${role}' after role '${previous}'`;
    if (role === "assistant") {
      if (pending.size > 0) return "Not the same number of function calls and responses";
      const calls = (message.tool_calls ?? []) as { id: string; function: { name: string } }[];
      for (const entry of calls) {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(entry.function.name))
          return `Function name was ${entry.function.name}`;
        if (entry.id === "" || entry.id === "null" || pending.has(entry.id))
          return `Duplicate tool call id ${entry.id} in assistant message`;
        pending.add(entry.id);
      }
      if (Array.isArray(message.content))
        for (const chunk of message.content as { type: string }[])
          if (chunk.type !== "text" && chunk.type !== "thinking")
            return `Unexpected content chunk types in assistant message: ${chunk.type}`;
    }
    if (role === "tool" && !pending.delete(String(message.tool_call_id)))
      return `Unexpected tool call id ${String(message.tool_call_id)} in tool results`;
    previous = role;
  }
  if (previous !== "user" && previous !== "tool")
    return `Expected last role User or Tool (or Assistant with prefix) for serving but got ${previous}`;
  if (pending.size > 0) return "Not the same number of function calls and responses";
  return null;
}

function setup(
  replies: (Response | Error)[],
  options: Partial<Omit<MistralModelOptions, "fetch">> = {},
) {
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    if (typeof init?.body === "string") {
      const violation = mistralViolation(JSON.parse(init.body).messages);
      if (violation !== null)
        return json({ object: "error", message: violation, type: "invalid_request_message" }, 400);
    }
    const reply = replies.shift();
    if (reply === undefined) throw new Error("no reply queued");
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const model = createMistralModel({
    apiKey: "mistral-key",
    model: "mistral-large-latest",
    ...options,
    fetch: fetchImpl,
  });
  function request(index: number): { url: string; init: RequestInit; body: Message } {
    const entry = fetchImpl.mock.calls[index];
    if (entry === undefined) throw new Error(`no fetch call ${index}`);
    const [url, init = {}] = entry;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    return { url: String(url), init, body };
  }
  return { model, fetchImpl, request };
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

describe("Mistral's message rules, as the tests check them", () => {
  it.each([
    { name: "a tool result before any call", messages: [{ role: "tool", tool_call_id: "a" }] },
    {
      name: "a reply before every call has its result",
      messages: [
        { role: "user" },
        { role: "assistant", tool_calls: [call("a", "/"), call("b", "/")] },
        { role: "tool", tool_call_id: "a" },
        { role: "assistant", content: "Done." },
        { role: "user" },
      ],
    },
    {
      name: "a system message after a reply",
      messages: [{ role: "user" }, { role: "assistant" }, { role: "system" }, { role: "user" }],
    },
    { name: "an assistant message last", messages: [{ role: "user" }, { role: "assistant" }] },
    {
      name: "an unknown chunk type",
      messages: [
        { role: "user" },
        { role: "assistant", content: [{ type: "image_url" }] },
        { role: "user" },
      ],
    },
  ])("rejects $name", ({ messages }) => {
    expect(mistralViolation(messages)).not.toBeNull();
  });
});

describe("Mistral model", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the conversation, tools and key to Mistral's chat completions endpoint", async () => {
    const { model, request } = setup([completion({ content: "Hello" })]);
    const controller = new AbortController();
    const turn = await model
      .start({ system: "You organize files.", tools: TOOLS })
      .send(user("Organize."), controller.signal);

    expect(turn).toEqual({ text: "Hello", toolCalls: [], stop: "end_turn" });
    const { url, init, body } = request(0);
    expect(url).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", authorization: "Bearer mistral-key" },
    });
    expect(body).toEqual({
      model: "mistral-large-latest",
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

  it("offers no tools when there are none and trims a trailing slash from the address", async () => {
    const { model, request } = setup([completion({ content: "Hi" })], {
      baseUrl: "http://mistral.test/v1//",
    });
    await model.start({ system: "s", tools: [] }).send(user("hi"), new AbortController().signal);
    const { url, body } = request(0);
    expect(url).toBe("http://mistral.test/v1/chat/completions");
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("parses tool calls, replays them and sends tool results back", async () => {
    const { model, request } = setup([
      completion(
        {
          content: "",
          tool_calls: [
            call("D681PevKs", "/"),
            { id: "Xk29sLq01", function: { name: "list_folder", arguments: { path: "/b" } } },
            { id: "Pq81mZx77", function: { name: "list_folder", arguments: "{not json" } },
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
        { id: "D681PevKs", name: "list_folder", input: { path: "/" } },
        { id: "Xk29sLq01", name: "list_folder", input: { path: "/b" } },
        { id: "Pq81mZx77", name: "list_folder", input: undefined },
      ],
      stop: "tool_use",
    });

    await conversation.send(
      {
        kind: "tool_results",
        results: [
          { id: "D681PevKs", content: "[]", isError: false },
          { id: "Xk29sLq01", content: "[]", isError: false },
          { id: "Pq81mZx77", content: "invalid arguments", isError: true },
        ],
      },
      signal,
    );
    expect(request(1).body.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "Organize." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "D681PevKs",
            type: "function",
            function: { name: "list_folder", arguments: '{"path":"/"}' },
          },
          {
            id: "Xk29sLq01",
            type: "function",
            function: { name: "list_folder", arguments: '{"path":"/b"}' },
          },
          {
            id: "Pq81mZx77",
            type: "function",
            function: { name: "list_folder", arguments: "{not json" },
          },
        ],
      },
      { role: "tool", tool_call_id: "D681PevKs", content: "[]" },
      { role: "tool", tool_call_id: "Xk29sLq01", content: "[]" },
      { role: "tool", tool_call_id: "Pq81mZx77", content: "Error: invalid arguments" },
    ]);
  });

  it("reads the text of a reasoning reply and replays its thinking unchanged", async () => {
    const reasoning = [
      { ...thinking("The user wants folders."), signature: "opaque" },
      { type: "text", text: "I will look " },
      { type: "text", text: "first." },
    ];
    const { model, request } = setup([
      completion({ content: reasoning, tool_calls: [call("D681PevKs", "/")] }, "tool_calls"),
      completion({ content: [thinking("Nothing else to check.")] }),
      completion({ content: "Done." }),
    ]);
    const conversation = model.start({ system: "s", tools: TOOLS });
    const signal = new AbortController().signal;
    const onText = vi.fn();

    const first = await conversation.send(user("Organize."), signal, { onText });
    expect(first).toMatchObject({ text: "I will look first.", stop: "tool_use" });
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith("I will look first.");

    const second = await conversation.send(
      { kind: "tool_results", results: [{ id: "D681PevKs", content: "[]", isError: false }] },
      signal,
      { onText },
    );
    expect(second).toEqual({ text: "", toolCalls: [], stop: "end_turn" });
    expect(onText).toHaveBeenCalledTimes(1);

    await conversation.send(user("Thanks."), signal);
    const messages = request(2).body.messages as Message[];
    expect(messages[2]).toEqual({
      role: "assistant",
      content: reasoning,
      tool_calls: [
        {
          id: "D681PevKs",
          type: "function",
          function: { name: "list_folder", arguments: '{"path":"/"}' },
        },
      ],
    });
    expect(messages[4]).toEqual({
      role: "assistant",
      content: [thinking("Nothing else to check.")],
    });
  });

  it("follows tool results with what the person said in the same request", async () => {
    const { model, request } = setup([
      completion({ content: null, tool_calls: [call("D681PevKs", "/")] }, "tool_calls"),
      completion({ content: "Sure." }),
    ]);
    const conversation = model.start({ system: "s", tools: TOOLS });
    const signal = new AbortController().signal;
    await conversation.send(user("Look."), signal);

    await conversation.send(
      {
        kind: "tool_results",
        results: [
          { id: "D681PevKs", content: "Not applied: a newer message arrived.", isError: false },
        ],
        text: "Actually, summarize instead.",
      },
      signal,
    );

    expect((request(1).body.messages as Message[]).slice(-2)).toEqual([
      { role: "tool", tool_call_id: "D681PevKs", content: "Not applied: a newer message arrived." },
      { role: "user", content: "Actually, summarize instead." },
    ]);
  });

  it("replays stored history after the system prompt", async () => {
    const { model, request } = setup([completion({ content: "Still here." })]);
    const conversation = model.start({
      system: "s",
      tools: [],
      history: [
        { role: "user", text: "What is this?" },
        { role: "assistant", text: "An invoice." },
      ],
    });

    await conversation.send(user("And now?"), new AbortController().signal);

    expect(request(0).body.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "What is this?" },
      { role: "assistant", content: "An invoice." },
      { role: "user", content: "And now?" },
    ]);
  });

  it.each(["length", "model_length"])(
    "reports finish reason %s as cut off and never replays its unanswered calls",
    async (finishReason) => {
      const { model, request } = setup([
        completion({ content: "partial", tool_calls: [call("D681PevKs", "/")] }, finishReason),
        completion({ content: "Shorter." }),
      ]);
      const conversation = model.start({ system: "s", tools: TOOLS });
      const signal = new AbortController().signal;

      expect(await conversation.send(user("hi"), signal)).toEqual({
        text: "partial",
        toolCalls: [],
        stop: "max_tokens",
      });
      expect((await conversation.send(user("Less, please."), signal)).text).toBe("Shorter.");
      expect((request(1).body.messages as Message[]).slice(-2)).toEqual([
        { role: "assistant", content: "partial" },
        { role: "user", content: "Less, please." },
      ]);
    },
  );

  it("fails a turn Mistral could not finish and keeps nothing of it", async () => {
    const { model, request } = setup([
      completion({ content: "half" }, "error"),
      completion({ content: "Recovered." }),
    ]);
    const conversation = model.start({ system: "s", tools: [] });
    const signal = new AbortController().signal;

    expect(await providerMessage(conversation.send(user("one"), signal))).toBe(
      "Mistral failed while answering. Try again.",
    );
    expect((await conversation.send(user("two"), signal)).text).toBe("Recovered.");
    expect(request(1).body.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "one" },
      { role: "user", content: "two" },
    ]);
  });

  it("keeps every request within Mistral's message rules across a long chat", async () => {
    const { model, fetchImpl } = setup([
      completion(
        {
          content: [thinking("Look around."), { type: "text", text: "Checking." }],
          tool_calls: [call("A00000001", "/"), call("A00000002", "/docs")],
        },
        "tool_calls",
      ),
      completion({ content: null, tool_calls: [call("A00000003", "/docs/old")] }, "tool_calls"),
      completion({ content: "", tool_calls: [call("A00000004", "/")] }, "length"),
      completion({ content: null }),
      completion(
        { content: [thinking("Plan.")], tool_calls: [call("A00000005", "/")] },
        "tool_calls",
      ),
      completion({ content: "All done." }),
    ]);
    const conversation = model.start({
      system: "s",
      tools: TOOLS,
      history: [
        { role: "user", text: "Earlier question" },
        { role: "assistant", text: "Earlier answer" },
      ],
    });
    const signal = new AbortController().signal;
    const result = (id: string) => ({ id, content: "[]", isError: false });

    await conversation.send(user("Sort these."), signal);
    await conversation.send(
      { kind: "tool_results", results: [result("A00000001"), result("A00000002")] },
      signal,
    );
    await conversation.send(
      { kind: "tool_results", results: [result("A00000003")], text: "Skip old files." },
      signal,
    );
    await conversation.send(user("Try again, shorter."), signal);
    await conversation.send(user("Go on."), signal);
    const last = await conversation.send(
      { kind: "tool_results", results: [result("A00000005")] },
      signal,
    );

    expect(last.text).toBe("All done.");
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  describe("request failures", () => {
    const send = (replies: (Response | Error)[]) =>
      setup(replies)
        .model.start({ system: "s", tools: [] })
        .send(user("hi"), new AbortController().signal);

    it.each([401, 403])("reports a rejected key for status %i", async (status) => {
      expect(await providerMessage(send([json({ detail: "Invalid API Key" }, status)]))).toBe(
        "Mistral rejected the API key.",
      );
    });

    it("reports rate limiting", async () => {
      expect(
        await providerMessage(send([json({ message: "Requests rate limit exceeded" }, 429)])),
      ).toBe("Mistral is rate limiting requests. Try again in a minute.");
    });

    it.each([
      {
        name: "an API error message",
        reply: json(
          { object: "error", message: "Invalid model: mistral-huge", type: "invalid_model" },
          400,
        ),
        message: "Mistral returned an error (400): Invalid model: mistral-huge",
      },
      {
        name: "a validation error",
        reply: json(
          { detail: [{ loc: ["body", "model"], msg: "Field required", type: "missing" }] },
          422,
        ),
        message: "Mistral returned an error (422): Field required",
      },
      {
        name: "a text detail",
        reply: json({ detail: "Service unavailable" }, 503),
        message: "Mistral returned an error (503): Service unavailable",
      },
      {
        name: "an empty validation list",
        reply: json({ detail: [] }, 422),
        message: 'Mistral returned an error (422): {"detail":[]}',
      },
      {
        name: "plain text",
        reply: new Response(`  ${"x".repeat(300)} \n`, { status: 502 }),
        message: `Mistral returned an error (502): ${"x".repeat(200)}`,
      },
      {
        name: "an empty body",
        reply: new Response("   ", { status: 500 }),
        message: "Mistral returned an error (500).",
      },
    ])("explains an error response with $name", async ({ reply, message }) => {
      expect(await providerMessage(send([reply]))).toBe(message);
    });

    it("reports an error response whose body cannot be read", async () => {
      const broken = new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("stream broke"));
          },
        }),
        { status: 500 },
      );
      expect(await providerMessage(send([broken]))).toBe("Mistral returned an error (500).");
    });

    it("reports an unreachable API", async () => {
      expect(await providerMessage(send([new TypeError("fetch failed")]))).toBe(
        "Could not reach Mistral.",
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
      const model = createMistralModel({
        apiKey: "mistral-key",
        model: "mistral-large-latest",
        fetch: fetchImpl,
        timeoutMs: 5,
      });
      expect(
        await providerMessage(
          model.start({ system: "s", tools: [] }).send(user("hi"), new AbortController().signal),
        ),
      ).toBe("Mistral did not answer in time.");
    });

    it("reports a body that is not JSON", async () => {
      expect(await providerMessage(send([new Response("<html>oops</html>")]))).toBe(
        "Mistral sent a response that is not JSON.",
      );
    });

    it.each([
      { name: "no choices", body: { choices: [] } },
      {
        name: "a malformed tool call",
        body: { choices: [{ message: { tool_calls: [{ id: 1 }] } }] },
      },
      { name: "content of another shape", body: { choices: [{ message: { content: 7 } }] } },
      { name: "an unrelated object", body: { error: "busy" } },
    ])("reports a response with $name as not understood", async ({ body }) => {
      expect(await providerMessage(send([json(body)]))).toBe(
        "Mistral sent a response fdrive does not understand.",
      );
    });
  });

  describe("ping", () => {
    const card = (id: string, aliases: string[] = [], functionCalling = true) => ({
      id,
      object: "model",
      aliases,
      capabilities: { completion_chat: true, function_calling: functionCalling },
    });

    it("confirms the model is listed for the key", async () => {
      const { model, request } = setup([
        json({
          object: "list",
          data: [card("mistral-small-latest"), card("mistral-large-latest")],
        }),
      ]);
      expect(await model.ping(new AbortController().signal)).toEqual({
        ok: true,
        message: "Connected to Mistral. mistral-large-latest is available.",
      });
      expect(request(0)).toMatchObject({
        url: `${MISTRAL_API_URL}/models`,
        init: { method: "GET", headers: { authorization: "Bearer mistral-key" } },
      });
    });

    it("finds a model by its alias in a bare list", async () => {
      const { model } = setup([json([card("mistral-large-4-0", ["mistral-large-latest"])])]);
      expect((await model.ping(new AbortController().signal)).ok).toBe(true);
    });

    it("fails when the key cannot use the model", async () => {
      const { model } = setup([
        json({ data: [{ id: "mistral-small-2603" }, card("mistral-small-latest")] }),
      ]);
      expect(await model.ping(new AbortController().signal)).toEqual({
        ok: false,
        message: "Connected to Mistral, but this key cannot use the model mistral-large-latest.",
      });
    });

    it("fails for a model that cannot call tools", async () => {
      const { model } = setup([json({ data: [card("mistral-large-latest", [], false)] })], {});
      expect(await model.ping(new AbortController().signal)).toEqual({
        ok: false,
        message:
          "Connected to Mistral, but mistral-large-latest cannot call tools, which Organize and Chat need.",
      });
    });

    it("accepts a model whose capabilities are not listed", async () => {
      const { model } = setup([json({ data: [{ id: "mistral-large-latest", aliases: null }] })]);
      expect((await model.ping(new AbortController().signal)).ok).toBe(true);
    });

    it("accepts a model list it cannot read", async () => {
      const { model } = setup([json({ models: "unsupported" })]);
      expect(await model.ping(new AbortController().signal)).toEqual({
        ok: true,
        message: "Connected to Mistral.",
      });
    });

    it("reports provider errors without throwing", async () => {
      const { model } = setup([json({ detail: "Invalid API Key" }, 401)]);
      expect(await model.ping(new AbortController().signal)).toEqual({
        ok: false,
        message: "Mistral rejected the API key.",
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
    const globalFetch = vi.fn<typeof fetch>(async () =>
      json({ data: [{ id: "mistral-large-latest" }] }),
    );
    vi.stubGlobal("fetch", globalFetch);
    const model = createMistralModel({ apiKey: "mistral-key", model: "mistral-large-latest" });
    expect((await model.ping(new AbortController().signal)).ok).toBe(true);
    expect(globalFetch).toHaveBeenCalledWith(`${MISTRAL_API_URL}/models`, expect.anything());
  });
});
