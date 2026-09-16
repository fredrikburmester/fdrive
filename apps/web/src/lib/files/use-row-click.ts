"use client";

import { useSyncExternalStore } from "react";
import {
  DEFAULT_ROW_CLICK_ACTION,
  type RowClickAction,
  readRowClickAction,
  writeRowClickAction,
} from "./row-click";

const CHANGE_EVENT = "fdrive:row-click";

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}

function snapshot(): RowClickAction {
  return readRowClickAction(window.localStorage);
}

/** The browser's row-click preference, shared by mounted listings, the account page and other tabs. */
export function useRowClickAction() {
  const action = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_ROW_CLICK_ACTION);
  return [action, setRowClickAction] as const;
}

export function setRowClickAction(action: RowClickAction) {
  writeRowClickAction(window.localStorage, action);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
