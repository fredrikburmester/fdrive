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
import { accountTransition } from "@/lib/account/transition";

interface SearchShortcutState {
  readonly open: boolean;
  readonly setOpen: Dispatch<SetStateAction<boolean>>;
}
const SearchShortcutContext = createContext<SearchShortcutState | undefined>(undefined);

/** Cmd+K on Apple platforms, Ctrl+K elsewhere. */
export function isSearchShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">,
): boolean {
  return event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey);
}

/** Global shortcuts hydrate above Activity, whose visible children hydrate later. */
export function SearchShortcutProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isSearchShortcut(event) || accountTransition.getSnapshot().pending) return;
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
