"use client";

import { SearchIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { SearchPanel } from "@/components/search/search-panel";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { pathFromFilesPathname } from "@/lib/files/path-url";
import {
  isPermanentSearchStatus,
  searchUnavailableHint,
  useSearchStatus,
} from "@/lib/search/queries";
import { useSearchShortcut } from "@/lib/search/shortcut";

/** Below `md`: no outline and a 44x44 tap target, without affecting the desktop button. */
const MOBILE_SEARCH =
  "max-md:size-11 max-md:border-transparent max-md:bg-transparent max-md:px-0 max-md:dark:border-transparent max-md:dark:bg-transparent";

/**
 * The button itself. Always enabled, even when the search index is not
 * configured: an earlier version disabled the button in that case, which
 * (via the `disabled` variant's `pointer-events-none`) made it fully
 * unclickable rather than informative, and worse on touch, where a disabled
 * element never gets a hover to reveal the explanatory tooltip at all. Now
 * the button always opens the panel, which already shows "Search is not
 * available" once a query against an unavailable index comes back empty.
 * The tooltip only appears for a known permanent scope failure, so a startup
 * outage does not look like an unconfigured server, and it names the login
 * when its folder is simply not indexed. Below `md` it is a borderless 44px
 * icon button, matching New and More beside it.
 */
function SearchTrigger({ onOpen }: { onOpen: () => void }) {
  const { data: status } = useSearchStatus();

  const button = (
    <Button
      variant="outline"
      size="sm"
      aria-label="Search"
      className={MOBILE_SEARCH}
      onClick={onOpen}
    >
      <SearchIcon className="size-3.5 max-md:size-[18px]" />
      <span className="hidden @min-[900px]/header:inline">Search</span>
      <KbdGroup className="hidden @min-[900px]/header:inline-flex">
        <Kbd>⌘K</Kbd>
      </KbdGroup>
    </Button>
  );

  if (!isPermanentSearchStatus(status)) {
    return button;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{searchUnavailableHint(status)}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The header's search entry point: a button showing the ⌘K shortcut (label
 * hidden while the page header is under 900px wide, icon always visible) and the search panel.
 *
 * Search looks through every file, so the button shows only while browsing
 * them, on `/files` and below: beside Trash or Shares it read as a search of
 * that page. The panel stays mounted on every page, so the shell's Cmd/Ctrl+K
 * listener and the sidebar's saved searches open it from anywhere.
 */
export function SearchButton() {
  const { open, setOpen, saved } = useSearchShortcut();
  const browsingFiles = pathFromFilesPathname(usePathname()) !== null;

  return (
    <>
      {browsingFiles && <SearchTrigger onOpen={() => setOpen(true)} />}
      <SearchPanel open={open} onOpenChange={setOpen} saved={saved} />
    </>
  );
}
