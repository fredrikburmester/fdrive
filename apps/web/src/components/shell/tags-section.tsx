"use client";

import { SettingsIcon, TagIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useState } from "react";
import { SIDEBAR_NOTE, SIDEBAR_ROW, SidebarSection } from "@/components/shell/sidebar-section";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { tagDotClassName } from "@/lib/metadata/colors";
import { useTags } from "@/lib/metadata/queries";
import { sidebarSectionState } from "@/lib/metadata/sidebar-sections";
import { cn } from "@/lib/utils";
import { TagManagerDialog } from "../metadata/tag-manager-dialog";

function tagRoute(id: string): Route {
  return `/tags/${id}` as Route;
}

/** The sidebar's "Tags" section: every tag with its color dot, linking to
 * `/tags/<id>`, plus "Manage tags" opening the `TagManagerDialog`. Always
 * renders once loaded, even with no tags yet, so tags can be created
 * before anything is tagged; a muted placeholder line replaces the tag
 * list while it is empty. */
export function TagsSection() {
  const { data: tags } = useTags();
  const [managerOpen, setManagerOpen] = useState(false);
  const state = sidebarSectionState(tags);

  if (state === "loading") {
    return null;
  }

  return (
    <>
      <SidebarSection section="tags" label="Tags">
        {state === "empty" ? <p className={SIDEBAR_NOTE}>No tags yet</p> : null}
        <SidebarMenu>
          {(tags ?? []).map((tag) => (
            <SidebarMenuItem key={tag.id}>
              <SidebarMenuButton className={SIDEBAR_ROW} render={<Link href={tagRoute(tag.id)} />}>
                <span
                  className={cn(
                    "mr-1 ml-0.5 size-2.5 shrink-0 rounded-full",
                    tagDotClassName(tag.color),
                  )}
                />
                <span className="truncate">{tag.name}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => setManagerOpen(true)}
              className={cn(SIDEBAR_ROW, "text-sidebar-foreground/60")}
            >
              <SettingsIcon />
              <span>Manage tags</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarSection>
      <TagManagerDialog open={managerOpen} onOpenChange={setManagerOpen} />
    </>
  );
}

export { TagIcon as TagsIcon };
