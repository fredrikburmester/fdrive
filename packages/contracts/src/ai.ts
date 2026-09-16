import { z } from "zod";
import { HttpUrl } from "./http-url.ts";

/** The `app.settings` key the administrator's AI configuration is stored under. */
export const AI_SETTINGS_KEY = "ai.configuration";

/**
 * Where fdrive sends AI requests. `anthropic` is Claude through Anthropic's
 * API; `openai_compatible` is any server speaking the OpenAI chat
 * completions protocol with tool calls (Ollama, LM Studio, vLLM, OpenRouter).
 */
export const AiProvider = z.enum(["anthropic", "openai_compatible"]);

export type AiProvider = z.infer<typeof AiProvider>;

/** The model a provider starts with; OpenAI-compatible servers name their own. */
export const DEFAULT_AI_MODEL: Record<AiProvider, string> = {
  anthropic: "claude-opus-5",
  openai_compatible: "",
};

const aiModel = z.string().trim().min(1).max(200);

/** The administrator's AI configuration as the browser sees it: the API key itself never leaves the server. */
export const AiSettings = z.object({
  revision: z.number().int().nonnegative(),
  enabled: z.boolean(),
  provider: AiProvider,
  model: aiModel,
  /** Required for `openai_compatible`, e.g. `http://ollama:11434/v1`; always `null` for `anthropic`. */
  baseUrl: HttpUrl.nullable(),
  hasApiKey: z.boolean(),
});

export type AiSettings = z.infer<typeof AiSettings>;

export const AiSettingsUpdateRequest = z
  .strictObject({
    revision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    provider: AiProvider,
    model: aiModel,
    baseUrl: HttpUrl.nullable(),
    /**
     * Omit to keep the saved key, `null` to remove it, or a new key. Changing
     * the provider or base URL removes a saved key unless a new one is sent,
     * so a key is never forwarded to an address it was not entered for.
     */
    apiKey: z.string().trim().min(1).max(4096).nullable().optional(),
  })
  .refine((value) => value.provider !== "openai_compatible" || value.baseUrl !== null, {
    message: "an OpenAI-compatible provider needs a base URL",
    path: ["baseUrl"],
  })
  .refine((value) => value.provider !== "anthropic" || value.baseUrl === null, {
    message: "Anthropic does not use a base URL",
    path: ["baseUrl"],
  });

export type AiSettingsUpdateRequest = z.infer<typeof AiSettingsUpdateRequest>;

/** Returned by `GET`/`PUT /system/ai`. */
export const SystemAiResponse = z.object({
  configuration: AiSettings,
});

export type SystemAiResponse = z.infer<typeof SystemAiResponse>;

/** Returned by `POST /system/ai/test`: one short request against the saved configuration. */
export const AiConnectionTestResponse = z.object({
  ok: z.boolean(),
  message: z.string(),
});

export type AiConnectionTestResponse = z.infer<typeof AiConnectionTestResponse>;

/** Returned by `GET /ai/status` to every signed-in user: whether AI actions can be offered. */
export const AiStatusResponse = z.object({
  available: z.boolean(),
  provider: AiProvider.nullable(),
});

export type AiStatusResponse = z.infer<typeof AiStatusResponse>;

/** The most items one organize request may ask about. */
export const MAX_ORGANIZE_ITEMS = 500;

/**
 * What one organize run may send to the model beyond the selected items'
 * own paths, sizes and dates and the folder names the assistant browses,
 * which every run needs. Chosen by the person for each run.
 */
export const OrganizeSharing = z.strictObject({
  /** Short excerpts of the selected files' already-extracted text, read when the assistant asks. */
  contents: z.boolean(),
  /** Names of files outside the selection seen while browsing folders or searching. Folder names are always shared. */
  otherFileNames: z.boolean(),
});

export type OrganizeSharing = z.infer<typeof OrganizeSharing>;

/** What a run shares when the request does not say: everything the assistant can use. */
export const DEFAULT_ORGANIZE_SHARING: OrganizeSharing = { contents: true, otherFileNames: true };

export const OrganizeRequest = z.strictObject({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(MAX_ORGANIZE_ITEMS),
  /** Optional guidance from the user, e.g. "photos by year". */
  instructions: z.string().trim().max(2000).optional(),
  /** Omitted means `DEFAULT_ORGANIZE_SHARING`. */
  share: OrganizeSharing.optional(),
});

export type OrganizeRequest = z.infer<typeof OrganizeRequest>;

export const OrganizeRunState = z.enum(["running", "done", "failed", "cancelled"]);

export type OrganizeRunState = z.infer<typeof OrganizeRunState>;

/** One proposed move, already checked against storage by the server. */
export const OrganizeSuggestion = z.object({
  path: z.string(),
  kind: z.enum(["file", "dir"]),
  /** The folder the item would move into. */
  destination: z.string(),
  /** `destination` joined with the item's name: the path it would have afterwards. */
  target: z.string(),
  reason: z.string(),
  /** The destination folder does not exist yet and is created on apply. */
  newFolder: z.boolean(),
  /** Something already exists at `target`, or another suggestion claims it; applying would fail. */
  conflict: z.boolean(),
});

export type OrganizeSuggestion = z.infer<typeof OrganizeSuggestion>;

export const OrganizeProposal = z.object({
  summary: z.string(),
  suggestions: z.array(OrganizeSuggestion),
  /** Selected items the assistant left where they are, with why. */
  unchanged: z.array(z.object({ path: z.string(), reason: z.string() })),
});

export type OrganizeProposal = z.infer<typeof OrganizeProposal>;

/** One organize request's progress and, once done, its proposal. Nothing moves until the user applies it. */
export const OrganizeRun = z.object({
  id: z.string(),
  state: OrganizeRunState,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  itemCount: z.number().int().nonnegative(),
  /** Short, human-readable steps the assistant has taken so far, oldest first. */
  activity: z.array(z.string()),
  proposal: OrganizeProposal.optional(),
  error: z.string().optional(),
});

export type OrganizeRun = z.infer<typeof OrganizeRun>;
