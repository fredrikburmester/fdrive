"use client";

import { SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { SearchPanel } from "@/components/search/search-panel";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSearchStatus } from "@/lib/search/queries";

/**
 * True when a keydown event is the "open search" shortcut: Cmd+K on Apple
 * platforms, Ctrl+K everywhere else. Exported so it is unit tested without
 * simulating a real DOM keyboard event.
 */
export function isSearchShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">,
): boolean {
  return event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey);
}

/**
 * The top-right search entry point: a button showing the ⌘K shortcut (label
 * hidden below 900px, icon always visible), a global Cmd/Ctrl+K listener
 * that opens the panel from anywhere in the shell, and the panel itself.
 * Disabled with a tooltip when the search index is not configured.
 */
export function SearchButton() {
  const [open, setOpen] = useState(false);
  const { data: status } = useSearchStatus();
  const disabled = status?.available === false;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isSearchShortcut(event)) {
        return;
      }
      event.preventDefault();
      setOpen((current) => !current);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const button = (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      aria-label="Search"
      onClick={() => setOpen(true)}
    >
      <SearchIcon />
      <span className="hidden min-[900px]:inline">Search</span>
      <KbdGroup className="hidden min-[900px]:inline-flex">
        <Kbd>⌘K</Kbd>
      </KbdGroup>
    </Button>
  );

  return (
    <>
      {disabled ? (
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipContent>Search index not configured</TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
      <SearchPanel open={open} onOpenChange={setOpen} />
    </>
  );
}
