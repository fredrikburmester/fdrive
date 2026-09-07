"use client";

import { SearchIcon } from "lucide-react";
import { SearchPanel } from "@/components/search/search-panel";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMe } from "@/lib/api/auth-queries";
import { useSearchStatus } from "@/lib/search/queries";
import { useSearchShortcut } from "@/lib/search/shortcut";

/**
 * The top-right search entry point: a button showing the ⌘K shortcut (label
 * hidden below 900px, icon always visible), a global Cmd/Ctrl+K listener
 * that opens the panel from anywhere in the shell, and the panel itself.
 *
 * Always enabled, even when the search index is not configured: an earlier
 * version disabled the button in that case, which (via the `disabled`
 * variant's `pointer-events-none`) made it fully unclickable rather than
 * informative, and worse on touch, where a disabled element never gets a
 * hover to reveal the explanatory tooltip at all. Now the button always
 * opens the panel, which already shows "Search is not available" once a
 * query against an unavailable index comes back empty; a tooltip on hover
 * additionally explains the state up front on pointer devices. Below `md`
 * the button keeps its regular size on every viewport.
 */
export function SearchButton() {
  const { open, setOpen } = useSearchShortcut();
  const { data: status } = useSearchStatus();
  const { data: me } = useMe();
  const indexUnavailable = status?.available === false && (me?.identities.length ?? 0) < 2;

  const button = (
    <Button variant="outline" size="sm" aria-label="Search" onClick={() => setOpen(true)}>
      <SearchIcon />
      <span className="hidden min-[900px]:inline">Search</span>
      <KbdGroup className="hidden min-[900px]:inline-flex">
        <Kbd>⌘K</Kbd>
      </KbdGroup>
    </Button>
  );

  return (
    <>
      {indexUnavailable ? (
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
