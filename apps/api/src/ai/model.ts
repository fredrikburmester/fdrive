/**
 * The provider-neutral surface fdrive's AI features are written against.
 * Each adapter (`anthropic.ts`, `openai-compatible.ts`) keeps its own native
 * conversation history, so provider-specific content such as Claude's
 * thinking blocks is replayed exactly as the provider returned it.
 */

/** A tool the model may call. `inputSchema` is a JSON Schema object. */
export interface AiToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface AiToolCall {
  readonly id: string;
  readonly name: string;
  /** The parsed arguments; `undefined` when the provider sent arguments that were not valid JSON. */
  readonly input: unknown;
}

export interface AiToolResult {
  readonly id: string;
  readonly content: string;
  readonly isError: boolean;
}

export type AiInput =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "tool_results"; readonly results: readonly AiToolResult[] };

export interface AiTurn {
  readonly text: string;
  readonly toolCalls: readonly AiToolCall[];
  /** `tool_use` when `toolCalls` is non-empty; `max_tokens` and `refusal` end a conversation. */
  readonly stop: "end_turn" | "tool_use" | "max_tokens" | "refusal";
}

export interface AiConversation {
  send(input: AiInput, signal: AbortSignal): Promise<AiTurn>;
}

export interface AiModel {
  start(options: { system: string; tools: readonly AiToolSpec[] }): AiConversation;
  /** Checks the key, address and model without generating text. */
  ping(signal: AbortSignal): Promise<{ ok: boolean; message: string }>;
}

/**
 * A provider failure whose message is safe to show the person who asked:
 * it names what went wrong (key rejected, rate limited, unreachable) and
 * never repeats the API key.
 */
export class AiProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiProviderError";
  }
}
