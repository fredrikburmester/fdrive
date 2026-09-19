import {
  type AiProvider,
  type AiSettings,
  type AiSettingsUpdateRequest,
  DEFAULT_AI_MODEL,
  isHttpUrl,
} from "@fdrive/contracts";

/** The AI settings form as edited: text fields stay strings until they are saved. */
export interface AiDraft {
  readonly organize: boolean;
  readonly chat: boolean;
  readonly provider: AiProvider;
  readonly model: string;
  readonly baseUrl: string;
  /** A new key to save; empty keeps the saved one. */
  readonly apiKey: string;
  /** Remove the saved key on save. */
  readonly clearKey: boolean;
}

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: "Anthropic (Claude)",
  openai_compatible: "OpenAI-compatible server",
};

export function draftFrom(settings: AiSettings): AiDraft {
  return {
    organize: settings.organize,
    chat: settings.chat,
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl ?? "",
    apiKey: "",
    clearKey: false,
  };
}

/** Switching provider swaps a default model for the new provider's default and keeps a custom one. */
export function withProvider(draft: AiDraft, provider: AiProvider): AiDraft {
  if (provider === draft.provider) return draft;
  const model =
    draft.model === DEFAULT_AI_MODEL[draft.provider] ? DEFAULT_AI_MODEL[provider] : draft.model;
  return { ...draft, provider, model, baseUrl: provider === "anthropic" ? "" : draft.baseUrl };
}

function sameAddress(draft: AiDraft, saved: AiSettings): boolean {
  const baseUrl = draft.provider === "anthropic" ? null : draft.baseUrl.trim();
  return draft.provider === saved.provider && baseUrl === saved.baseUrl;
}

/** Whether saving would drop the saved key: the address changed and no new key was entered. */
export function keyWillBeDropped(draft: AiDraft, saved: AiSettings): boolean {
  return (
    saved.hasApiKey && !draft.clearKey && draft.apiKey.trim() === "" && !sameAddress(draft, saved)
  );
}

/** Whether a key will be available after saving. */
function keyAfterSave(draft: AiDraft, saved: AiSettings): boolean {
  if (draft.apiKey.trim() !== "") return true;
  return saved.hasApiKey && !draft.clearKey && sameAddress(draft, saved);
}

export type AiDraftResult =
  | { readonly ok: true; readonly request: AiSettingsUpdateRequest }
  | { readonly ok: false; readonly errors: readonly string[] };

export function requestFrom(draft: AiDraft, saved: AiSettings): AiDraftResult {
  const errors: string[] = [];
  const model = draft.model.trim();
  const baseUrl = draft.baseUrl.trim();
  if (model === "") errors.push("Enter a model.");
  if (draft.provider === "openai_compatible" && !isHttpUrl(baseUrl))
    errors.push("Enter the server's base URL, starting with http:// or https://.");
  if (
    (draft.organize || draft.chat) &&
    draft.provider === "anthropic" &&
    !keyAfterSave(draft, saved)
  )
    errors.push("Enter an Anthropic API key to turn Organize or Chat on.");
  if (errors.length > 0) return { ok: false, errors };
  const apiKey = draft.apiKey.trim();
  return {
    ok: true,
    request: {
      revision: saved.revision,
      organize: draft.organize,
      chat: draft.chat,
      provider: draft.provider,
      model,
      baseUrl: draft.provider === "anthropic" ? null : baseUrl,
      ...(apiKey !== "" ? { apiKey } : draft.clearKey ? { apiKey: null } : {}),
    },
  };
}

export function isDirty(draft: AiDraft, saved: AiSettings): boolean {
  const initial = draftFrom(saved);
  return (Object.keys(initial) as (keyof AiDraft)[]).some((key) => draft[key] !== initial[key]);
}

export type AiStatusTone = "on" | "off" | "incomplete";

/** How the page summarizes saved settings. */
export function aiStatus(settings: AiSettings): { tone: AiStatusTone; label: string } {
  if (!settings.organize && !settings.chat) return { tone: "off", label: "Off" };
  if (settings.provider === "anthropic" && !settings.hasApiKey)
    return { tone: "incomplete", label: "Needs an API key" };
  return { tone: "on", label: "On" };
}
