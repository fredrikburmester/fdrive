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
 * Disabled with a tooltip when the search index is not configured.
 */
export function SearchButton() {
  const { open, setOpen } = useSearchShortcut();
  const { data: status } = useSearchStatus();
  const { data: me } = useMe();
  const disabled = status?.available === false && (me?.identities.length ?? 0) < 2;

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
