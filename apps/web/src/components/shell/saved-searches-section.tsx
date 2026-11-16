"use client";

import { SearchIcon, XIcon } from "lucide-react";
import { SIDEBAR_NOTE, SIDEBAR_ROW, SidebarSection } from "@/components/shell/sidebar-section";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { sidebarSectionState } from "@/lib/metadata/sidebar-sections";
import { useSavedSearches, useSavedSearchMutations } from "@/lib/search/saved-searches";
import { useSearchShortcut } from "@/lib/search/shortcut";

/** The sidebar's "Saved searches" section: each opens the search panel on its
 * query and filters, and its context menu removes it. Like Tags, it always
 * renders once loaded, with a muted placeholder line while empty. */
export function SavedSearchesSection() {
  const { data: searches } = useSavedSearches();
  const { remove } = useSavedSearchMutations();
  const { openSaved } = useSearchShortcut();
  const state = sidebarSectionState(searches);

  if (state === "loading") {
    return null;
  }

  return (
    <SidebarSection section="savedSearches" label="Saved searches">
      {state === "empty" ? (
        <p className={SIDEBAR_NOTE}>Save a search to see it here</p>
      ) : (
        <SidebarMenu>
          {(searches ?? []).map((search) => (
            <SidebarMenuItem key={search.id}>
              <ContextMenu>
                <ContextMenuTrigger
                  render={
                    <SidebarMenuButton className={SIDEBAR_ROW} onClick={() => openSaved(search)} />
                  }
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
    </SidebarSection>
  );
}
