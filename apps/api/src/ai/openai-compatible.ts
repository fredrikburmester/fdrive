import { z } from "zod";
import {
  type AiConversation,
  type AiInput,
  type AiModel,
  AiProviderError,
  type AiToolSpec,
  type AiTurn,
} from "./model.ts";

export interface OpenAiCompatibleModelOptions {
  /** The API root, e.g. `http://ollama:11434/v1`; `/chat/completions` and `/models` are appended. */
  readonly baseUrl: string;
  readonly model: string;
  /** Sent as a Bearer token when set; local servers usually need none. */
  readonly apiKey: string | null;
  readonly fetch?: typeof fetch;
  /** A local model can take minutes per turn. Default 5 minutes. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const ChatResponse = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .nullable()
            .optional(),
        }),
      }),
    )
    .min(1),
});

const ModelsResponse = z.object({ data: z.array(z.object({ id: z.string() })) });

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Any server speaking OpenAI's chat completions protocol with function
 * calling: Ollama, LM Studio, vLLM, OpenRouter. Redirects are refused so the
 * key is only ever sent to the configured address.
 */
export function createOpenAiCompatibleModel(options: OpenAiCompatibleModelOptions): AiModel {
  const fetchImpl = options.fetch ?? fetch;
  const root = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        ...init,
        redirect: "error",
        headers: {
          "content-type": "application/json",
          ...(options.apiKey !== null ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AiProviderError(`Could not reach the AI server at ${root}.`);
    }
    if (response.status === 401 || response.status === 403)
      throw new AiProviderError("The AI server rejected the API key.");
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
      throw new AiProviderError(
        `The AI server returned an error (${response.status})${detail ? `: ${detail}` : "."}`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new AiProviderError("The AI server sent a response that is not JSON.");
    }
  }

  return {
    start({ system, tools }: { system: string; tools: readonly AiToolSpec[] }): AiConversation {
      const messages: ChatMessage[] = [{ role: "system", content: system }];
      return {
        async send(input: AiInput, signal: AbortSignal): Promise<AiTurn> {
          if (input.kind === "user") messages.push({ role: "user", content: input.text });
          else
            for (const result of input.results)
              messages.push({
                role: "tool",
                tool_call_id: result.id,
                content: result.isError ? `Error: ${result.content}` : result.content,
              });
          const body = await request(
            "/chat/completions",
            {
              method: "POST",
              body: JSON.stringify({
                model: options.model,
                messages,
                ...(tools.length > 0
                  ? {
                      tools: tools.map((tool) => ({
                        type: "function",
                        function: {
                          name: tool.name,
                          description: tool.description,
                          parameters: tool.inputSchema,
                        },
                      })),
                      tool_choice: "auto",
                    }
                  : {}),
              }),
            },
            signal,
          );
          const parsed = ChatResponse.safeParse(body);
          if (!parsed.success)
            throw new AiProviderError("The AI server sent a response fdrive does not understand.");
          // `.min(1)` guarantees a first choice.
          const choice = parsed.data.choices[0] as (typeof parsed.data.choices)[number];
          const calls = choice.message.tool_calls ?? [];
          const text = choice.message.content ?? "";
          messages.push({
            role: "assistant",
            content: choice.message.content ?? null,
            ...(calls.length > 0
              ? {
                  tool_calls: calls.map((call) => ({
                    id: call.id,
                    type: "function" as const,
                    function: call.function,
                  })),
                }
              : {}),
          });
          if (choice.finish_reason === "content_filter")
            return { text, toolCalls: [], stop: "refusal" };
          if (choice.finish_reason === "length") return { text, toolCalls: [], stop: "max_tokens" };
          const toolCalls = calls.map((call) => ({
            id: call.id,
            name: call.function.name,
            input: parseArguments(call.function.arguments),
          }));
          return { text, toolCalls, stop: toolCalls.length > 0 ? "tool_use" : "end_turn" };
        },
      };
    },

    async ping(signal: AbortSignal) {
      try {
        const parsed = ModelsResponse.safeParse(
          await request("/models", { method: "GET" }, signal),
        );
        if (!parsed.success) return { ok: true, message: `Connected to ${root}.` };
        return parsed.data.data.some((model) => model.id === options.model)
          ? { ok: true, message: `Connected to ${root}. ${options.model} is available.` }
          : {
              ok: false,
              message: `Connected to ${root}, but it does not list the model ${options.model}.`,
            };
      } catch (error) {
        if (error instanceof AiProviderError) return { ok: false, message: error.message };
        throw error;
      }
    },
  };
}
