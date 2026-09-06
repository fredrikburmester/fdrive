"use client";

import { baseName } from "@fdrive/core";
import { ChevronRightIcon, ClockIcon } from "lucide-react";
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
import { viewHref } from "@/lib/metadata/deps";
import { useRecents } from "@/lib/metadata/queries";
import { readSidebarSectionOpen, writeSidebarSectionOpen } from "@/lib/metadata/sidebar-sections";
import { cn } from "@/lib/utils";

const MAX_VISIBLE = 8;
const RECENTS_ROUTE = "/recents" as Route;

function toRoute(href: string): Route {
  return href as Route;
}

/** The sidebar's "Recents" section: the last 8 opened files, each opening
 * its preview, plus a "Show all" link to `/recents`. Renders nothing while
 * there are no recents. */
export function RecentsSection() {
  const { data: items } = useRecents();
  const [open, setOpen] = useState(true);

  useEffect(() => {
    setOpen(readSidebarSectionOpen(window.localStorage, "recents"));
  }, []);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    writeSidebarSectionOpen(window.localStorage, "recents", next);
  }

  if (items === undefined || items.length === 0) {
    return null;
  }

  const visible = items.slice(0, MAX_VISIBLE);

  return (
    <SidebarGroup>
      <Collapsible open={open} onOpenChange={handleOpenChange}>
        <CollapsibleTrigger
          nativeButton={false}
          render={<SidebarGroupLabel className="cursor-pointer select-none" />}
        >
          <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          Recents
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu>
              {visible.map((item) => (
                <SidebarMenuItem key={item.path}>
                  <SidebarMenuButton render={<Link href={toRoute(viewHref(item.path))} />}>
                    <ClockIcon />
                    <span className="truncate">{baseName(item.path)}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href={RECENTS_ROUTE} />}
                  className="text-muted-foreground"
                >
                  <span>Show all</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  );
}
