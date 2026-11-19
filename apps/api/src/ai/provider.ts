import { createAnthropicModel } from "./anthropic.ts";
import { createMistralModel } from "./mistral.ts";
import type { AiModel } from "./model.ts";
import { createOpenAiCompatibleModel } from "./openai-compatible.ts";
import type { ResolvedAiConfig } from "./settings.ts";

/** Builds the adapter for a resolved configuration. `resolved()` guarantees the key or address each provider needs. */
export function createAiModel(
  config: ResolvedAiConfig,
  deps: { fetch?: typeof fetch } = {},
): AiModel {
  if (config.provider === "anthropic")
    return createAnthropicModel({ apiKey: config.apiKey ?? "", model: config.model });
  if (config.provider === "mistral")
    return createMistralModel({
      apiKey: config.apiKey ?? "",
      model: config.model,
      ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
    });
  return createOpenAiCompatibleModel({
    baseUrl: config.baseUrl ?? "",
    model: config.model,
    apiKey: config.apiKey,
    ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
  });
}
