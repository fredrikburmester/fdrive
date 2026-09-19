import { randomUUID } from "node:crypto";
import {
  CHAT_RETENTION_DAYS,
  type Chat,
  type ChatActionRequest,
  type ChatCreateRequest,
  type ChatListResponse,
  type ChatMessage,
  type ChatMessageRequest,
  ChatPart,
  type ChatRenameRequest,
  type ChatState,
  DEFAULT_ORGANIZE_SHARING,
  MAX_CHAT_MESSAGES,
  MAX_CHAT_REFERENCES,
  MAX_CHATS,
} from "@fdrive/contracts";
import { isStorageError, isUnderPath, normalizePath } from "@fdrive/core";
import type { AiChat, AiChatMessage, AiChatRepo } from "@fdrive/db";
import type { Principal } from "../../auth/principal.js";
import { ApiHttpError } from "../../errors.js";
import type { FsRoutesDeps } from "../../fs/routes.js";
import type { McpToolDeps } from "../../mcp/handlers.js";
import type { AiInput, AiModel, AiToolResult } from "../model.ts";
import type { AiSettingsService, ResolvedAiConfig } from "../settings.ts";
import { createDriveTools, type ToolFocus } from "../tools/drive-tools.ts";
import { type AiTool, formatSize } from "../tools/tool.ts";
import { createChatActionTools } from "./action-tools.ts";
import type { ActionTool } from "./actions.ts";
import { CHAT_SYSTEM_PROMPT, ChatTurnError, MAX_CHAT_TURNS, runChatTurn } from "./agent.ts";
import { buildHistory, formatUserMessage, type ReferenceLine } from "./history.ts";
import { createLiveChats, type LiveChat, type LiveChats } from "./live.ts";
import { createChatReadTools } from "./tools.ts";

export interface ChatService {
  list(principal: Principal): Promise<ChatListResponse>;
  create(principal: Principal, request: ChatCreateRequest): Promise<Chat>;
  get(principal: Principal, id: string): Promise<Chat>;
  rename(principal: Principal, id: string, request: ChatRenameRequest): Promise<Chat>;
  delete(principal: Principal, id: string): Promise<void>;
  /** Stores the message and starts the reply; the returned chat is `running`. */
  send(principal: Principal, id: string, request: ChatMessageRequest): Promise<Chat>;
  cancel(principal: Principal, id: string): Promise<Chat>;
  /** Applies or declines one pending card; with a live conversation the assistant then continues. */
  act(
    principal: Principal,
    id: string,
    actionId: string,
    request: ChatActionRequest,
  ): Promise<Chat>;
  /** Resolves once the reply being written for `id` has ended. For tests and graceful shutdown. */
  settled(id: string): Promise<void>;
}

export interface ChatLimits {
  readonly maxChats: number;
  readonly maxMessages: number;
  readonly maxReferences: number;
  readonly retentionDays: number;
  /** How long one reply may take before it is stopped. */
  readonly turnDeadlineMs: number;
  readonly maxTurns: number;
}

export const DEFAULT_CHAT_LIMITS: ChatLimits = {
  maxChats: MAX_CHATS,
  maxMessages: MAX_CHAT_MESSAGES,
  maxReferences: MAX_CHAT_REFERENCES,
  retentionDays: CHAT_RETENTION_DAYS,
  turnDeadlineMs: 10 * 60 * 1000,
  maxTurns: MAX_CHAT_TURNS,
};

export interface ChatServiceDeps {
  readonly settings: Pick<AiSettingsService, "resolved">;
  readonly modelFor: (config: ResolvedAiConfig) => AiModel;
  readonly chats: AiChatRepo;
  /** The MCP read handlers the tools reuse. */
  readonly mcp: McpToolDeps;
  /** What applying a move or trash card needs: events and metadata hooks. */
  readonly fs: Pick<FsRoutesDeps, "bus" | "clock" | "metadata">;
  readonly clock: () => Date;
  readonly ids?: () => string;
  readonly live?: LiveChats;
  readonly limits?: Partial<ChatLimits>;
  /** Called with failures that are not written for the person, whose messages stay out of the transcript. */
  readonly onUnexpectedError?: (error: unknown) => void;
}

