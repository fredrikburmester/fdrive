import { describe, expect, it } from "vitest";
import type { AiConversation } from "../model.ts";
import { createLiveChats, type LiveChat } from "./live.ts";

function liveChat(chatId: string, identityId: string): LiveChat {
  return {
    chatId,
    identityId,
    conversation: {} as AiConversation,
    tools: new Map(),
    actions: new Map(),
    pending: new Map(),
    held: [],
    parts: [],
    messageId: null,
    turn: null,
    touchedAt: 0,
  };
}

describe("createLiveChats", () => {
  it("finds the identity's running chat and drops idle ones, keeping those with cards or a turn", () => {
    let now = 0;
    const live = createLiveChats({ clock: () => new Date(now), idleMs: 100 });
    const idle = liveChat("idle", "alice");
    const busy = liveChat("busy", "alice");
    const waiting = liveChat("waiting", "bob");
    live.set(idle);
    live.set(busy);
    live.set(waiting);
    busy.turn = { controller: new AbortController(), messageId: "m" };
    waiting.pending.set("a", {
      actionId: "a",
      callId: "c",
      tool: "trash_items",
      proposal: { kind: "trash", summary: "", items: [] },
    });

    expect(live.running("alice")).toBe(busy);
    expect(live.running("bob")).toBeUndefined();

    now = 50;
    live.get("idle");
    now = 140;
    live.sweep();
    expect(live.running("alice")).toBe(busy);
    now = 160;
    live.sweep();
    expect(live.get("idle")).toBeUndefined();
    expect(live.get("busy")).toBe(busy);
    expect(live.get("waiting")).toBe(waiting);

    live.delete("busy");
    expect(live.running("alice")).toBeUndefined();
  });
});
