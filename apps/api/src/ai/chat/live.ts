import type { ChatActionProposal, ChatPart } from "@fdrive/contracts";
import type { AiConversation, AiToolResult } from "../model.ts";
import type { AiTool } from "../tools/tool.ts";
import type { ActionTool } from "./actions.ts";

/** A card the assistant is waiting on, with the tool call it answers. */
export interface PendingAction {
  readonly actionId: string;
  readonly callId: string;
  readonly tool: string;
  readonly proposal: ChatActionProposal;
}

export interface LiveTurn {
  readonly controller: AbortController;
  readonly messageId: string;
  /** Why the turn was aborted, set before `controller.abort()`. */
  abortReason?: "cancelled" | "replaced" | "timeout";
}

/**
 * One chat's in-process state: the provider conversation (with its native
 * history), the tools built for the chat's references, cards waiting for
 * the person, tool results held back until those cards are answered, and
 * the turn being written. Lost on restart; rebuilt from the transcript.
 */
export interface LiveChat {
  readonly chatId: string;
  readonly identityId: string;
  conversation: AiConversation;
  tools: ReadonlyMap<string, AiTool>;
  actions: ReadonlyMap<string, ActionTool>;
  readonly pending: Map<string, PendingAction>;
  held: AiToolResult[];
  /** The assistant message being written, and its parts so far. */
  parts: ChatPart[];
  messageId: string | null;
  turn: LiveTurn | null;
  touchedAt: number;
}

export interface LiveChatsOptions {
  readonly clock: () => Date;
  /** How long an untouched chat keeps its conversation in memory. Default 30 minutes. */
  readonly idleMs?: number;
}

export interface LiveChats {
  get(chatId: string): LiveChat | undefined;
  set(live: LiveChat): void;
  delete(chatId: string): void;
  /** The chat of `identityId` whose turn is running, if any. */
  running(identityId: string): LiveChat | undefined;
  /** Drops idle chats without a turn or pending cards; called before every use. */
  sweep(): void;
}

export function createLiveChats(options: LiveChatsOptions): LiveChats {
  const idleMs = options.idleMs ?? 30 * 60 * 1000;
  const chats = new Map<string, LiveChat>();
  return {
    get(chatId) {
      const live = chats.get(chatId);
      if (live !== undefined) live.touchedAt = options.clock().getTime();
      return live;
    },
    set(live) {
      live.touchedAt = options.clock().getTime();
      chats.set(live.chatId, live);
    },
    delete(chatId) {
      chats.delete(chatId);
    },
    running(identityId) {
      for (const live of chats.values())
        if (live.identityId === identityId && live.turn !== null) return live;
      return undefined;
    },
    sweep() {
      const now = options.clock().getTime();
      for (const [chatId, live] of chats)
        if (live.turn === null && live.pending.size === 0 && now - live.touchedAt > idleMs)
          chats.delete(chatId);
    },
  };
}
