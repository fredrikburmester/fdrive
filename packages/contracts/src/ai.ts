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
  /** Whether Organize is offered to everyone signed in. */
  organize: z.boolean(),
  /** Whether the chat panel is offered to everyone signed in. */
  chat: z.boolean(),
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
    organize: z.boolean(),
    chat: z.boolean(),
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

/** Returned by `GET /ai/status` to every signed-in user: which AI features can be offered. */
export const AiStatusResponse = z.object({
  provider: AiProvider.nullable(),
  organize: z.boolean(),
  chat: z.boolean(),
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

// ------------------------------------------------------------------ chat

/** Chats one login keeps; creating another deletes the oldest by last message. */
export const MAX_CHATS = 50;
/** Messages one chat may hold, person and assistant together, before it is closed. */
export const MAX_CHAT_MESSAGES = 200;
/** Files and folders one chat may reference. */
export const MAX_CHAT_REFERENCES = 200;
/** Days a chat stays after its last message. */
export const CHAT_RETENTION_DAYS = 90;

const chatPath = z.string().min(1).max(4096);

/**
 * `running` while the assistant answers, `awaiting_approval` while an
 * action card waits for the person, `closed` once the chat reached its
 * message limit; otherwise `idle`.
 */
export const ChatState = z.enum(["idle", "running", "awaiting_approval", "closed"]);

export type ChatState = z.infer<typeof ChatState>;

/** One proposed move card: Organize's proposal, verified against storage the same way. */
export const ChatMoveProposal = z.object({
  kind: z.literal("move"),
  summary: z.string(),
  suggestions: z.array(OrganizeSuggestion),
  unchanged: z.array(z.object({ path: z.string(), reason: z.string() })),
});

export const ChatTrashProposal = z.object({
  kind: z.literal("trash"),
  summary: z.string(),
  items: z.array(z.object({ path: z.string(), kind: z.enum(["file", "dir"]), reason: z.string() })),
});

/** A text file to create next to a referenced item, or a referenced text file to replace. */
export const ChatWriteProposal = z.object({
  kind: z.literal("write"),
  summary: z.string(),
  path: z.string(),
  mode: z.enum(["create", "replace"]),
  text: z.string(),
  /** The SHA-256 the draft was based on; `replace` refuses when the file changed since. */
  expectedSha256: z.string().nullable(),
});

export const ChatActionProposal = z.discriminatedUnion("kind", [
  ChatMoveProposal,
  ChatTrashProposal,
  ChatWriteProposal,
]);

export type ChatActionProposal = z.infer<typeof ChatActionProposal>;

export const ChatActionState = z.enum(["pending", "applied", "declined", "failed"]);

export type ChatActionState = z.infer<typeof ChatActionState>;

/** What happened to one item when a card was applied. */
export const ChatActionResult = z.object({
  path: z.string(),
  ok: z.boolean(),
  /** Where the item ended up, for moves and writes. */
  target: z.string().optional(),
  message: z.string().optional(),
});

export type ChatActionResult = z.infer<typeof ChatActionResult>;

export const ChatPart = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({
    kind: z.literal("tool"),
    id: z.string(),
    name: z.string(),
    /** One short line for the person, e.g. "Read invoice.pdf". */
    activity: z.string(),
    /** The arguments and result, each shortened for display. */
    input: z.string(),
    output: z.string(),
    state: z.enum(["running", "done", "failed"]),
  }),
  z.object({
    kind: z.literal("action"),
    id: z.string(),
    state: ChatActionState,
    proposal: ChatActionProposal,
    /** One line about the outcome once the card is no longer pending. */
    outcome: z.string().optional(),
    results: z.array(ChatActionResult).optional(),
  }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);

export type ChatPart = z.infer<typeof ChatPart>;

export const ChatMessage = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  parts: z.array(ChatPart),
  /** Paths attached to this message when it was sent. */
  references: z.array(z.string()),
  /** The folder open in the browser when it was sent. */
  location: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatReference = z.object({
  path: z.string(),
  /** The item was moved out of reach or trashed after it was referenced. */
  missing: z.boolean(),
});

export type ChatReference = z.infer<typeof ChatReference>;

export const ChatSummary = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastMessageAt: z.iso.datetime(),
});

export type ChatSummary = z.infer<typeof ChatSummary>;

export const Chat = ChatSummary.extend({
  state: ChatState,
  share: OrganizeSharing,
  references: z.array(ChatReference),
  messages: z.array(ChatMessage),
});

export type Chat = z.infer<typeof Chat>;

export const ChatListResponse = z.object({ chats: z.array(ChatSummary) });

export type ChatListResponse = z.infer<typeof ChatListResponse>;

export const ChatCreateRequest = z.strictObject({
  /** Omitted means `DEFAULT_ORGANIZE_SHARING`. */
  share: OrganizeSharing.optional(),
});

export type ChatCreateRequest = z.infer<typeof ChatCreateRequest>;

export const ChatRenameRequest = z.strictObject({
  title: z.string().trim().min(1).max(120),
});

export type ChatRenameRequest = z.infer<typeof ChatRenameRequest>;

export const ChatMessageRequest = z.strictObject({
  text: z.string().trim().min(1).max(8000),
  /** Files and folders attached to this message; they stay referenced for the rest of the chat. */
  references: z.array(chatPath).max(MAX_CHAT_REFERENCES).optional(),
  /** The folder open in the browser, so "this folder" means something. */
  location: chatPath.nullable().optional(),
});

export type ChatMessageRequest = z.infer<typeof ChatMessageRequest>;

/** What the person changed on a card before applying it; an omitted field keeps the proposal. */
export const ChatActionEdits = z.strictObject({
  /** Moves to make, by item path and full target path; only proposal items count. */
  moves: z
    .array(z.object({ path: z.string(), target: z.string() }))
    .max(500)
    .optional(),
  /** Items to trash; only proposal items count. */
  paths: z.array(z.string()).max(500).optional(),
  /** Another name or place for a written file. */
  path: chatPath.optional(),
  mode: z.enum(["create", "replace"]).optional(),
});

export type ChatActionEdits = z.infer<typeof ChatActionEdits>;

export const ChatActionRequest = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("decline") }),
  z.strictObject({ decision: z.literal("apply"), edits: ChatActionEdits.optional() }),
]);

export type ChatActionRequest = z.infer<typeof ChatActionRequest>;
