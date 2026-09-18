// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  addToChat,
  CHAT_CURRENT_KEY,
  CHAT_OPEN_KEY,
  CHAT_WIDTH_KEY,
  clampChatWidth,
  DEFAULT_CHAT_WIDTH,
  MAX_CHAT_WIDTH,
  MIN_CHAT_WIDTH,
  readChatOpen,
  readChatWidth,
  readCurrentChat,
  setChatPanelOpen,
  setCurrentChatId,
  useChatPanelOpen,
  useChatPanelStore,
  useChatPanelWidth,
  useCurrentChatId,
} from "./chat-panel";

afterEach(() => {
  cleanup();
  localStorage.clear();
  useChatPanelStore.getState().clearChips();
});

describe("preferences", () => {
  it("reads stored values, tolerating corrupt or blocked storage", () => {
    localStorage.setItem(CHAT_OPEN_KEY, "true");
    localStorage.setItem(CHAT_WIDTH_KEY, "9999");
    localStorage.setItem(CHAT_CURRENT_KEY, '"chat-1"');
    expect(readChatOpen(localStorage)).toBe(true);
    expect(readChatWidth(localStorage)).toBe(MAX_CHAT_WIDTH);
    expect(readCurrentChat(localStorage)).toBe("chat-1");
    localStorage.setItem(CHAT_OPEN_KEY, "{bad");
    localStorage.setItem(CHAT_WIDTH_KEY, '"wide"');
    localStorage.setItem(CHAT_CURRENT_KEY, '""');
    expect(readChatOpen(localStorage)).toBe(false);
    expect(readChatWidth(localStorage)).toBe(DEFAULT_CHAT_WIDTH);
    expect(readCurrentChat(localStorage)).toBeNull();
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    expect(readChatOpen(blocked)).toBe(false);
    expect(clampChatWidth(10)).toBe(MIN_CHAT_WIDTH);
    expect(clampChatWidth(400.6)).toBe(401);
  });

  it("updates every mounted consumer and other tabs together", () => {
    const open = renderHook(useChatPanelOpen);
    const width = renderHook(useChatPanelWidth);
    const current = renderHook(useCurrentChatId);
    expect(open.result.current[0]).toBe(false);
    expect(width.result.current[0]).toBe(DEFAULT_CHAT_WIDTH);
    expect(current.result.current[0]).toBeNull();

    act(() => {
      open.result.current[1](true);
      width.result.current[1](500);
      current.result.current[1]("chat-2");
    });
    expect(open.result.current[0]).toBe(true);
    expect(width.result.current[0]).toBe(500);
    expect(current.result.current[0]).toBe("chat-2");
    expect(localStorage.getItem(CHAT_WIDTH_KEY)).toBe("500");

    act(() => {
      localStorage.setItem(CHAT_OPEN_KEY, "false");
      window.dispatchEvent(new StorageEvent("storage", { key: CHAT_OPEN_KEY }));
    });
    expect(open.result.current[0]).toBe(false);
    act(() => setCurrentChatId(null));
    expect(current.result.current[0]).toBeNull();
    expect(localStorage.getItem(CHAT_CURRENT_KEY)).toBeNull();
  });

  it("survives a storage that refuses writes", () => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota");
    };
    try {
      expect(() => setChatPanelOpen(true)).not.toThrow();
    } finally {
      Storage.prototype.setItem = setItem;
    }
  });

  it("renders the defaults on the server", async () => {
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");
    function Probe() {
      const [open] = useChatPanelOpen();
      const [width] = useChatPanelWidth();
      const [id] = useCurrentChatId();
      return createElement("span", null, `${open}-${width}-${id}`);
    }
    expect(renderToString(createElement(Probe))).toBe(
      `<span>false-${DEFAULT_CHAT_WIDTH}-null</span>`,
    );
  });
});

describe("chips", () => {
  it("keeps paths to attach without duplicates, and addToChat opens the panel", () => {
    const store = useChatPanelStore.getState();
    store.addChips(["/a", "/b"]);
    store.addChips(["/b", "/c"]);
    expect(useChatPanelStore.getState().chips).toEqual(["/a", "/b", "/c"]);
    const before = useChatPanelStore.getState();
    before.addChips(["/a"]);
    expect(useChatPanelStore.getState().chips).toBe(before.chips);
    store.removeChip("/b");
    expect(useChatPanelStore.getState().chips).toEqual(["/a", "/c"]);
    store.clearChips();
    expect(useChatPanelStore.getState().chips).toEqual([]);

    addToChat(["/x"]);
    expect(useChatPanelStore.getState().chips).toEqual(["/x"]);
    expect(readChatOpen(localStorage)).toBe(true);
  });
});
