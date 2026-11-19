import { z } from "zod";
import {
  type AiConversation,
  type AiInput,
  type AiModel,
  AiProviderError,
  type AiSendOptions,
  type AiStartOptions,
  type AiTurn,
} from "./model.ts";
import { parseArguments, toolDefinitions } from "./openai-compatible.ts";

/** Mistral's API root; `/chat/completions` and `/models` are appended. */
export const MISTRAL_API_URL = "https://api.mistral.ai/v1";

export interface MistralModelOptions {
  readonly apiKey: string;
  readonly model: string;
  /** Overridable for tests; defaults to Mistral's API. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** A reasoning model can think for minutes per turn. Default 5 minutes. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * One piece of a reply. Reasoning models send a `thinking` chunk before the
 * text. Chunks keep every field so they replay exactly as Mistral sent them:
 * its docs warn that dropping the thinking degrades later turns.
 */
const Chunk = z.looseObject({ type: z.string() });

type Content = string | z.infer<typeof Chunk>[] | null;

const ChatResponse = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({
          content: z.union([z.string(), z.array(Chunk)]).nullish(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                function: z.object({
                  name: z.string(),
                  // Documented as a JSON string; Mistral's own SDK also accepts an object.
                  arguments: z.union([z.string(), z.record(z.string(), z.unknown())]),
                }),
              }),
            )
            .nullish(),
        }),
      }),
    )
    .min(1),
});

const ModelCard = z.object({
  id: z.string(),
  aliases: z.array(z.string()).nullish(),
  capabilities: z.object({ function_calling: z.boolean().nullish() }).nullish(),
});

/** Mistral documents the model list both bare and wrapped in `data`. */
const ModelsResponse = z.union([
  z.array(ModelCard),
  z.object({ data: z.array(ModelCard) }).transform((list) => list.data),
]);

/** Mistral's explanation: `message` on API errors, `detail` (text or validation entries) on others. */
const ErrorBody = z.object({
  message: z.string().optional(),
  detail: z.union([z.string(), z.array(z.object({ msg: z.string() }))]).optional(),
});

type MistralMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: Content;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

function textOf(content: Content): string {
  if (content === null) return "";
  if (typeof content === "string") return content;
  return content
    .flatMap((chunk) =>
      chunk.type === "text" && typeof chunk.text === "string" ? [chunk.text] : [],
    )
    .join("");
}

function detailOf(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const body = ErrorBody.safeParse(parsed);
  const detail = body.success
    ? (body.data.message ??
      (typeof body.data.detail === "string" ? body.data.detail : body.data.detail?.[0]?.msg))
    : undefined;
  return (detail ?? raw).trim().slice(0, 200);
}

/**
 * Mistral's chat completions API. Its replies are OpenAI-shaped, except that
 * reasoning models (Mistral Large 4, Medium 3.5) send content as thinking and
 * text chunks, which are replayed unchanged. The key is always sent, and only
 * to Mistral: redirects are refused.
 */
export function createMistralModel(options: MistralModelOptions): AiModel {
  const fetchImpl = options.fetch ?? fetch;
  const root = (options.baseUrl ?? MISTRAL_API_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = options.model;

  async function request(path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        ...init,
        redirect: "error",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AiProviderError(
        timeout.aborted ? "Mistral did not answer in time." : "Could not reach Mistral.",
      );
    }
    if (response.status === 401 || response.status === 403)
      throw new AiProviderError("Mistral rejected the API key.");
    if (response.status === 429)
      throw new AiProviderError("Mistral is rate limiting requests. Try again in a minute.");
    if (!response.ok) {
      const detail = detailOf(await response.text().catch(() => ""));
      throw new AiProviderError(
        `Mistral returned an error (${response.status})${detail ? `: ${detail}` : "."}`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new AiProviderError("Mistral sent a response that is not JSON.");
    }
  }

  return {
    start({ system, tools, history = [] }: AiStartOptions): AiConversation {
      const messages: MistralMessage[] = [
        { role: "system", content: system },
        ...history.map(
          (entry): MistralMessage =>
            entry.role === "user"
              ? { role: "user", content: entry.text }
              : { role: "assistant", content: entry.text },
        ),
      ];
      return {
        async send(
          input: AiInput,
          signal: AbortSignal,
          sendOptions: AiSendOptions = {},
        ): Promise<AiTurn> {
          if (input.kind === "user") messages.push({ role: "user", content: input.text });
          else {
            for (const result of input.results)
              messages.push({
                role: "tool",
                tool_call_id: result.id,
                content: result.isError ? `Error: ${result.content}` : result.content,
              });
            if (input.text !== undefined) messages.push({ role: "user", content: input.text });
          }
          const body = await request(
            "/chat/completions",
            {
              method: "POST",
              body: JSON.stringify({
                model,
                messages,
                ...(tools.length > 0 ? { tools: toolDefinitions(tools), tool_choice: "auto" } : {}),
              }),
            },
            signal,
          );
          const parsed = ChatResponse.safeParse(body);
          if (!parsed.success)
            throw new AiProviderError("Mistral sent a response fdrive does not understand.");
          // `.min(1)` guarantees a first choice.
          const choice = parsed.data.choices[0] as (typeof parsed.data.choices)[number];
          // Nothing of a failed generation is kept, so the next message starts clean.
          if (choice.finish_reason === "error")
            throw new AiProviderError("Mistral failed while answering. Try again.");
          const content = choice.message.content ?? null;
          const text = textOf(content);
          // The whole reply arrives at once; the caller still sees it through `onText`.
          if (text.length > 0) sendOptions.onText?.(text);
          const cutOff =
            choice.finish_reason === "length" || choice.finish_reason === "model_length";
          // A cut-off turn's calls are never answered, and Mistral rejects calls left without results.
          const calls = cutOff ? [] : (choice.message.tool_calls ?? []);
          messages.push({
            role: "assistant",
            content,
            ...(calls.length > 0
              ? {
                  tool_calls: calls.map((call) => ({
                    id: call.id,
                    type: "function" as const,
                    function: {
                      name: call.function.name,
                      arguments:
                        typeof call.function.arguments === "string"
                          ? call.function.arguments
                          : JSON.stringify(call.function.arguments),
                    },
                  })),
                }
              : {}),
          });
          if (cutOff) return { text, toolCalls: [], stop: "max_tokens" };
          const toolCalls = calls.map((call) => ({
            id: call.id,
            name: call.function.name,
            input:
              typeof call.function.arguments === "string"
                ? parseArguments(call.function.arguments)
                : call.function.arguments,
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
        if (!parsed.success) return { ok: true, message: "Connected to Mistral." };
        const card = parsed.data.find(
          (entry) => entry.id === model || (entry.aliases ?? []).includes(model),
        );
        if (card === undefined)
          return {
            ok: false,
            message: `Connected to Mistral, but this key cannot use the model ${model}.`,
          };
        if (card.capabilities?.function_calling === false)
          return {
            ok: false,
            message: `Connected to Mistral, but ${model} cannot call tools, which Organize and Chat need.`,
          };
        return { ok: true, message: `Connected to Mistral. ${model} is available.` };
      } catch (error) {
        if (error instanceof AiProviderError) return { ok: false, message: error.message };
        throw error;
      }
    },
  };
}