const TITLE_CHARS = 60;
const NEW_CHAT_TITLE = "New chat";
const UNEXPECTED = "Something went wrong while answering. Try again.";

function notFound(): ApiHttpError {
  return new ApiHttpError("not_found", "That chat does not exist.");
}

export function titleFrom(text: string): string {
  const line =
    text
      .split("\n")
      .find((candidate) => candidate.trim().length > 0)
      ?.trim() ?? "";
  if (line.length === 0) return NEW_CHAT_TITLE;
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…` : line;
}

function toChatMessage(message: AiChatMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    parts: message.parts.flatMap((part) => {
      const parsed = ChatPart.safeParse(part);
      return parsed.success ? [parsed.data] : [];
    }),
    references: [...message.references],
    location: message.location,
    createdAt: message.createdAt.toISOString(),
  };
}

function pendingIn(messages: readonly ChatMessage[]): boolean {
  const last = messages.at(-1);
  return (
    last?.role === "assistant" &&
    last.parts.some((part) => part.kind === "action" && part.state === "pending")
  );
}

/**
 * Chats for a signed-in person: stored transcripts, a live provider
 * conversation per active chat, and approval-gated writes. Everything is
 * looked up by the caller's identity, so another login's chat is simply
 * not found.
 */
export function createChatService(deps: ChatServiceDeps): ChatService {
  const limits: ChatLimits = { ...DEFAULT_CHAT_LIMITS, ...deps.limits };
  const ids = deps.ids ?? randomUUID;
  const live = deps.live ?? createLiveChats({ clock: deps.clock });
  const turns = new Map<string, Promise<void>>();

  async function indexedFor(principal: Principal): Promise<boolean> {
    const identity = await deps.mcp.identities.get(principal.identityId);
    if (identity === null) return false;
    return (await deps.mcp.scopeResolver.verifiedIndexScopes(identity)).available;
  }

  function trashPathOf(principal: Principal): string | null {
    return deps.mcp.trashPathForStorage?.(principal.storage) ?? deps.mcp.trashPath ?? null;
  }

  async function checkAuthority(principal: Principal): Promise<void> {
    if (principal.verifyAuthority !== undefined && !(await principal.verifyAuthority()))
      throw new ChatTurnError("Your session ended. Sign in and try again.");
  }

  async function load(principal: Principal, id: string): Promise<AiChat> {
    const chat = await deps.chats.get(principal.identityId, id);
    if (chat === null) throw notFound();
    return chat;
  }

  async function present(chat: AiChat): Promise<Chat> {
    const [stored, references] = await Promise.all([
      deps.chats.messages(chat.id),
      deps.chats.references(chat.id),
    ]);
    const messages = stored.map(toChatMessage);
    const running = live.get(chat.id)?.turn !== null && live.get(chat.id) !== undefined;
    const state: ChatState = running
      ? "running"
      : pendingIn(messages)
        ? "awaiting_approval"
        : messages.length >= limits.maxMessages
          ? "closed"
          : "idle";
    return {
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt.toISOString(),
      updatedAt: chat.updatedAt.toISOString(),
      lastMessageAt: chat.lastMessageAt.toISOString(),
      state,
      share: chat.share,
      references: references.map((reference) => ({
        path: reference.path,
        missing: reference.missing,
      })),
      messages,
    };
  }

  async function buildTools(principal: Principal, chat: AiChat) {
    const references = await deps.chats.references(chat.id);
    const focus: ToolFocus = {
      paths: new Set(references.filter((reference) => !reference.missing).map((r) => r.path)),
      adjective: "referenced",
      group: "the references",
      openFolders: true,
    };
    const toolDeps = {
      mcp: deps.mcp,
      principal,
      focus,
      indexed: await indexedFor(principal),
      share: chat.share,
    };
    const tools: AiTool[] = [
      ...createDriveTools(toolDeps).filter((tool) => tool.spec.name !== "read_excerpts"),
      ...createChatReadTools(toolDeps),
    ];
    const actions: ActionTool[] = createChatActionTools({ ...toolDeps, fs: deps.fs });
    return {
      tools: new Map(tools.map((tool) => [tool.spec.name, tool])),
      actions: new Map(actions.map((tool) => [tool.spec.name, tool])),
    };
  }

  /** The chat's live conversation, rebuilt from `history` when the process has none. */
  async function ensureLive(
    principal: Principal,
    chat: AiChat,
    config: ResolvedAiConfig,
    history: readonly AiChatMessage[],
  ): Promise<LiveChat> {
    const built = await buildTools(principal, chat);
    const existing = live.get(chat.id);
    if (existing !== undefined) {
      existing.tools = built.tools;
      existing.actions = built.actions;
      return existing;
    }
    const conversation = deps.modelFor(config).start({
      system: CHAT_SYSTEM_PROMPT,
      tools: [...built.tools.values(), ...built.actions.values()].map((tool) => tool.spec),
      history: buildHistory(history.map(toChatMessage)),
    });
    const created: LiveChat = {
      chatId: chat.id,
      identityId: chat.identityId,
      conversation,
      tools: built.tools,
      actions: built.actions,
      pending: new Map(),
      held: [],
      parts: [],
      messageId: null,
      turn: null,
      touchedAt: 0,
    };
    live.set(created);
    return created;
  }

  function startTurn(principal: Principal, target: LiveChat, messageId: string, input: AiInput) {
    const controller = new AbortController();
    const turn = { controller, messageId } as LiveChat["turn"] & object;
    target.turn = turn;
    target.messageId = messageId;
    const timer = setTimeout(() => {
      turn.abortReason = "timeout";
      controller.abort();
    }, limits.turnDeadlineMs);
    const promise = (async () => {
      try {
        const end = await runChatTurn(
          {
            conversation: target.conversation,
            tools: target.tools,
            actions: target.actions,
            signal: controller.signal,
            checkAuthority: () => checkAuthority(principal),
            onParts: (parts) => deps.chats.updateMessageParts(messageId, parts),
            ids,
            maxTurns: limits.maxTurns,
          },
          input,
          target.parts,
        );
        if (end.kind === "awaiting") {
          for (const card of end.pending) target.pending.set(card.actionId, card);
          target.held = [...end.held];
        }
      } catch (error) {
        const message = controller.signal.aborted
          ? turn.abortReason === "cancelled"
            ? "Stopped."
            : turn.abortReason === "replaced"
              ? "A newer message replaced this reply."
              : "The reply took too long and was stopped."
          : error instanceof ChatTurnError
            ? error.message
            : UNEXPECTED;
        if (message === UNEXPECTED) deps.onUnexpectedError?.(error);
        target.parts.push({ kind: "error", message });
        await deps.chats.updateMessageParts(messageId, target.parts).catch(() => {});
        // The provider history may end mid tool call; the next message rebuilds it from the transcript.
        live.delete(target.chatId);
      } finally {
        clearTimeout(timer);
        target.turn = null;
      }
    })();
    turns.set(target.chatId, promise);
  }

  async function stopTurn(target: LiveChat, reason: "cancelled" | "replaced"): Promise<void> {
    if (target.turn === null) return;
    target.turn.abortReason = reason;
    target.turn.controller.abort();
    await turns.get(target.chatId);
  }

  /** Marks every pending card on the chat's last reply declined; returns the tool results a live conversation still owes. */
  async function declinePending(
    target: LiveChat | undefined,
    stored: readonly AiChatMessage[],
    reason: string,
  ): Promise<AiToolResult[]> {
    const last = stored.at(-1);
    if (last === undefined || last.role !== "assistant") return [];
    const parts = last.parts.flatMap((part) => {
      const parsed = ChatPart.safeParse(part);
      return parsed.success ? [parsed.data] : [];
    });
    if (!parts.some((part) => part.kind === "action" && part.state === "pending")) return [];
    const updated = parts.map((part) =>
      part.kind === "action" && part.state === "pending"
        ? { ...part, state: "declined" as const, outcome: reason }
        : part,
    );
    await deps.chats.updateMessageParts(last.id, updated);
    if (target === undefined) return [];
    const results: AiToolResult[] = [...target.held];
    for (const card of target.pending.values())
      results.push({ id: card.callId, isError: false, content: "The person did not apply this." });
    target.pending.clear();
    target.held = [];
    target.parts = updated;
    return results;
  }

  async function describeReferences(
    principal: Principal,
    paths: readonly string[],
  ): Promise<ReferenceLine[]> {
    const lines: ReferenceLine[] = [];
    for (const path of paths) {
      try {
        const stat = await principal.storage.stat(path);
        lines.push({
          path,
          detail:
            stat.kind === "dir"
              ? "folder"
              : `file, ${formatSize(stat.size)}${stat.modifiedAt ? `, modified ${stat.modifiedAt.toISOString().slice(0, 10)}` : ""}`,
        });
      } catch (error) {
        if (!isStorageError(error) || error.kind !== "not_found") throw error;
        throw new ApiHttpError("bad_request", `${path} does not exist.`);
      }
    }
    return lines;
  }

  return {
    async list(principal) {
      const chats = await deps.chats.list(principal.identityId, limits.maxChats);
      return {
        chats: chats.map((chat) => ({
          id: chat.id,
          title: chat.title,
          createdAt: chat.createdAt.toISOString(),
          updatedAt: chat.updatedAt.toISOString(),
          lastMessageAt: chat.lastMessageAt.toISOString(),
        })),
      };
    },

    async create(principal, request) {
      if ((await deps.settings.resolved()) === null)
        throw new ApiHttpError(
          "unsupported",
          "AI is not set up. An administrator can turn it on under System > AI.",
        );
      await deps.chats.prune(principal.identityId, {
        keep: limits.maxChats - 1,
        idleBefore: new Date(deps.clock().getTime() - limits.retentionDays * 24 * 60 * 60 * 1000),
      });
      const chat = await deps.chats.create({
        identityId: principal.identityId,
        title: NEW_CHAT_TITLE,
        share: request.share ?? DEFAULT_ORGANIZE_SHARING,
      });
      return present(chat);
    },

    async get(principal, id) {
      live.sweep();
      return present(await load(principal, id));
    },

    async rename(principal, id, request) {
      const chat = await deps.chats.rename(principal.identityId, id, request.title);
      if (chat === null) throw notFound();
      return present(chat);
    },

    async delete(principal, id) {
      const target = live.get(id);
      if (target !== undefined && target.identityId === principal.identityId) {
        await stopTurn(target, "cancelled");
        live.delete(id);
      }
      if (!(await deps.chats.delete(principal.identityId, id))) throw notFound();
    },

    async send(principal, id, request) {
      const config = await deps.settings.resolved();
      if (config === null)
        throw new ApiHttpError(
          "unsupported",
          "AI is not set up. An administrator can turn it on under System > AI.",
        );
      live.sweep();
      const chat = await load(principal, id);
      const before = await deps.chats.messages(chat.id);
      if (before.length >= limits.maxMessages)
        throw new ApiHttpError("conflict", "This chat is full. Start a new chat.");

      const trashPath = trashPathOf(principal);
      const existing = await deps.chats.references(chat.id);
      const known = new Set(existing.map((reference) => reference.path));
      const added: string[] = [];
      for (const raw of request.references ?? []) {
        let path: string;
        try {
          path = normalizePath(raw);
        } catch {
          throw new ApiHttpError("bad_request", `"${raw}" is not a valid path.`);
        }
        if (trashPath !== null && (path === trashPath || isUnderPath(trashPath, path)))
          throw new ApiHttpError("bad_request", "Items in Trash cannot be referenced.");
        if (!known.has(path) && !added.includes(path)) added.push(path);
      }
      if (existing.length + added.length > limits.maxReferences)
        throw new ApiHttpError(
          "bad_request",
          `A chat can reference at most ${limits.maxReferences} items.`,
        );
      const attached = [...new Set((request.references ?? []).map((raw) => normalizePath(raw)))];
      const lines = await describeReferences(principal, attached);
      await deps.chats.addReferences(chat.id, added);

      const running = live.running(principal.identityId);
      if (running !== undefined) await stopTurn(running, "replaced");
      const target = live.get(chat.id);
      const owed = await declinePending(target, before, "Not applied: a newer message arrived.");

      if (before.length === 0)
        await deps.chats.rename(principal.identityId, chat.id, titleFrom(request.text));
      const location = request.location ?? null;
      await deps.chats.appendMessage(chat.id, {
        role: "user",
        parts: [{ kind: "text", text: request.text }],
        references: attached,
        location,
      });
      const reply = await deps.chats.appendMessage(chat.id, {
        role: "assistant",
        parts: [],
        references: [],
        location: null,
      });
      const text = formatUserMessage(request.text, lines, location);
      const conversation = await ensureLive(principal, chat, config, before);
      conversation.parts = [];
      startTurn(
        principal,
        conversation,
        reply.id,
        owed.length > 0 ? { kind: "tool_results", results: owed, text } : { kind: "user", text },
      );
      return present((await deps.chats.get(principal.identityId, chat.id)) ?? chat);
    },

    async cancel(principal, id) {
      const chat = await load(principal, id);
      const target = live.get(chat.id);
      if (target !== undefined) await stopTurn(target, "cancelled");
      return present(chat);
    },

    async act(principal, id, actionId, request) {
      const chat = await load(principal, id);
      const target = live.get(chat.id);
      if (target?.turn) throw new ApiHttpError("conflict", "Wait for the reply to finish.");
      const stored = await deps.chats.messages(chat.id);
      const last = stored.at(-1);
      const parts =
        last?.role === "assistant"
          ? last.parts.flatMap((part) => {
              const parsed = ChatPart.safeParse(part);
              return parsed.success ? [parsed.data] : [];
            })
          : [];
      const index = parts.findIndex((part) => part.kind === "action" && part.id === actionId);
      const card = parts[index];
      if (last === undefined || card === undefined || card.kind !== "action")
        throw new ApiHttpError("not_found", "That card does not exist.");
      if (card.state !== "pending")
        throw new ApiHttpError("conflict", "That card was already answered.");

      let updated: ChatPart;
      let toolResult: string;
      if (request.decision === "decline") {
        updated = { ...card, state: "declined", outcome: "Not applied." };
        toolResult = "The person did not apply this.";
      } else {
        await checkAuthority(principal).catch((error) => {
          throw new ApiHttpError("unauthorized", (error as Error).message);
        });
        const actions = target?.actions ?? (await buildTools(principal, chat)).actions;
        const tool = [...actions.values()].find(
          (candidate) =>
            candidate.spec.name ===
            (card.proposal.kind === "move"
              ? "move_items"
              : card.proposal.kind === "trash"
                ? "trash_items"
                : "write_text_file"),
        );
        if (tool === undefined)
          throw new ApiHttpError("conflict", "That action is no longer available for this login.");
        const outcome = await tool.apply(
          card.proposal,
          request.edits,
          AbortSignal.timeout(limits.turnDeadlineMs),
        );
        const failed = outcome.results.length > 0 && outcome.results.every((result) => !result.ok);
        updated = {
          ...card,
          state: failed ? "failed" : "applied",
          outcome: outcome.outcome,
          results: [...outcome.results],
        };
        toolResult = outcome.toolResult;
      }
      parts[index] = updated;
      await deps.chats.updateMessageParts(last.id, parts);

      if (target !== undefined) {
        const pending = target.pending.get(actionId);
        if (pending !== undefined) {
          target.pending.delete(actionId);
          target.held.push({ id: pending.callId, isError: false, content: toolResult });
          if (target.pending.size === 0) {
            const results = target.held;
            target.held = [];
            target.parts = parts;
            startTurn(principal, target, last.id, { kind: "tool_results", results });
          }
        }
      }
      return present(chat);
    },

    async settled(id) {
      await turns.get(id);
    },
  };
}
