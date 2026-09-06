"use client";

import { ChevronRightIcon, SettingsIcon, TagIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { tagDotClassName } from "@/lib/metadata/colors";
import { useTags } from "@/lib/metadata/queries";
import { readSidebarSectionOpen, writeSidebarSectionOpen } from "@/lib/metadata/sidebar-sections";
import { cn } from "@/lib/utils";
import { TagManagerDialog } from "../metadata/tag-manager-dialog";

function tagRoute(id: string): Route {
  return `/tags/${id}` as Route;
}

/** The sidebar's "Tags" section: every tag with its color dot, linking to
 * `/tags/<id>`, plus "Manage tags…" opening the `TagManagerDialog`.
 * Renders nothing while the account has no tags. */
export function TagsSection() {
  const { data: tags } = useTags();
  const [open, setOpen] = useState(true);
  const [managerOpen, setManagerOpen] = useState(false);

  useEffect(() => {
    setOpen(readSidebarSectionOpen(window.localStorage, "tags"));
  }, []);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    writeSidebarSectionOpen(window.localStorage, "tags", next);
  }

  if (tags === undefined || tags.length === 0) {
    return null;
  }

  return (
    <>
      <SidebarGroup>
        <Collapsible open={open} onOpenChange={handleOpenChange}>
          <CollapsibleTrigger
            nativeButton={false}
            render={<SidebarGroupLabel className="cursor-pointer select-none" />}
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", open && "rotate-90")}
            />
            Tags
          </CollapsibleTrigger>
          <CollapsibleContent>
            <SidebarGroupContent>
              <SidebarMenu>
                {tags.map((tag) => (
                  <SidebarMenuItem key={tag.id}>
                    <SidebarMenuButton render={<Link href={tagRoute(tag.id)} />}>
                      <span
                        className={cn("size-2.5 shrink-0 rounded-full", tagDotClassName(tag.color))}
                      />
                      <span className="truncate">{tag.name}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => setManagerOpen(true)}
                    className="text-muted-foreground"
                  >
                    <SettingsIcon />
                    <span>Manage tags…</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </CollapsibleContent>
        </Collapsible>
      </SidebarGroup>
      <TagManagerDialog open={managerOpen} onOpenChange={setManagerOpen} />
    </>
  );
}

export { TagIcon as TagsIcon };
