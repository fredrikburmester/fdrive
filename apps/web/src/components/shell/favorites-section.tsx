"use client";

import { baseName, extensionOf, mimeFromExtension } from "@fdrive/core";
import { StarIcon, XIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { SIDEBAR_NOTE, SIDEBAR_ROW, SidebarSection } from "@/components/shell/sidebar-section";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { FileIcon, pathToHref, viewHref } from "@/lib/metadata/deps";
import { useFavorites, useToggleFavorite } from "@/lib/metadata/queries";
import { sidebarSectionState } from "@/lib/metadata/sidebar-sections";

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
  const state = sidebarSectionState(items);

  if (state === "loading") {
    return null;
  }

  return (
    <SidebarSection section="favorites" label="Favorites">
      {state === "empty" ? (
        <p className={SIDEBAR_NOTE}>Star a file to see it here</p>
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
                        className={SIDEBAR_ROW}
                        render={
                          <Link
                            href={toRoute(
                              item.kind === "dir" ? pathToHref(item.path) : viewHref(item.path),
                            )}
                          />
                        }
                      />
                    }
                  >
                    <FileIcon
                      kind={item.kind}
                      ext={ext}
                      mime={mimeFromExtension(ext)}
                      className="text-muted-foreground"
                    />
                    <span className="truncate">{baseName(item.path)}</span>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem
                      onClick={() => toggleFavorite.mutate({ path: item.path, favorite: false })}
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
    </SidebarSection>
  );
}

/** Re-exported so a page (`/favorites`) can show the same star icon as the
 * sidebar entry point, without importing lucide directly. */
export { StarIcon as FavoritesIcon };
