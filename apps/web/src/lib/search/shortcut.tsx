"use client";

import type { SavedSearch } from "@fdrive/contracts";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

interface SearchShortcutState {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  /** The saved search the panel was opened with, until it closes. */
  readonly saved: SavedSearch | null;
  readonly openSaved: (search: SavedSearch) => void;
}
const SearchShortcutContext = createContext<SearchShortcutState | undefined>(undefined);

/** Cmd+K on Apple platforms, Ctrl+K elsewhere; Shift+K next to it belongs to chat. */
export function isSearchShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey">,
): boolean {
  return event.key.toLowerCase() === "k" && !event.shiftKey && (event.metaKey || event.ctrlKey);
}

/** Global shortcuts hydrate above the shell runtime, whose children mount after hydration. */
export function SearchShortcutProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ open: boolean; saved: SavedSearch | null }>({
    open: false,
    saved: null,
  });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isSearchShortcut(event)) return;
      event.preventDefault();
      setState((current) => ({ open: !current.open, saved: null }));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <SearchShortcutContext.Provider
      value={{
        ...state,
        setOpen: (open) => setState({ open, saved: null }),
        openSaved: (saved) => setState({ open: true, saved }),
      }}
    >
      {children}
    </SearchShortcutContext.Provider>
  );
}

export function useSearchShortcut() {
  const state = useContext(SearchShortcutContext);
  if (!state) throw new Error("Search shortcuts require the shell provider.");
  return state;
}
