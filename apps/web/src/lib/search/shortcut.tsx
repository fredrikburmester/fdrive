"use client";

import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useEffect,
  useState,
} from "react";

interface SearchShortcutState {
  readonly open: boolean;
  readonly setOpen: Dispatch<SetStateAction<boolean>>;
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
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isSearchShortcut(event)) return;
      event.preventDefault();
      setOpen((current) => !current);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <SearchShortcutContext.Provider value={{ open, setOpen }}>
      {children}
    </SearchShortcutContext.Provider>
  );
}

export function useSearchShortcut() {
  const state = useContext(SearchShortcutContext);
  if (!state) throw new Error("Search shortcuts require the shell provider.");
  return state;
}
