"use client";

import { ChevronRightIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  readSidebarSectionOpen,
  sidebarSectionState,
  writeSidebarSectionOpen,
} from "@/lib/metadata/sidebar-sections";
import { useSavedSearches, useSavedSearchMutations } from "@/lib/search/saved-searches";
import { useSearchShortcut } from "@/lib/search/shortcut";
import { cn } from "@/lib/utils";

/** The sidebar's "Saved searches" section: each opens the search panel on its
 * query and filters, and its context menu removes it. Like Tags, it always
 * renders once loaded, with a muted placeholder line while empty. */
export function SavedSearchesSection() {
  const { data: searches } = useSavedSearches();
  const { remove } = useSavedSearchMutations();
  const { openSaved } = useSearchShortcut();
  const [open, setOpen] = useState(true);
  const state = sidebarSectionState(searches);

  useEffect(() => {
    setOpen(readSidebarSectionOpen(window.localStorage, "savedSearches"));
  }, []);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    writeSidebarSectionOpen(window.localStorage, "savedSearches", next);
  }

  if (state === "loading") {
    return null;
  }

  return (
    <SidebarGroup>
      <Collapsible open={open} onOpenChange={handleOpenChange}>
        <CollapsibleTrigger
          nativeButton={false}
          render={<SidebarGroupLabel className="cursor-pointer select-none" />}
        >
          <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          Saved searches
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarGroupContent>
            {state === "empty" ? (
              <p className="px-2 py-1 text-muted-foreground text-xs">
                Save a search to see it here
              </p>
            ) : (
              <SidebarMenu>
                {(searches ?? []).map((search) => (
                  <SidebarMenuItem key={search.id}>
                    <ContextMenu>
                      <ContextMenuTrigger
                        render={<SidebarMenuButton onClick={() => openSaved(search)} />}
                      >
                        <SearchIcon />
                        <span className="truncate">{search.name}</span>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem onClick={() => remove.mutate(search.id)}>
                          <XIcon />
                          Remove
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  );
}
