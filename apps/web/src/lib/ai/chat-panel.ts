"use client";

import { useEffect, useSyncExternalStore } from "react";
import { create } from "zustand";

/**
 * The chat panel's browser preferences: whether it is open, how wide it
 * is and which chat it shows. Kept in localStorage under `fdrive.chat.*`
 * and read through `useSyncExternalStore`, so every mounted consumer and
 * every tab agree, and a reload reopens the same chat.
 */

export const CHAT_OPEN_KEY = "fdrive.chat.open";
export const CHAT_WIDTH_KEY = "fdrive.chat.width";
export const CHAT_CURRENT_KEY = "fdrive.chat.current";

export const DEFAULT_CHAT_WIDTH = 384;
export const MIN_CHAT_WIDTH = 300;
export const MAX_CHAT_WIDTH = 720;

const CHANGE_EVENT = "fdrive:chat-panel";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function readJson(storage: StorageLike, key: string): unknown {
  try {
    const raw = storage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeJson(storage: StorageLike, key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    // A full or blocked store only loses the convenience, not the chat.
  }
}

export function readChatOpen(storage: StorageLike): boolean {
  return readJson(storage, CHAT_OPEN_KEY) === true;
}

export function clampChatWidth(value: number): number {
  return Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, Math.round(value)));
}

export function readChatWidth(storage: StorageLike): number {
  const value = readJson(storage, CHAT_WIDTH_KEY);
  return typeof value === "number" && Number.isFinite(value)
    ? clampChatWidth(value)
    : DEFAULT_CHAT_WIDTH;
}

export function readCurrentChat(storage: StorageLike): string | null {
  const value = readJson(storage, CHAT_CURRENT_KEY);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}

function announce(): void {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useChatPanelOpen() {
  const open = useSyncExternalStore(
    subscribe,
    () => readChatOpen(window.localStorage),
    () => false,
  );
  return [open, setChatPanelOpen] as const;
}

/**
 * Opens or closes the panel for the person: the toolbar button, the shortcut,
 * the panel's own close button and "Add to chat" all come through here. Opening
 * also asks the message box to take focus, which a panel restored open on page
 * load never does.
 */
export function setChatPanelOpen(open: boolean): void {
  writeJson(window.localStorage, CHAT_OPEN_KEY, open);
  useChatPanelStore.setState({ focusPending: open });
  announce();
}

/** Cmd+Shift+K on Apple platforms, Ctrl+Shift+K elsewhere: next to search's Cmd+K. */
export function isChatShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey">,
): boolean {
  return event.key.toLowerCase() === "k" && event.shiftKey && (event.metaKey || event.ctrlKey);
}

/** Opens and closes the chat panel from the keyboard while `enabled`. */
export function useChatShortcut(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!isChatShortcut(event)) return;
      event.preventDefault();
      setChatPanelOpen(!readChatOpen(window.localStorage));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

export function useChatPanelWidth() {
  const width = useSyncExternalStore(
    subscribe,
    () => readChatWidth(window.localStorage),
    () => DEFAULT_CHAT_WIDTH,
  );
  return [width, setChatPanelWidth] as const;
}

export function setChatPanelWidth(width: number): void {
  writeJson(window.localStorage, CHAT_WIDTH_KEY, clampChatWidth(width));
  announce();
}

export function useCurrentChatId() {
  const id = useSyncExternalStore(
    subscribe,
    () => readCurrentChat(window.localStorage),
    () => null,
  );
  return [id, setCurrentChatId] as const;
}

export function setCurrentChatId(id: string | null): void {
  writeJson(window.localStorage, CHAT_CURRENT_KEY, id);
  announce();
}

/**
 * What the panel is about to attach: paths dropped on it or added from a
 * selection, waiting in the composer until the next message is sent. In
 * memory only, so a reload starts with an empty composer and takes no focus.
 */
export interface ChatPanelState {
  readonly chips: readonly string[];
  /** True from the person opening the panel until its message box has taken focus. */
  readonly focusPending: boolean;
  addChips(paths: readonly string[]): void;
  removeChip(path: string): void;
  clearChips(): void;
}

export const useChatPanelStore = create<ChatPanelState>((set) => ({
  chips: [],
  focusPending: false,
  addChips(paths) {
    set((state) => {
      const next = [...state.chips];
      for (const path of paths) if (!next.includes(path)) next.push(path);
      return next.length === state.chips.length ? state : { chips: next };
    });
  },
  removeChip(path) {
    set((state) => ({ chips: state.chips.filter((chip) => chip !== path) }));
  },
  clearChips() {
    set({ chips: [] });
  },
}));

/** Opens the panel with `paths` ready to attach: the selection bar's and context menu's "Add to chat". */
export function addToChat(paths: readonly string[]): void {
  useChatPanelStore.getState().addChips(paths);
  setChatPanelOpen(true);
}
