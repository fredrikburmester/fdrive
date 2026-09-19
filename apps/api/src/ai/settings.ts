import {
  AI_SETTINGS_KEY,
  AiProvider,
  type AiSettings,
  type AiSettingsUpdateRequest,
  DEFAULT_AI_MODEL,
} from "@fdrive/contracts";
import type { SettingsRepo } from "@fdrive/db";
import { z } from "zod";
import { ApiHttpError } from "../errors.js";
import { noopSystemEventLog, type SystemEventLog } from "../system/event-log.js";

/** Encrypts and decrypts small secrets under the master key, bound to a context string. */
export interface SecretBox {
  seal(plaintext: Uint8Array, context: string): Uint8Array;
  open(sealed: Uint8Array, context: string): Uint8Array;
}

/** What an adapter needs to talk to the configured provider; only built server-side. */
export interface ResolvedAiConfig {
  readonly provider: AiProvider;
  readonly model: string;
  readonly baseUrl: string | null;
  readonly apiKey: string | null;
  /** Whether the chat panel is offered; Organize is offered whenever AI resolves. */
  readonly chat: boolean;
}

export interface AiSettingsService {
  configuration(): Promise<AiSettings>;
  update(input: AiSettingsUpdateRequest): Promise<AiSettings>;
  /** The usable configuration, or `null` when AI is off or not fully set up. */
  resolved(): Promise<ResolvedAiConfig | null>;
  /** The saved configuration regardless of `enabled`, for the administrator's connection check. */
  saved(): Promise<ResolvedAiConfig | null>;
}

const StoredAiSettings = z.object({
  revision: z.number().int().nonnegative(),
  enabled: z.boolean(),
  /** Rows saved before the switch existed keep chat on. */
  chat: z.boolean().default(true),
  provider: AiProvider,
  model: z.string().min(1),
  baseUrl: z.string().nullable(),
  /** Base64 of the sealed key. */
  apiKey: z.string().nullable(),
});

type StoredAiSettings = z.infer<typeof StoredAiSettings>;

const DEFAULTS: StoredAiSettings = {
  revision: 0,
  enabled: false,
  chat: true,
  provider: "anthropic",
  model: DEFAULT_AI_MODEL.anthropic,
  baseUrl: null,
  apiKey: null,
};

/**
 * Binds a sealed key to the address it was entered for: opening it under a
 * different provider or base URL fails authentication, so editing the
 * address can never forward a saved key somewhere new.
 */
function keyContext(provider: AiProvider, baseUrl: string | null): string {
  return `ai-api-key:${provider}:${baseUrl ?? ""}`;
}

function publicView(stored: StoredAiSettings, hasApiKey: boolean): AiSettings {
  return {
    revision: stored.revision,
    enabled: stored.enabled,
    chat: stored.chat,
    provider: stored.provider,
    model: stored.model,
    baseUrl: stored.baseUrl,
    hasApiKey,
  };
}

/** The administrator's AI provider configuration, stored as one revisioned `app.settings` value. */
export function createAiSettingsService(deps: {
  settings: Pick<SettingsRepo, "get" | "compareAndSet">;
  secrets: SecretBox;
  eventLog?: SystemEventLog;
}): AiSettingsService {
  const eventLog = deps.eventLog ?? noopSystemEventLog;

  async function read(): Promise<{ raw: unknown | null; value: StoredAiSettings }> {
    const raw = await deps.settings.get<unknown>(AI_SETTINGS_KEY);
    if (raw === null) return { raw, value: DEFAULTS };
    const parsed = StoredAiSettings.safeParse(raw);
    if (!parsed.success) throw new ApiHttpError("internal", "Stored AI configuration is invalid.");
    return { raw, value: parsed.data };
  }

  function openKey(stored: StoredAiSettings): string | null {
    if (stored.apiKey === null) return null;
    try {
      return Buffer.from(
        deps.secrets.open(
          Buffer.from(stored.apiKey, "base64"),
          keyContext(stored.provider, stored.baseUrl),
        ),
      ).toString("utf8");
    } catch {
      // A rotated master key or a tampered row: behave as if no key were saved.
      return null;
    }
  }

  function resolve(stored: StoredAiSettings): ResolvedAiConfig {
    return {
      provider: stored.provider,
      model: stored.model,
      baseUrl: stored.baseUrl,
      apiKey: openKey(stored),
      chat: stored.chat,
    };
  }

  function usable(config: ResolvedAiConfig): boolean {
    return config.provider === "anthropic" ? config.apiKey !== null : config.baseUrl !== null;
  }

  return {
    async configuration() {
      const stored = (await read()).value;
      // Reports a key only when it still opens, so a rotated master key asks for the key again.
      return publicView(stored, openKey(stored) !== null);
    },

    async update(input) {
      const current = await read();
      if (input.revision !== current.value.revision)
        throw new ApiHttpError(
          "conflict",
          "AI settings changed in another session. Reload and try again.",
        );
      const sameAddress =
        input.provider === current.value.provider && input.baseUrl === current.value.baseUrl;
      // A saved key that no longer opens (rotated master key) is dropped rather than kept unusable.
      const apiKey =
        input.apiKey === undefined
          ? sameAddress && openKey(current.value) !== null
            ? current.value.apiKey
            : null
          : input.apiKey === null
            ? null
            : Buffer.from(
                deps.secrets.seal(
                  Buffer.from(input.apiKey, "utf8"),
                  keyContext(input.provider, input.baseUrl),
                ),
              ).toString("base64");
      if (input.enabled && input.provider === "anthropic" && apiKey === null)
        throw new ApiHttpError("bad_request", "Enter an Anthropic API key before turning AI on.");
      const next: StoredAiSettings = {
        revision: input.revision + 1,
        enabled: input.enabled,
        chat: input.chat,
        provider: input.provider,
        model: input.model,
        baseUrl: input.baseUrl,
        apiKey,
      };
      if (!(await deps.settings.compareAndSet(AI_SETTINGS_KEY, current.raw, next)))
        throw new ApiHttpError(
          "conflict",
          "AI settings changed in another session. Reload and try again.",
        );
      eventLog.record("general", "info", "AI settings updated", {
        enabled: next.enabled,
        chat: next.chat,
        provider: next.provider,
        model: next.model,
        apiKeyChanged: input.apiKey !== undefined || !sameAddress,
      });
      return publicView(next, next.apiKey !== null);
    },

    async resolved() {
      const stored = (await read()).value;
      if (!stored.enabled) return null;
      const config = resolve(stored);
      return usable(config) ? config : null;
    },

    async saved() {
      const config = resolve((await read()).value);
      return usable(config) ? config : null;
    },
  };
}
