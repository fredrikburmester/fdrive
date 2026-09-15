import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  type AiConversation,
  type AiInput,
  type AiModel,
  AiProviderError,
  type AiToolSpec,
  type AiTurn,
} from "./model.ts";

/** The part of the SDK client this adapter uses, so tests can supply a fake. */
export type AnthropicClient = Pick<Anthropic, "beta" | "models">;

export interface AnthropicModelOptions {
  readonly apiKey: string;
  readonly model: string;
  /** Overridable for tests; defaults to the official SDK client. */
  readonly client?: AnthropicClient;
}

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-opus-5", "claude-fable-5-1"]);

/** Output room per turn: enough for adaptive thinking plus a large final tool call. */
const MAX_TOKENS = 32_000;

/** Haiku 4.5 predates adaptive thinking and rejects it. */
function supportsAdaptiveThinking(model: string): boolean {
  return !model.startsWith("claude-haiku-4-5");
}

function toProviderError(error: unknown): unknown {
  if (error instanceof Anthropic.APIUserAbortError) return error;
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  )
    return new AiProviderError("Anthropic rejected the API key.");
  if (error instanceof Anthropic.NotFoundError)
    return new AiProviderError("Anthropic does not recognize this model.");
  if (error instanceof Anthropic.RateLimitError)
    return new AiProviderError("Anthropic is rate limiting requests. Try again in a minute.");
  if (error instanceof Anthropic.APIConnectionError)
    return new AiProviderError("Could not reach Anthropic.");
  if (error instanceof Anthropic.APIError)
    return new AiProviderError(`Anthropic returned an error (${error.status ?? "unknown"}).`);
  return error;
}

function turnFrom(message: BetaMessage): AiTurn {
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  const toolCalls = message.content.flatMap((block) =>
    block.type === "tool_use" ? [{ id: block.id, name: block.name, input: block.input }] : [],
  );
  if (message.stop_reason === "refusal") return { text, toolCalls: [], stop: "refusal" };
  if (message.stop_reason === "max_tokens") return { text, toolCalls: [], stop: "max_tokens" };
  return { text, toolCalls, stop: toolCalls.length > 0 ? "tool_use" : "end_turn" };
}

/**
 * Claude through the official SDK. Streams every turn (long thinking never
 * hits an HTTP timeout), caches the growing prefix automatically, and replays
 * each assistant turn unchanged so thinking blocks stay valid across tool
 * calls.
 */
export function createAnthropicModel(options: AnthropicModelOptions): AiModel {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });
  const model = options.model;

  return {
    start({ system, tools }: { system: string; tools: readonly AiToolSpec[] }): AiConversation {
      const messages: BetaMessageParam[] = [];
      return {
        async send(input: AiInput, signal: AbortSignal): Promise<AiTurn> {
          messages.push(
            input.kind === "user"
              ? { role: "user", content: input.text }
              : {
                  role: "user",
                  content: input.results.map(
                    (result): BetaToolResultBlockParam => ({
                      type: "tool_result",
                      tool_use_id: result.id,
                      content: result.content,
                      is_error: result.isError,
                    }),
                  ),
                },
          );
          const params: BetaMessageStreamParams = {
            model,
            max_tokens: MAX_TOKENS,
            system,
            messages,
            cache_control: { type: "ephemeral" },
            ...(tools.length > 0
              ? {
                  tools: tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    input_schema: { type: "object" as const, ...tool.inputSchema },
                  })),
                }
              : {}),
            ...(supportsAdaptiveThinking(model) ? { thinking: { type: "adaptive" as const } } : {}),
            ...(FALLBACK_MODELS.has(model)
              ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
              : {}),
          };
          let message: BetaMessage;
          try {
            message = await client.beta.messages.stream(params, { signal }).finalMessage();
          } catch (error) {
            throw toProviderError(error);
          }
          messages.push({ role: "assistant", content: message.content });
          return turnFrom(message);
        },
      };
    },

    async ping(signal: AbortSignal) {
      try {
        const info = await client.models.retrieve(model, {}, { signal });
        return { ok: true, message: `Connected to Anthropic. ${info.display_name} is available.` };
      } catch (error) {
        const mapped = toProviderError(error);
        if (mapped instanceof AiProviderError) return { ok: false, message: mapped.message };
        throw mapped;
      }
    },
  };
}
