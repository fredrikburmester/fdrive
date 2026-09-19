import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiModel } from "./provider.ts";

function modelsResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("createAiModel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("talks to Anthropic with the saved key for the anthropic provider", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "");
    const globalFetch = vi.fn<typeof fetch>(async () =>
      modelsResponse({
        type: "model",
        id: "claude-opus-5",
        display_name: "Claude Opus 5",
        created_at: "2026-01-01T00:00:00Z",
      }),
    );
    vi.stubGlobal("fetch", globalFetch);
    const model = createAiModel({
      provider: "anthropic",
      model: "claude-opus-5",
      baseUrl: null,
      apiKey: "sk-ant-1",
      chat: true,
    });

    expect(await model.ping(new AbortController().signal)).toEqual({
      ok: true,
      message: "Connected to Anthropic. Claude Opus 5 is available.",
    });
    const [url, init] = globalFetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.anthropic.com/v1/models/claude-opus-5");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("sk-ant-1");
  });

  it("still builds an Anthropic model when the key is missing", () => {
    const model = createAiModel({
      provider: "anthropic",
      model: "claude-opus-5",
      baseUrl: null,
      apiKey: null,
      chat: true,
    });
    expect(model.ping).toBeTypeOf("function");
  });

  it("talks to the configured address for an OpenAI-compatible provider", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => modelsResponse({ data: [{ id: "llama3" }] }));
    const model = createAiModel(
      {
        provider: "openai_compatible",
        model: "llama3",
        baseUrl: "http://ollama:11434/v1",
        apiKey: "sk-local",
        chat: true,
      },
      { fetch: fetchImpl },
    );

    expect(await model.ping(new AbortController().signal)).toEqual({
      ok: true,
      message: "Connected to http://ollama:11434/v1. llama3 is available.",
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("http://ollama:11434/v1/models");
    expect(init?.headers).toMatchObject({ authorization: "Bearer sk-local" });
  });

  it("falls back to the global fetch for an OpenAI-compatible provider", async () => {
    const globalFetch = vi.fn<typeof fetch>(async () => modelsResponse({ data: [] }));
    vi.stubGlobal("fetch", globalFetch);
    // `resolved()` never hands over an OpenAI-compatible config without an address; this only
    // checks the adapter is still built rather than crashing.
    const model = createAiModel({
      provider: "openai_compatible",
      model: "llama3",
      baseUrl: null,
      apiKey: null,
      chat: true,
    });

    expect((await model.ping(new AbortController().signal)).ok).toBe(false);
    expect(globalFetch).toHaveBeenCalledWith("/models", expect.anything());
  });
});
