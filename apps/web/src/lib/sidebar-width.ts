"use client";

import { useSyncExternalStore } from "react";
import { readJson, type StorageLike, writeJson } from "@/lib/files/storage";

/**
 * How wide the desktop sidebar is, in pixels. A browser preference kept in
 * localStorage and read through `useSyncExternalStore`, so the sidebar and
 * its resize handle agree and other tabs follow.
 */

export const SIDEBAR_WIDTH_KEY = "fdrive.sidebar.width";

export const DEFAULT_SIDEBAR_WIDTH = 256;
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 480;

const CHANGE_EVENT = "fdrive:sidebar-width";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function clampSidebarWidth(value: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)));
}

export function readSidebarWidth(storage: StorageLike): number {
  return clampSidebarWidth(
    readJson(storage, SIDEBAR_WIDTH_KEY, isFiniteNumber, DEFAULT_SIDEBAR_WIDTH),
  );
}

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}

export function useSidebarWidth() {
  const width = useSyncExternalStore(
    subscribe,
    () => readSidebarWidth(window.localStorage),
    () => DEFAULT_SIDEBAR_WIDTH,
  );
  return [width, setSidebarWidth] as const;
}

export function setSidebarWidth(width: number): void {
  writeJson(window.localStorage, SIDEBAR_WIDTH_KEY, clampSidebarWidth(width));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
