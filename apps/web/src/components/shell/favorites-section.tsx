"use client";

import { baseName, extensionOf, mimeFromExtension } from "@fdrive/core";
import { ChevronRightIcon, StarIcon, XIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
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
import { FileIcon, pathToHref, viewHref } from "@/lib/metadata/deps";
import { useFavorites, useToggleFavorite } from "@/lib/metadata/queries";
import {
  readSidebarSectionOpen,
  sidebarSectionState,
  writeSidebarSectionOpen,
} from "@/lib/metadata/sidebar-sections";
import { cn } from "@/lib/utils";

function toRoute(href: string): Route {
  return href as Route;
}

/** The sidebar's "Favorites" section: every favorite as a link, a folder
 * navigating there, a file opening its preview. Collapsed state persists in
 * localStorage. Always renders once loaded, even with nothing starred yet,
 * showing a muted placeholder line instead of disappearing. */
export function FavoritesSection() {
  const { data: items } = useFavorites();
  const toggleFavorite = useToggleFavorite();
  const [open, setOpen] = useState(true);
  const state = sidebarSectionState(items);

  useEffect(() => {
    setOpen(readSidebarSectionOpen(window.localStorage, "favorites"));
  }, []);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    writeSidebarSectionOpen(window.localStorage, "favorites", next);
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
          Favorites
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarGroupContent>
            {state === "empty" ? (
              <p className="px-2 py-1 text-muted-foreground text-xs">Star a file to see it here</p>
            ) : (
              <SidebarMenu>
                {(items ?? []).map((item) => {
                  const ext = extensionOf(item.path);
                  return (
                    <SidebarMenuItem key={item.path}>
                      <ContextMenu>
                        <ContextMenuTrigger
                          render={
                            <SidebarMenuButton
                              render={
                                <Link
                                  href={toRoute(
                                    item.kind === "dir"
                                      ? pathToHref(item.path)
                                      : viewHref(item.path),
                                  )}
                                />
                              }
                            />
                          }
                        >
                          <FileIcon kind={item.kind} ext={ext} mime={mimeFromExtension(ext)} />
                          <span className="truncate">{baseName(item.path)}</span>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem
                            onClick={() =>
                              toggleFavorite.mutate({ path: item.path, favorite: false })
                            }
                          >
                            <XIcon />
                            Remove
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  );
}

/** Re-exported so a page (`/favorites`) can show the same star icon as the
 * sidebar entry point, without importing lucide directly. */
export { StarIcon as FavoritesIcon };
